import { describe, expect, it, vi } from "vitest";
import { createInputProject, createStrictTestOrchestrator } from "../../core/testing/orchestratorTestHarness.js";
import type { ContextPack } from "../../core/context/public.js";
import type { RunStateRevision } from "../../core/orchestration/runStateCapsule.js";
import type { TaskContract } from "../../core/orchestration/taskContract.js";
import type { LlmInvocationMetadata } from "../../core/providers/llm.js";
import { CanonicalRunRuntime } from "./canonicalRunRuntime.js";
import type { CanonicalRunGateway, CanonicalRunOwner } from "./canonicalRunTypes.js";
import { DEFAULT_CANONICAL_TASK_LIMITS } from "./durableCanonicalResearchSession.js";
import { durableJobRequestHash } from "./durableJobRequestHash.js";
import type { DurableJobHandler, DurableJobRecord } from "./durableJobTypes.js";
import type { DurableJobRuntime } from "./durableJobRuntime.js";
import { registerDurableJobHandlers, toProgramRequest, toStorageLlmInvocation, toStorageRunningLlmInvocation } from "./registerDurableJobHandlers.js";

describe("durable engineering job request dispatch", () => {
  it("never falls an explicit Codex CLI request through to mesh-inspect", () => {
    expect(() =>
      toProgramRequest({
        target: "codex",
        objective: "Implement the requested project-local change.",
        inputs: { inputArtifactIds: [], outputs: [{ relativePath: "reports/result.md", kind: "report" }] }
      })
    ).toThrow(/explicit Codex CLI handler/);
  });

  it("keeps the explicit mesh mapping for real mesh requests", () => {
    expect(toProgramRequest({ target: "mesh", objective: "Inspect the mesh.", inputs: { artifactPath: "mesh/case.msh" } })).toMatchObject({
      kind: "mesh-inspect",
      target: "modeling",
      artifactPath: "mesh/case.msh"
    });
  });

  it("persists ContextPack linkage as IDs and hashes while retaining the provider prompt hash", () => {
    const providerPromptHash = "1".repeat(64);
    const secretPrompt = "DO_NOT_PERSIST_THE_PROVIDER_PROMPT";
    const metadata = {
      provider: "codex-oauth",
      model: "gpt-test",
      schemaName: "AetherOpsResearchPlan",
      promptVersion: "research-plan-v3-context-pack",
      schemaVersion: "research-plan-strict-v1",
      promptHash: providerPromptHash,
      contextPackId: "context-pack:fixture",
      canonicalHash: "2".repeat(64),
      finalInputHash: "3".repeat(64),
      startedAt: "2026-07-14T00:00:00.000Z",
      completedAt: "2026-07-14T00:00:01.000Z",
      durationMs: 1_000,
      repairCount: 0,
      status: "completed",
      inputTokenEstimate: 42,
      outputTokenEstimate: 7,
      tokenEstimator: "utf8_bytes_div_4_ceil_v1",
      monetaryCostAvailability: "unavailable",
      prompt: secretPrompt,
      providerInput: secretPrompt
    } satisfies LlmInvocationMetadata & { prompt: string; providerInput: string };

    const stored = toStorageLlmInvocation({ id: "job-trace", projectId: "project-trace" }, metadata, "invocation-trace");

    expect(stored.promptHash).toBe(providerPromptHash);
    expect(stored.data).toMatchObject({
      contextPackId: metadata.contextPackId,
      canonicalHash: metadata.canonicalHash,
      finalInputHash: metadata.finalInputHash,
      accounting: {
        inputUnits: 42,
        outputUnits: 7,
        monetaryCost: { availability: "unavailable", policy: "unmetered_codex_oauth_v1" }
      }
    });
    expect(JSON.stringify(stored)).not.toContain(secretPrompt);
  });

  it("maps the pre-spawn and terminal LLM receipts to the same durable identity without prompt content", () => {
    const job = { id: "job-receipt", projectId: "project-receipt" };
    const running = toStorageRunningLlmInvocation(job, {
      invocationId: "invocation-receipt",
      provider: "codex-oauth",
      model: "gpt-5.6-sol",
      reasoningEffort: "high",
      schemaName: "AetherOpsResearchPlan",
      promptVersion: "planner-v1",
      schemaVersion: "schema-v1",
      promptHash: "a".repeat(64),
      startedAt: "2026-07-14T00:00:00.000Z",
      status: "running"
    });
    const terminal = toStorageLlmInvocation(
      job,
      {
        invocationId: "invocation-receipt",
        provider: "codex-oauth",
        model: "gpt-5.6-sol",
        reasoningEffort: "high",
        schemaName: "AetherOpsResearchPlan",
        promptVersion: "planner-v1",
        schemaVersion: "schema-v1",
        promptHash: "a".repeat(64),
        responseHash: "b".repeat(64),
        startedAt: "2026-07-14T00:00:00.000Z",
        completedAt: "2026-07-14T00:00:01.000Z",
        durationMs: 1_000,
        repairCount: 0,
        status: "completed",
        inputTokenEstimate: 10,
        outputTokenEstimate: 2,
        tokenEstimator: "utf8_bytes_div_4_ceil_v1",
        monetaryCostAvailability: "unavailable"
      },
      "invocation-receipt"
    );

    expect(running).toMatchObject({ id: "invocation-receipt", status: "running" });
    expect(running.completedAt).toBeUndefined();
    expect(terminal).toMatchObject({ id: "invocation-receipt", status: "completed", responseHash: "b".repeat(64) });
    expect(JSON.stringify([running, terminal])).not.toContain("prompt content");
  });

  it("fails closed when a resume handler returns a non-terminal snapshot", async () => {
    const orchestrator = createStrictTestOrchestrator();
    const snapshot = await createInputProject(orchestrator, {
      goal: "Resume a durable research job.",
      topic: "Resume safety",
      scope: "Reject false terminal completion.",
      budget: "bounded",
      autonomyPolicy: { toolApproval: "suggested", allowExternalSearch: false, allowCodeExecution: false }
    });
    vi.spyOn(orchestrator, "resume").mockResolvedValue(snapshot);
    const handlers = new Map<string, DurableJobHandler>();
    const finish = vi.fn();
    const rootJob = initialJob(snapshot.project.id);
    const activeJob = resumeJob(snapshot.project.id);
    const gateway = new TestCanonicalGateway();
    const canonicalRuntime = new CanonicalRunRuntime({ gateway, hasher: { sha256Canonical: durableJobRequestHash } });
    const owner = { projectId: snapshot.project.id, runId: `run:${rootJob.id}`, jobId: rootJob.id };
    await canonicalRuntime.prepareInitialRun({
      owner,
      rootJobId: rootJob.id,
      rootJobCreatedAt: rootJob.createdAt,
      snapshot,
      policy: canonicalPolicy(),
      taskLimits: DEFAULT_CANONICAL_TASK_LIMITS,
      preparedAt: rootJob.createdAt
    });
    const predecessorCheckpoint = checkpoint(snapshot.project.id, rootJob.id);
    await canonicalRuntime.recordCheckpoint({
      owner,
      checkpointId: predecessorCheckpoint.id,
      stepReceiptId: predecessorCheckpoint.id,
      recordedAt: predecessorCheckpoint.committedAt,
      expectedState: { revision: 1, stateHash: (await canonicalRuntime.readCurrentRun(owner)).state.stateHash }
    });
    const jobs = {
      registerHandler: (kind: string, handler: DurableJobHandler) => handlers.set(kind, handler),
      finish,
      settle: vi.fn(),
      bindCanonicalTransition: vi.fn(),
      get: vi.fn(async (jobId: string) => (jobId === rootJob.id ? rootJob : undefined)),
      getProjectRevision: vi.fn(async () => activeJob.projectRevision),
      getCheckpoint: vi.fn(async () => predecessorCheckpoint),
      listCanonicalToolAttempts: vi.fn(async () => []),
      listCanonicalLlmInvocations: vi.fn(async () => []),
      latestCommittedCheckpoint: vi.fn(async () => undefined),
      commitCanonicalRevisionPlan: vi.fn(
        async (resumeOwner: CanonicalRunOwner, preparePlan: () => ReturnType<CanonicalRunRuntime["prepareResumeRevision"]>) => {
          const plan = await preparePlan();
          let expectedRevision = plan.expectedRevision;
          for (const revision of plan.revisions) {
            await gateway.commitRunState(resumeOwner, expectedRevision, revision);
            expectedRevision = revision.revision;
          }
          return plan.finalState;
        }
      ),
      commitCanonicalBudget: vi.fn(
        async (
          budgetOwner: CanonicalRunOwner,
          preparePlan: (recordedAt: string) => Promise<ReturnType<CanonicalRunRuntime["prepareBudgetRevision"]> extends Promise<infer T> ? T : never>
        ) => {
          const plan = await preparePlan(activeJob.createdAt);
          let expectedRevision = plan.expectedRevision;
          for (const revision of plan.revisions) {
            await gateway.commitRunState(budgetOwner, expectedRevision, revision);
            expectedRevision = revision.revision;
          }
        }
      )
    } as unknown as DurableJobRuntime;
    registerDurableJobHandlers({
      dataRoot: ".tmp/test-resume",
      orchestrator,
      settingsStore: {} as never,
      jobs,
      events: jobs,
      codexCli: {} as never,
      canonicalRuntime
    });
    const handler = handlers.get("research_loop");
    expect(handler).toBeDefined();

    await expect(handler?.(activeJob, { action: "resume" }, { signal: new AbortController().signal, requestedControl: () => undefined })).rejects.toThrow(
      /non-terminal project status/
    );
    expect(finish).not.toHaveBeenCalled();
  });
});

