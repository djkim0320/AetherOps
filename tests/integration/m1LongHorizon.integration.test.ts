import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { STANDARD_CONTEXT_PROVIDER_CAPABILITY_RECEIPT, type ContextPack, type ContextProviderIdentity } from "../../src/core/context/public.js";
import { ResearchPlanner } from "../../src/core/planning/researchPlanner.js";
import type { LlmJsonRequest, LlmProvider } from "../../src/core/providers/llm.js";
import type { AppSettings, ResearchSnapshot } from "../../src/core/shared/types.js";
import { CanonicalRunRuntime } from "../../src/server/composition/canonicalRunRuntime.js";
import type { CanonicalRunGateway } from "../../src/server/composition/canonicalRunTypes.js";
import { DurableCanonicalRunGateway } from "../../src/server/composition/durableCanonicalRunGateway.js";
import { DurableCanonicalResearchSession } from "../../src/server/composition/durableCanonicalResearchSession.js";
import type { DurableJobRecord } from "../../src/server/composition/durableJobTypes.js";
import { handleRpcV2, RpcV2Error } from "../../src/server/http/v2/rpcRouter.js";
import { storageCanonicalHasher } from "../../src/server/runtime/storage/v2/runStatePayloadValidator.js";
import {
  M1_CAPABILITIES,
  M1_PROJECT_ID,
  M1_PROVIDER_SECRET,
  M1_TOOL_POLICY,
  M1_TRANSCRIPT_SENTINEL,
  attemptOptimisticConflict,
  canonicalRuntime,
  cleanupM1LongHorizonFixtures,
  createM1Fixture,
  createM1Runtime,
  interruptM1Run,
  m1PlannerInput,
  m1RpcContext,
  m1Snapshot,
  m1Specification,
  releaseM1Runtime,
  setM1CodexModel,
  type M1ResumeBlocker
} from "./m1LongHorizon.fixture.js";

afterEach(cleanupM1LongHorizonFixtures);