function resumeJob(projectId: string): DurableJobRecord {
  return {
    ...initialJob(projectId),
    id: "resume-job",
    status: "running",
    idempotencyKey: "resume-key",
    resumesJobId: "root-job",
    resumeCheckpointId: "checkpoint-1",
    createdAt: "2026-07-14T00:00:02.000Z",
    updatedAt: "2026-07-14T00:00:02.000Z",
    startedAt: "2026-07-14T00:00:02.000Z"
  };
}

function initialJob(projectId: string): DurableJobRecord {
  return {
    id: "root-job",
    projectId,
    kind: "research_loop",
    status: "paused",
    projectRevision: 1,
    idempotencyKey: "root-key",
    requestedCapabilities: { agent: true, engineering: false, search: false },
    effectiveCapabilities: { agent: true, engineering: false, search: false },
    toolPolicy: { allowCodexCli: false, sourceAccess: { mode: "offline" } },
    createdAt: "2026-07-14T00:00:00.000Z",
    updatedAt: "2026-07-14T00:00:00.000Z",
    startedAt: "2026-07-14T00:00:00.000Z",
    finishedAt: "2026-07-14T00:00:00.000Z"
  };
}

function canonicalPolicy() {
  return {
    requestedCapabilities: { agent: true, engineering: false, search: false },
    effectiveCapabilities: { agent: true, engineering: false, search: false },
    toolPolicy: { allowCodexCli: false, sourceAccess: { mode: "offline" as const } },
    externalSideEffects: []
  };
}