describe("M1 long-horizon durable resume", () => {
  it("reconstructs receipt-bound provider input after transcript removal, process restart, and provider metadata swap", async () => {
    const fixture = createM1Fixture("restart-provider-swap");
    await setM1CodexModel(fixture, "gpt-5.6-sol");
    const source = await interruptM1Run(fixture, "none");
    expect(readJobStatus(fixture.databasePath, source.jobId)).toBe("interrupted");

    await setM1CodexModel(fixture, "gpt-5.6-terra");
    const runtime = createM1Runtime(fixture, "m1-resume-provider-swap");
    const canonical = canonicalRuntime(runtime);
    const resumed = deferred<{ first: ContextPack; replay: ContextPack; optimisticError: unknown }>();
    runtime.registerHandler("research_loop", async (job, request) => {
      try {
        if ((request as { action?: unknown } | undefined)?.action !== "resume") throw new Error("M1 resume handler received a non-resume request.");
        const snapshot = m1Snapshot(false);
        const session = await DurableCanonicalResearchSession.create(
          { jobs: runtime, settingsStore: fixture.settings, runtime: canonical.runtime, hasher: storageCanonicalHasher },
          job
        );
        await session.prepare(snapshot, m1Specification());
        const checkpoint = job.resumeCheckpointId ? await runtime.getCheckpoint(job.resumeCheckpointId) : undefined;
        if (!checkpoint) throw new Error("M1 resume checkpoint was not read back after restart.");
        await runtime.commitCanonicalRevisionPlan(session.owner, () => session.prepareResumeRevision(checkpoint));
        const provider = m1Provider("codex-oauth", "gpt-5.6-terra");
        const first = await session.compilePlannerContext(m1PlannerInput(snapshot, provider));
        const replay = await session.compilePlannerContext(m1PlannerInput(snapshot, provider));
        const optimisticError = await attemptOptimisticConflict(runtime, session.owner);
        await runtime.settle(job.id, "blocked", job.projectRevision, "M1 verification stops without claiming product completion.");
        resumed.resolve({ first, replay, optimisticError });
      } catch (error) {
        resumed.reject(error);
        throw error;
      }
    });
    await runtime.initialize();
    const response = await handleRpcV2(
      resumeRequest(source.jobId, source.checkpointId, "m1-resume-provider-swap"),
      m1RpcContext(fixture, runtime, m1Snapshot(false))
    );
    const receipt = response.result as { jobId: string };
    const result = await withTimeout(resumed.promise, "M1 resumed ContextPack");
    await waitForStatus(runtime, receipt.jobId, "blocked");
    await runtime.close();
    releaseM1Runtime(runtime);

    expect(source.pack.provider).toEqual(m1Provider("codex-oauth", "gpt-5.6-sol"));
    expect(result.first.provider).toEqual(m1Provider("codex-oauth", "gpt-5.6-terra"));
    expect(result.replay).toEqual(result.first);
    expect(result.first.canonicalHash).not.toBe(source.pack.canonicalHash);
    expect(result.first.task).toEqual(source.pack.task);
    expect(result.first.providerInput).toContain("Resume a durable provider-neutral research run from receipts only.");
    expect(source.pack.providerInput).not.toContain(M1_PROVIDER_SECRET);
    expect(result.first.providerInput).not.toContain(M1_PROVIDER_SECRET);
    expect(source.pack.providerInput).toMatch(/\[REDACTED(?::[^\]]+)?\]/);
    expect(result.optimisticError).toMatchObject({ code: "REVISION_CONFLICT" });

    const readback = contextReceiptReadback(fixture.databasePath);
    expect(readback.integrity).toBe("ok");
    expect(readback.rows).toHaveLength(2);
    expect(readback.rows.map((row) => row.id).sort()).toEqual([source.pack.id, result.first.id].sort());
    expect(readback.rows.map((row) => row.data.provider.modelId).sort()).toEqual(["gpt-5.6-sol", "gpt-5.6-terra"].sort());
    expect(readback.rows.every((row) => row.data.contentStored === false)).toBe(true);
    expect(JSON.stringify(readback.rows)).not.toContain("providerInput");
    const databaseBytes = readFileSync(fixture.databasePath);
    expect(databaseBytes.includes(Buffer.from(M1_TRANSCRIPT_SENTINEL))).toBe(false);
    expect(databaseBytes.includes(Buffer.from(M1_PROVIDER_SECRET))).toBe(false);
  });

  it("replays one durable ContextPack after the worker commits but its response is lost", async () => {
    const fixture = createM1Fixture("context-response-loss");
    await setM1CodexModel(fixture, "gpt-5.6-sol");
    const runtime = createM1Runtime(fixture, "m1-context-response-loss");
    const persistedGateway = new DurableCanonicalRunGateway(runtime);
    let loseFirstResponse = true;
    const responseLossGateway: CanonicalRunGateway = {
      saveTaskContract: (owner, contract) => persistedGateway.saveTaskContract(owner, contract),
      getTaskContract: (projectId, taskContractId) => persistedGateway.getTaskContract(projectId, taskContractId),
      latestRunState: (owner) => persistedGateway.latestRunState(owner),
      commitRunState: (owner, expectedRevision, revision) => persistedGateway.commitRunState(owner, expectedRevision, revision),
      saveContextPack: async (owner, expectedRevision, pack) => {
        const readback = await persistedGateway.saveContextPack(owner, expectedRevision, pack);
        if (loseFirstResponse) {
          loseFirstResponse = false;
          throw new Error("Injected ContextPack response loss after durable worker commit.");
        }
        return readback;
      }
    };
    const canonical = new CanonicalRunRuntime({ gateway: responseLossGateway, hasher: storageCanonicalHasher });
    const observed = deferred<{ pack: ContextPack; firstError: Error }>();
    runtime.registerHandler("research_loop", async (job) => {
      try {
        const snapshot = m1Snapshot(true);
        const session = await DurableCanonicalResearchSession.create(
          { jobs: runtime, settingsStore: fixture.settings, runtime: canonical, hasher: storageCanonicalHasher },
          job
        );
        await session.prepare(snapshot, m1Specification());
        const plannerInput = m1PlannerInput(snapshot, m1Provider("codex-oauth", "gpt-5.6-sol"));
        const firstError = await session.compilePlannerContext(plannerInput).then(
          () => new Error("The injected post-commit response loss did not occur."),
          (error: unknown) => (error instanceof Error ? error : new Error(String(error)))
        );
        const pack = await session.compilePlannerContext(plannerInput);
        await runtime.settle(job.id, "blocked", job.projectRevision, "M1 response-loss verification completed without product completion.");
        observed.resolve({ pack, firstError });
      } catch (error) {
        observed.reject(error);
        throw error;
      }
    });
    await runtime.initialize();
    const response = await handleRpcV2(
      {
        requestId: "request-m1-context-response-loss",
        method: "loop.start",
        params: {
          projectId: M1_PROJECT_ID,
          idempotencyKey: "m1-context-response-loss",
          requestedCapabilities: M1_CAPABILITIES,
          toolPolicy: M1_TOOL_POLICY
        }
      },
      m1RpcContext(fixture, runtime, m1Snapshot(true))
    );
    const receipt = response.result as { jobId: string };
    const result = await withTimeout(observed.promise, "M1 ContextPack response-loss replay");
    await waitForStatus(runtime, receipt.jobId, "blocked");
    await runtime.close();
    releaseM1Runtime(runtime);

    expect(result.firstError.message).toContain("response loss after durable worker commit");
    const readback = contextReceiptReadback(fixture.databasePath);
    expect(readback.integrity).toBe("ok");
    expect(readback.rows).toHaveLength(1);
    expect(readback.rows[0]?.id).toBe(result.pack.id);
    expect(readback.rows[0]?.data.contentStored).toBe(false);
  });

  it("leaves no partial ContextPack when compilation crashes and retries from the same durable state", async () => {
    const fixture = createM1Fixture("context-compilation-crash");
    await setM1CodexModel(fixture, "gpt-5.6-sol");
    const runtime = createM1Runtime(fixture, "m1-context-compilation-crash");
    const canonical = canonicalRuntime(runtime);
    const observed = deferred<{ pack: ContextPack; error: Error; rowsBeforeRetry: number }>();
    runtime.registerHandler("research_loop", async (job) => {
      try {
        const snapshot = m1Snapshot(true);
        const session = await DurableCanonicalResearchSession.create(
          { jobs: runtime, settingsStore: fixture.settings, runtime: canonical.runtime, hasher: storageCanonicalHasher },
          job
        );
        await session.prepare(snapshot, m1Specification());
        const input = m1PlannerInput(snapshot, m1Provider("codex-oauth", "gpt-5.6-sol"));
        const faultingTool = { ...input.tools[0]! };
        Object.defineProperty(faultingTool, "summary", {
          enumerable: true,
          get: () => {
            throw new Error("Injected context compilation crash before persistence.");
          }
        });
        const error = await session.compilePlannerContext({ ...input, tools: [faultingTool] }).then(
          () => new Error("Injected context compilation crash did not occur."),
          (caught: unknown) => (caught instanceof Error ? caught : new Error(String(caught)))
        );
        const rowsBeforeRetry = contextPackCount(fixture.databasePath);
        const pack = await session.compilePlannerContext(input);
        await runtime.settle(job.id, "blocked", job.projectRevision, "M1 compile-crash retry verified without claiming product completion.");
        observed.resolve({ pack, error, rowsBeforeRetry });
      } catch (error) {
        observed.reject(error);
        throw error;
      }
    });
    await runtime.initialize();
    const response = await handleRpcV2(
      {
        requestId: "request-m1-context-compilation-crash",
        method: "loop.start",
        params: {
          projectId: M1_PROJECT_ID,
          idempotencyKey: "m1-context-compilation-crash",
          requestedCapabilities: M1_CAPABILITIES,
          toolPolicy: M1_TOOL_POLICY
        }
      },
      m1RpcContext(fixture, runtime, m1Snapshot(true))
    );
    const result = await withTimeout(observed.promise, "M1 ContextPack compile-crash retry");
    await waitForStatus(runtime, (response.result as { jobId: string }).jobId, "blocked");
    await runtime.close();
    releaseM1Runtime(runtime);

    expect(result.error.message).toContain("compilation crash before persistence");
    expect(result.rowsBeforeRetry).toBe(0);
    expect(contextPackCount(fixture.databasePath)).toBe(1);
    expect(contextReceiptReadback(fixture.databasePath).rows[0]?.id).toBe(result.pack.id);
  });

  it("resumes from the checkpoint-bound ContextPack instead of a later unbound pack", async () => {
    const fixture = createM1Fixture("checkpoint-context-binding");
    await setM1CodexModel(fixture, "gpt-5.6-sol");
    const source = await interruptM1Run(fixture, "none", undefined, m1Provider("codex-oauth", "gpt-5.6-sol"), "stale-memory");
    expect(source.lateUnboundPack?.id).toBeTruthy();
    expect(source.lateUnboundPack?.id).not.toBe(source.pack.id);
    expect(readCheckpointContextPackId(fixture.databasePath, source.checkpointId)).toBe(source.pack.id);

    const runtime = createM1Runtime(fixture, "m1-checkpoint-context-binding-resume");
    const handlerReached = deferred<void>();
    runtime.registerHandler("research_loop", async (job) => {
      try {
        await runtime.settle(job.id, "blocked", job.projectRevision, "Exact ContextPack binding was verified without claiming product completion.");
        handlerReached.resolve();
      } catch (error) {
        handlerReached.reject(error);
        throw error;
      }
    });
    await runtime.initialize();
    const response = await handleRpcV2(
      resumeRequest(source.jobId, source.checkpointId, "m1-checkpoint-context-binding-resume"),
      m1RpcContext(fixture, runtime, m1Snapshot(false))
    );
    await withTimeout(handlerReached.promise, "checkpoint-bound ContextPack resume");
    await waitForStatus(runtime, (response.result as { jobId: string }).jobId, "blocked");
    await runtime.close();
    releaseM1Runtime(runtime);
  });

  it("rebuilds planner input after restart and executes a different provider adapter without native conversation state", async () => {
    const fixture = createM1Fixture("provider-adapter-swap");
    await setM1CodexModel(fixture, "gpt-5.6-sol");
    const adapterA = new M1PlannerAdapter("provider-adapter-a", "adapter-a-model", "NATIVE_PROVIDER_SESSION_A");
    const settings = await fixture.settings.getSettings();
    const identityA = await adapterA.contextIdentity();
    const source = await interruptM1Run(
      fixture,
      "none",
      async (pack, snapshot) => {
        const plan = await runM1Planner(adapterA, settings, snapshot, async (input) => {
          expect(input.provider).toEqual(identityA);
          return pack;
        });
        expect(plan.requiredTools).toEqual(["DataAnalysisTool"]);
      },
      identityA
    );
    expect(source.pack.provider).toEqual(identityA);
    expect(adapterA.planRequests).toHaveLength(1);
    adapterA.dispose();

    const adapterB = new M1PlannerAdapter("provider-adapter-b", "adapter-b-model", "NATIVE_PROVIDER_SESSION_B");
    const runtime = createM1Runtime(fixture, "m1-provider-adapter-b");
    const canonical = canonicalRuntime(runtime);
    const observed = deferred<{ pack: ContextPack; requiredTools: string[] }>();
    runtime.registerHandler("research_loop", async (job) => {
      try {
        const snapshot = m1Snapshot(false);
        const session = await DurableCanonicalResearchSession.create(
          { jobs: runtime, settingsStore: fixture.settings, runtime: canonical.runtime, hasher: storageCanonicalHasher },
          job
        );
        await session.prepare(snapshot, m1Specification());
        const checkpoint = job.resumeCheckpointId ? await runtime.getCheckpoint(job.resumeCheckpointId) : undefined;
        if (!checkpoint) throw new Error("Provider-swap resume checkpoint was not read back after restart.");
        await runtime.commitCanonicalRevisionPlan(session.owner, () => session.prepareResumeRevision(checkpoint));
        let resumedPack: ContextPack | undefined;
        const plan = await runM1Planner(adapterB, settings, snapshot, async (input) => {
          resumedPack = await session.compilePlannerContext(input);
          return resumedPack;
        });
        if (!resumedPack) throw new Error("Provider B did not compile a durable ContextPack.");
        await runtime.settle(job.id, "blocked", job.projectRevision, "M1 adapter-swap verification completed without product completion.");
        observed.resolve({ pack: resumedPack, requiredTools: plan.requiredTools });
      } catch (error) {
        observed.reject(error);
        throw error;
      }
    });
    await runtime.initialize();
    const response = await handleRpcV2(
      resumeRequest(source.jobId, source.checkpointId, "m1-provider-adapter-b"),
      m1RpcContext(fixture, runtime, m1Snapshot(false))
    );
    const receipt = response.result as { jobId: string };
    const result = await withTimeout(observed.promise, "M1 provider adapter B resume");
    await waitForStatus(runtime, receipt.jobId, "blocked");
    await runtime.close();
    releaseM1Runtime(runtime);

    expect(result.pack.provider).toEqual(await adapterB.contextIdentity());
    expect(result.pack.task).toEqual(source.pack.task);
    expect(result.requiredTools).toEqual(["DataAnalysisTool"]);
    expect(adapterB.planRequests).toHaveLength(1);
    expect(adapterB.planRequests[0]?.user).toBe(result.pack.providerInput);
    const databaseBytes = readFileSync(fixture.databasePath);
    expect(databaseBytes.includes(Buffer.from("NATIVE_PROVIDER_SESSION_A"))).toBe(false);
    expect(databaseBytes.includes(Buffer.from("NATIVE_PROVIDER_SESSION_B"))).toBe(false);
  });

  it.each<{
    label: string;
    blocker: M1ResumeBlocker;
    expectedCode: "NOT_READY" | "CONFLICT";
    message: RegExp;
    capabilityExpansion?: boolean;
  }>([
    { label: "pending external effect", blocker: "pending-effect", expectedCode: "NOT_READY", message: /ambiguous external side effect/i },
    { label: "stale tool descriptor", blocker: "stale-tool", expectedCode: "NOT_READY", message: /changed schema version/i },
    { label: "unavailable tool", blocker: "unavailable-tool", expectedCode: "NOT_READY", message: /no longer available/i },
    { label: "stale memory", blocker: "stale-memory", expectedCode: "NOT_READY", message: /stale selected memory/i },
    { label: "exhausted budget", blocker: "budget", expectedCode: "NOT_READY", message: /resource budget is exhausted/i },
    {
      label: "capability expansion",
      blocker: "none",
      expectedCode: "CONFLICT",
      message: /immutable requested capability policy/i,
      capabilityExpansion: true
    }
  ])("blocks $label before a resumed handler can execute", async ({ blocker, expectedCode, message, capabilityExpansion }) => {
    const fixture = createM1Fixture(`block-${blocker}-${capabilityExpansion ? "capability" : "state"}`);
    await setM1CodexModel(fixture, "gpt-5.6-sol");
    const source = await interruptM1Run(fixture, blocker);
    const snapshot = m1Snapshot(false, capabilityExpansion === true);
    if (capabilityExpansion) await enableSearch(fixture);
    const runtime = createM1Runtime(fixture, `m1-block-${blocker}`);
    let handlerRan = false;
    runtime.registerHandler("research_loop", async (job) => {
      handlerRan = true;
      await runtime.settle(job.id, "failed", job.projectRevision, "A blocked resume unexpectedly reached execution.");
    });
    await runtime.initialize();
    const requestedCapabilities = capabilityExpansion ? { ...M1_CAPABILITIES, search: true } : M1_CAPABILITIES;

    const error = await handleRpcV2(
      resumeRequest(source.jobId, source.checkpointId, `m1-block-${blocker}`, requestedCapabilities),
      m1RpcContext(fixture, runtime, snapshot)
    ).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(RpcV2Error);
    expect(error).toMatchObject({ code: expectedCode });
    expect((error as Error).message).toMatch(message);
    expect(handlerRan).toBe(false);
    expect(readJobStatus(fixture.databasePath, source.jobId)).toBe("interrupted");
    await runtime.close();
    releaseM1Runtime(runtime);
  });
});

function resumeRequest(
  interruptedJobId: string,
  checkpointId: string,
  idempotencyKey: string,
  requestedCapabilities: typeof M1_CAPABILITIES = M1_CAPABILITIES
) {
  return {
    requestId: `request-${idempotencyKey}`,
    method: "loop.resume",
    params: {
      projectId: M1_PROJECT_ID,
      interruptedJobId,
      checkpointId,
      idempotencyKey,
      requestedCapabilities,
      toolPolicy: M1_TOOL_POLICY
    }
  };
}

async function enableSearch(fixture: ReturnType<typeof createM1Fixture>): Promise<void> {
  const settings = await fixture.settings.getSettings();
  await fixture.settings.saveSettings({ ...settings, allowExternalSearch: true });
}

async function runM1Planner(
  adapter: LlmProvider,
  settings: AppSettings,
  snapshot: ResearchSnapshot,
  compilePlannerContext: NonNullable<Parameters<ResearchPlanner["plan"]>[0]["compilePlannerContext"]>
) {
  const identity = await adapter.contextIdentity?.();
  if (!identity) throw new Error("M1 planner adapter must expose its canonical context identity.");
  const input = m1PlannerInput(snapshot, identity);
  return new ResearchPlanner(adapter).plan({
    snapshot,
    specification: input.specification,
    iteration: input.iteration,
    settings,
    availableTools: input.tools.map((tool) => tool.name),
    runtimeToolDiagnostics: input.runtimeToolDiagnostics,
    effectiveCapabilities: M1_CAPABILITIES,
    toolPolicy: M1_TOOL_POLICY,
    compilePlannerContext
  });
}