function checkpoint(projectId: string, jobId: string) {
  return {
    id: "checkpoint-1",
    projectId,
    jobId,
    step: "EXECUTE_TOOLS",
    checkpointKey: "execute-tools",
    status: "committed" as const,
    createdAt: "2026-07-14T00:00:01.000Z",
    committedAt: "2026-07-14T00:00:01.000Z"
  };
}

class TestCanonicalGateway implements CanonicalRunGateway {
  private readonly contracts = new Map<string, TaskContract>();
  private readonly revisions = new Map<string, RunStateRevision[]>();
  private readonly packs = new Map<string, ContextPack>();

  async saveTaskContract(_owner: CanonicalRunOwner, contract: TaskContract): Promise<unknown> {
    this.contracts.set(contract.id, this.contracts.get(contract.id) ?? contract);
    return this.contracts.get(contract.id);
  }
  async getTaskContract(projectId: string, taskContractId: string): Promise<unknown | undefined> {
    const contract = this.contracts.get(taskContractId);
    return contract?.projectId === projectId ? contract : undefined;
  }
  async latestRunState(owner: CanonicalRunOwner): Promise<unknown | undefined> {
    return this.revisions.get(owner.runId)?.at(-1);
  }
  async commitRunState(owner: CanonicalRunOwner, expectedRevision: number | null, revision: RunStateRevision): Promise<unknown> {
    const revisions = this.revisions.get(owner.runId) ?? [];
    const existing = revisions.find((item) => item.revision === revision.revision);
    if (existing) return existing;
    expect(revisions.at(-1)?.revision ?? null).toBe(expectedRevision);
    revisions.push(revision);
    this.revisions.set(owner.runId, revisions);
    return revision;
  }
  async saveContextPack(_owner: CanonicalRunOwner, _expectedRevision: number, pack: ContextPack): Promise<unknown> {
    this.packs.set(pack.id, pack);
    return pack;
  }
}