class M1PlannerAdapter implements LlmProvider {
  readonly planRequests: LlmJsonRequest[] = [];
  private nativeConversationState: string | undefined;

  constructor(
    readonly name: string,
    private readonly modelId: string,
    nativeConversationState: string
  ) {
    this.nativeConversationState = nativeConversationState;
  }

  async isAvailable(): Promise<boolean> {
    return true;
  }

  async contextIdentity(): Promise<ContextProviderIdentity> {
    return { providerId: this.name, modelId: this.modelId, capabilityReceipt: STANDARD_CONTEXT_PROVIDER_CAPABILITY_RECEIPT };
  }

  async completeJson<T>(request: LlmJsonRequest<T>): Promise<T> {
    if (request.schemaName !== "AetherOpsResearchPlan") throw new Error(`Unexpected M1 provider schema: ${request.schemaName}`);
    if (!this.nativeConversationState) throw new Error("Disposed M1 provider adapter cannot execute.");
    this.planRequests.push(request);
    return {
      objective: "Verify receipt-bound planning after a provider adapter boundary change.",
      targetQuestions: [],
      targetHypotheses: [],
      toolRequests: [
        {
          intentId: "verify-durable-context",
          toolName: "DataAnalysisTool",
          purpose: "Check the durable context and artifact completeness.",
          expectedOutcome: "A deterministic completeness assessment.",
          inputs: { checks: ["artifact_completeness"] }
        }
      ],
      expectedSources: ["durable receipts"],
      expectedArtifacts: ["context receipt"],
      executionSteps: ["Analyze the receipt-bound state."],
      stopCriteria: ["The deterministic analysis completes."],
      fetchCandidateUrls: []
    } as T;
  }

  dispose(): void {
    this.nativeConversationState = undefined;
  }
}

function m1Provider(providerId: string, modelId: string): ContextProviderIdentity {
  return { providerId, modelId, capabilityReceipt: STANDARD_CONTEXT_PROVIDER_CAPABILITY_RECEIPT };
}

async function waitForStatus(runtime: { get(jobId: string): Promise<DurableJobRecord | undefined> }, jobId: string, status: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if ((await runtime.get(jobId))?.status === status) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`M1 durable job ${jobId} did not reach ${status}.`);
}

function readJobStatus(databasePath: string, jobId: string): string | undefined {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    return (database.prepare("select status from jobs where id=?").get(jobId) as { status?: string } | undefined)?.status;
  } finally {
    database.close();
  }
}

function readCheckpointContextPackId(databasePath: string, checkpointId: string): string | undefined {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const row = database.prepare("select data from checkpoints where id=?").get(checkpointId) as { data?: string } | undefined;
    if (!row?.data) return undefined;
    const data = JSON.parse(row.data) as { canonicalContextPackId?: unknown };
    return typeof data.canonicalContextPackId === "string" ? data.canonicalContextPackId : undefined;
  } finally {
    database.close();
  }
}

function contextPackCount(databasePath: string): number {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    return Number((database.prepare("select count(*) count from context_packs").get() as { count: number }).count);
  } finally {
    database.close();
  }
}

function contextReceiptReadback(databasePath: string): {
  integrity: string;
  rows: Array<{ id: string; data: { contentStored: boolean; provider: { modelId: string } } }>;
} {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const integrity = (database.prepare("pragma integrity_check").get() as { integrity_check: string }).integrity_check;
    const rows = database.prepare("select id,data from context_packs order by created_at,id").all() as unknown as Array<{ id: string; data: string }>;
    return { integrity, rows: rows.map((row) => ({ id: row.id, data: JSON.parse(row.data) as { contentStored: boolean; provider: { modelId: string } } })) };
  } finally {
    database.close();
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((next, fail) => {
    resolve = next;
    reject = fail;
  });
  return { promise, resolve, reject };
}

async function withTimeout<T>(promise: Promise<T>, label: string): Promise<T> {
  return Promise.race([promise, new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`${label} timed out.`)), 10_000))]);
}
