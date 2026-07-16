import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { ContextPack, ContextCompilerInput, ContextProviderIdentity, ContextRunState } from "../../src/core/context/public.js";
import { ContextCompiler, STANDARD_CONTEXT_PROVIDER_CAPABILITY_RECEIPT } from "../../src/core/context/public.js";
import { plannerToolInputContract } from "../../src/core/planning/plannerContextPack.js";
import { reduceRunStateRevision } from "../../src/core/orchestration/runStateReducer.js";
import type { RunStateRevision } from "../../src/core/orchestration/runStateCapsule.js";
import { DataAnalysisTool } from "../../src/core/tools/dataAnalysisTool.js";
import { getToolDescriptor } from "../../src/core/tools/toolDescriptors.js";
import type { ResearchToolExecutionContext } from "../../src/core/tools/researchToolTypes.js";
import { canonicalValueByteLength } from "../../src/core/tools/toolResultHash.js";
import { ResearchLoopStep, type ResearchSnapshot } from "../../src/core/shared/types.js";
import type { CodexModelId } from "../../src/core/shared/settingsTypes.js";
import { CanonicalRunRuntime } from "../../src/server/composition/canonicalRunRuntime.js";
import type { CanonicalRunOwner } from "../../src/server/composition/canonicalRunTypes.js";
import { DurableCanonicalResearchSession } from "../../src/server/composition/durableCanonicalResearchSession.js";
import { DurableCanonicalRunGateway } from "../../src/server/composition/durableCanonicalRunGateway.js";
import { durableJobRequestHash } from "../../src/server/composition/durableJobRequestHash.js";
import { DurableJobRuntime } from "../../src/server/composition/durableJobRuntime.js";
import type { DurableJobRecord } from "../../src/server/composition/durableJobTypes.js";
import type { RpcHandlerContext } from "../../src/server/http/v2/context.js";
import { handleRpcV2 } from "../../src/server/http/v2/rpcRouter.js";
import { JsonAppSettingsStore } from "../../src/server/runtime/storage/settingsStore.js";
import { migrateStorageV2Schema } from "../../src/server/runtime/storage/v2/schema.js";
import { parseStoredRunStateRevision, storageCanonicalHasher } from "../../src/server/runtime/storage/v2/runStatePayloadValidator.js";
import type { StorageRunStateRevisionInput } from "../../src/server/runtime/storage/v2/runStateTypes.js";
import type { StorageToolAttempt } from "../../src/server/runtime/storage/v2/traceTypes.js";
import { M1_CAPABILITIES, M1_CREATED_AT, M1_PROJECT_ID, M1_TOOL_POLICY, m1PlannerInput, m1Snapshot, m1Specification } from "./m1LongHorizonInputs.fixture.js";

export {
  M1_CAPABILITIES,
  M1_PROJECT_ID,
  M1_PROVIDER_SECRET,
  M1_TOOL_POLICY,
  M1_TRANSCRIPT_SENTINEL,
  m1PlannerInput,
  m1Snapshot,
  m1Specification
} from "./m1LongHorizonInputs.fixture.js";

export type M1ResumeBlocker = "none" | "pending-effect" | "stale-tool" | "unavailable-tool" | "stale-memory" | "budget";

export interface M1Fixture {
  root: string;
  databasePath: string;
  settings: JsonAppSettingsStore;
}

export interface InterruptedM1Run {
  jobId: string;
  checkpointId: string;
  pack: ContextPack;
  lateUnboundPack?: ContextPack;
}

const roots = new Set<string>();
const runtimes = new Set<DurableJobRuntime>();

export async function cleanupM1LongHorizonFixtures(): Promise<void> {
  await Promise.all([...runtimes].map((runtime) => runtime.close().catch(() => undefined)));
  runtimes.clear();
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  roots.clear();
}

export function createM1Fixture(label: string): M1Fixture {
  const root = mkdtempSync(join(tmpdir(), `aetherops-m1-${label}-`));
  roots.add(root);
  const databasePath = join(root, "operational.sqlite");
  const database = new DatabaseSync(databasePath);
  try {
    migrateStorageV2Schema(database);
    const project = m1Snapshot(true).project;
    database
      .prepare(
        `insert into projects_v2 (id,short_id,project_root,topic,status,created_at,updated_at,data)
         values (?,?,?,?,?,?,?,?)`
      )
      .run(M1_PROJECT_ID, "m1long", project.projectRoot, project.topic, project.status, project.createdAt, project.updatedAt, JSON.stringify(project));
    database
      .prepare("insert into project_revision_heads (project_id,revision,last_receipt_id,updated_at) values (?,0,null,?)")
      .run(M1_PROJECT_ID, project.updatedAt);
  } finally {
    database.close();
  }
  return { root, databasePath, settings: new JsonAppSettingsStore(join(root, "settings.json")) };
}

export async function setM1CodexModel(fixture: M1Fixture, model: CodexModelId): Promise<void> {
  const current = await fixture.settings.getSettings();
  await fixture.settings.saveSettings({
    ...current,
    codex: { ...current.codex, model, reasoningEffort: "high" },
    allowAgent: true,
    allowExternalSearch: false,
    allowCodeExecution: false
  });
}

export function createM1Runtime(fixture: M1Fixture, workerInstanceId: string): DurableJobRuntime {
  const runtime = new DurableJobRuntime(fixture.databasePath, {
    concurrency: 1,
    shutdownGraceMs: 1,
    workerInstanceId,
    dataRoot: fixture.root
  });
  runtimes.add(runtime);
  return runtime;
}

export function releaseM1Runtime(runtime: DurableJobRuntime): void {
  runtimes.delete(runtime);
}

export async function requiredM1ProjectRevision(runtime: Pick<DurableJobRuntime, "getProjectRevision">): Promise<number> {
  const revision = await runtime.getProjectRevision(M1_PROJECT_ID);
  if (revision === undefined) throw new Error("The M1 durable project revision is unavailable.");
  return revision;
}

export function canonicalRuntime(runtime: DurableJobRuntime): { gateway: DurableCanonicalRunGateway; runtime: CanonicalRunRuntime } {
  const gateway = new DurableCanonicalRunGateway(runtime);
  return { gateway, runtime: new CanonicalRunRuntime({ gateway, hasher: storageCanonicalHasher }) };
}

export function m1RpcContext(fixture: M1Fixture, runtime: DurableJobRuntime, snapshot: ResearchSnapshot): RpcHandlerContext {
  return {
    appRoot: fixture.root,
    dataRoot: fixture.root,
    host: "127.0.0.1",
    port: 0,
    startedAt: M1_CREATED_AT,
    version: "0.2.0-test",
    env: {},
    llm: undefined,
    orchestrator: { getSnapshot: async () => structuredClone(snapshot) } as RpcHandlerContext["orchestrator"],
    projectMutations: {
      assertReadable: () => undefined,
      assertAllReadable: () => undefined
    } as unknown as RpcHandlerContext["projectMutations"],
    settingsStore: fixture.settings,
    events: runtime,
    jobs: runtime
  };
}

export async function interruptM1Run(
  fixture: M1Fixture,
  blocker: M1ResumeBlocker,
  observeContextPack?: (pack: ContextPack, snapshot: ResearchSnapshot) => Promise<void>,
  provider?: ContextProviderIdentity,
  lateUnboundBlocker?: Extract<M1ResumeBlocker, "stale-tool" | "unavailable-tool" | "stale-memory">
): Promise<InterruptedM1Run> {
  const runtime = createM1Runtime(fixture, `m1-source-${blocker}`);
  const canonical = canonicalRuntime(runtime);
  const snapshot = m1Snapshot(true);
  const ready = deferred<InterruptedM1Run>();
  runtime.registerHandler("research_loop", async (job) => {
    try {
      const session = await DurableCanonicalResearchSession.create(
        { jobs: runtime, settingsStore: fixture.settings, runtime: canonical.runtime, hasher: storageCanonicalHasher },
        job
      );
      await session.prepare(snapshot, m1Specification());
      const pack = await compileScenarioContext(fixture, canonical, session, snapshot, blocker, provider);
      if (observeContextPack) await observeContextPack(pack, snapshot);
      if (blocker === "budget") await consumeWholeToolBudget(runtime, session.owner);
      await recordCompletedAnalysis(runtime, job, snapshot);
      if (blocker === "pending-effect") await recordPendingExternalAttempt(runtime, job);
      const checkpoint = await runtime.commitCanonicalCheckpoint({
        owner: session.owner,
        step: ResearchLoopStep.ExecuteTools,
        projectRevision: await requiredM1ProjectRevision(runtime),
        requireContextPack: true,
        checkpointData: { engineeringBaseline: job.engineeringBaseline ?? null },
        prepareRevision: (input) => session.prepareCheckpointRevision(input)
      });
      const lateUnboundPack = lateUnboundBlocker
        ? await compileScenarioContext(fixture, canonical, session, snapshot, lateUnboundBlocker, provider)
        : undefined;
      ready.resolve({ jobId: job.id, checkpointId: checkpoint.id, pack, ...(lateUnboundPack ? { lateUnboundPack } : {}) });
      await new Promise<void>(() => undefined);
    } catch (error) {
      ready.reject(error);
      throw error;
    }
  });
  await runtime.initialize();
  await handleRpcV2(
    {
      requestId: `request-m1-source-${blocker}`,
      method: "loop.start",
      params: {
        projectId: M1_PROJECT_ID,
        idempotencyKey: `m1-source-${blocker}`,
        requestedCapabilities: M1_CAPABILITIES,
        toolPolicy: M1_TOOL_POLICY
      }
    },
    m1RpcContext(fixture, runtime, snapshot)
  );
  const interrupted = await withTimeout(ready.promise, "M1 source checkpoint");
  await runtime.close();
  releaseM1Runtime(runtime);
  return interrupted;
}

async function compileScenarioContext(
  fixture: M1Fixture,
  canonical: ReturnType<typeof canonicalRuntime>,
  session: DurableCanonicalResearchSession,
  snapshot: ResearchSnapshot,
  blocker: M1ResumeBlocker,
  provider?: ContextProviderIdentity
): Promise<ContextPack> {
  if (!["stale-tool", "unavailable-tool", "stale-memory"].includes(blocker)) {
    const selectedProvider = provider ?? {
      providerId: "codex-oauth",
      modelId: (await fixture.settings.getRuntimeSettings()).codex.model,
      capabilityReceipt: STANDARD_CONTEXT_PROVIDER_CAPABILITY_RECEIPT
    };
    return session.compilePlannerContext(m1PlannerInput(snapshot, selectedProvider));
  }
  const { taskContract, state } = await canonical.runtime.readCurrentRun(session.owner);
  const descriptor = requiredDescriptor("DataAnalysisTool");
  const tool =
    blocker === "unavailable-tool"
      ? { name: "RemovedResearchTool", version: "1", summary: "Removed tool", inputContractHash: "a".repeat(64), available: true, priority: 900 }
      : {
          name: descriptor.name,
          version: blocker === "stale-tool" ? `${descriptor.version}-stale` : descriptor.version,
          summary: descriptor.summary,
          inputContractHash: durableJobRequestHash(plannerToolInputContract(descriptor.name)),
          available: true,
          priority: 900
        };
  const input: ContextCompilerInput = {
    runId: session.owner.runId,
    projectId: session.owner.projectId,
    createdAt: new Date(Date.now() + 1_000).toISOString(),
    taskContract: {
      id: taskContract.id,
      projectId: taskContract.projectId,
      contentHash: taskContract.contentHash,
      goal: taskContract.goal,
      normalizedUserIntent: taskContract.normalizedUserIntent,
      acceptanceCriteria: taskContract.acceptanceCriteria.map((item) => ({ ...item })),
      constraints: [...taskContract.constraints],
      nonGoals: [...taskContract.nonGoals],
      requiredDeliverables: taskContract.requiredDeliverables.map((item) => ({ ...item })),
      riskPolicy: { ...taskContract.riskPolicy },
      approvalRequirements: taskContract.approvalRequirements.map((item) => ({ ...item })),
      resourceBudget: { ...taskContract.resourceBudget },
      ...(taskContract.deadline ? { deadline: taskContract.deadline } : {}),
      instructionProvenance: taskContract.instructionProvenance.map((item) => ({ ...item }))
    },
    runState: m1ContextRunState(state),
    provider: provider ?? {
      providerId: "codex-oauth",
      modelId: (await fixture.settings.getRuntimeSettings()).codex.model,
      capabilityReceipt: STANDARD_CONTEXT_PROVIDER_CAPABILITY_RECEIPT
    },
    instructions: [{ id: "instruction-m1-resume", text: "Use only persisted receipt-bound state.", priority: 1_000, trust: "system" }],
    evidence: [],
    memories:
      blocker === "stale-memory"
        ? [{ id: "memory-stale-m1", text: "Previously selected memory requires revalidation.", priority: 800, trust: "verified", stale: true }]
        : [],
    tools: [tool],
    artifacts: [],
    priorOutputs: [],
    candidateSelections: {
      memory:
        blocker === "stale-memory"
          ? { source: "snapshot.global_memory_items", status: "selected", candidateCount: 1, selectedIds: ["memory-stale-m1"], omittedCount: 0 }
          : {
              source: "snapshot.global_memory_items",
              status: "empty",
              candidateCount: 0,
              selectedIds: [],
              omittedCount: 0,
              emptyReason: "no_project_validated_candidates"
            },
      priorOutputs: {
        source: "snapshot.conversation_artifacts",
        status: "empty",
        candidateCount: 0,
        selectedIds: [],
        omittedCount: 0,
        emptyReason: "no_hash_bearing_conversation_artifacts"
      }
    },
    budget: { tokenBudget: 16_000, maxChars: 64_000 }
  };
  const pack = await new ContextCompiler().compile(input);
  await canonical.gateway.saveContextPack(session.owner, state.revision, pack);
  return pack;
}

function m1ContextRunState(state: RunStateRevision): ContextRunState {
  return {
    schemaVersion: state.schemaVersion,
    runId: state.runId,
    projectId: state.projectId,
    status: state.status,
    revision: state.revision,
    parentRevisionHash: state.parentRevisionHash,
    stateHash: state.stateHash,
    taskContractId: state.taskContractId,
    taskContractHash: state.taskContractHash,
    taskGraph: { ...state.taskGraph, nodes: state.taskGraph.nodes.map((node) => ({ ...node, dependencyNodeIds: [...node.dependencyNodeIds] })) },
    currentNodeId: state.currentNodeId,
    iterationCompletedActionIds: [],
    completedNodeReceipts: state.completedNodeReceipts.map((item) => ({
      receiptId: item.receiptId,
      runId: item.runId,
      projectId: item.projectId,
      nodeId: item.nodeId,
      receiptHash: item.receiptHash,
      artifactRefs: item.artifactRefs.map((reference) => ({ ...reference })),
      evidenceRefs: item.evidenceRefs.map((reference) => ({ ...reference })),
      verifierReceiptIds: [...item.verifierReceiptIds],
      completedAt: item.completedAt
    })),
    pendingNodeIds: [...state.pendingNodeIds],
    artifactRefs: state.artifactRefs.map((item) => ({ ...item })),
    evidenceRefs: state.evidenceRefs.map((item) => ({ ...item })),
    verifiedFacts: state.verifiedFacts.map((item) => ({ ...item, evidenceIds: [...item.evidenceIds] })),
    decisions: state.decisions.map((item) => ({ ...item })),
    assumptions: state.assumptions.map((item) => ({ ...item })),
    openQuestions: state.openQuestions.map((item) => ({ ...item })),
    blockedReasons: state.blockedReasons.map((item) => ({ ...item })),
    budgetLimits: { ...state.budgetLimits },
    budgetUsage: { ...state.budgetUsage },
    nextProposedNodeIds: [...state.nextProposedNodeIds],
    createdAt: state.createdAt,
    updatedAt: state.updatedAt
  };
}

async function recordCompletedAnalysis(runtime: DurableJobRuntime, job: DurableJobRecord, snapshot: ResearchSnapshot): Promise<void> {
  const descriptor = requiredDescriptor("DataAnalysisTool");
  const decisionId = `decision:${job.id}:analysis`;
  const attemptId = `attempt:${job.id}:analysis`;
  const inputs = { checks: ["artifact_completeness"] };
  const executionContext: ResearchToolExecutionContext = {
    signal: new AbortController().signal,
    attemptId,
    decisionId,
    ordinal: 0,
    phase: "analysis",
    inputs
  };
  const result = await new DataAnalysisTool().run(
    {
      project: snapshot.project,
      questions: snapshot.questions,
      hypotheses: snapshot.hypotheses,
      evidence: snapshot.evidence,
      artifacts: snapshot.artifacts,
      sources: snapshot.sources,
      toolRuns: snapshot.toolRuns,
      normalizedRecords: snapshot.normalizedRecords,
      validationResults: snapshot.validationResults,
      projectContextSnapshots: snapshot.projectContextSnapshots,
      results: snapshot.results,
      iteration: 1,
      executionContext: { toolPolicy: M1_TOOL_POLICY }
    },
    undefined,
    executionContext
  );
  await runtime.recordToolDecision({
    id: decisionId,
    projectId: job.projectId,
    jobId: job.id,
    toolName: descriptor.name,
    purpose: "Run the real deterministic artifact completeness check.",
    expectedOutcome: "An explicit satisfied or unverifiable assessment.",
    rawSelection: { inputHash: durableJobRequestHash(inputs) },
    userPinned: false,
    policyStatus: "accepted",
    compiledAction: {
      toolName: descriptor.name,
      ordinal: 0,
      phase: descriptor.phase,
      inputHash: durableJobRequestHash(inputs)
    },
    createdAt: result.toolRun.startedAt
  });
  const base: StorageToolAttempt = {
    id: attemptId,
    projectId: job.projectId,
    jobId: job.id,
    decisionId,
    ordinal: 0,
    status: "queued",
    inputHash: durableJobRequestHash(inputs),
    traceVersion: 1,
    traceAvailability: "vnext",
    descriptorVersion: descriptor.version,
    descriptorSideEffects: [],
    idempotencyKey: `m1-analysis:${job.id}`,
    dependsOnAttemptIds: [],
    queuedAt: result.toolRun.startedAt
  };
  await runtime.recordToolAttemptAndEvent({
    attempt: base,
    projectRevision: await requiredM1ProjectRevision(runtime),
    toolName: descriptor.name
  });
  await runtime.recordToolAttemptAndEvent({
    attempt: { ...base, status: "running", startedAt: result.toolRun.startedAt },
    projectRevision: await requiredM1ProjectRevision(runtime),
    toolName: descriptor.name
  });
  await runtime.recordToolAttemptAndEvent({
    attempt: {
      ...base,
      status: "completed",
      startedAt: result.toolRun.startedAt,
      completedAt: result.toolRun.completedAt,
      outputHash: durableJobRequestHash(result),
      terminalCause: "completed",
      data: {
        accounting: {
          version: 1,
          canonicalResultBytes: canonicalValueByteLength(result),
          source: "canonical_result_utf8_v1"
        }
      }
    },
    projectRevision: await requiredM1ProjectRevision(runtime),
    toolName: descriptor.name
  });
}

async function recordPendingExternalAttempt(runtime: DurableJobRuntime, job: DurableJobRecord): Promise<void> {
  const descriptor = requiredDescriptor("ArtifactWriterTool");
  const decisionId = `decision:${job.id}:pending-writer`;
  const attemptId = `attempt:${job.id}:pending-writer`;
  const inputs = { artifacts: [{ relativePath: "reports/m1-pending.md", kind: "research_report", format: "markdown" }] };
  const now = new Date().toISOString();
  await runtime.recordToolDecision({
    id: decisionId,
    projectId: job.projectId,
    jobId: job.id,
    toolName: descriptor.name,
    purpose: "Persist an intentionally unresolved external-effect boundary.",
    expectedOutcome: "No success is claimed before a terminal receipt exists.",
    rawSelection: { inputHash: durableJobRequestHash(inputs) },
    userPinned: false,
    policyStatus: "accepted",
    createdAt: now
  });
  const queued: StorageToolAttempt = {
    id: attemptId,
    projectId: job.projectId,
    jobId: job.id,
    decisionId,
    ordinal: 1,
    status: "queued",
    inputHash: durableJobRequestHash(inputs),
    traceVersion: 1,
    traceAvailability: "vnext",
    descriptorVersion: descriptor.version,
    descriptorSideEffects: [...descriptor.sideEffects],
    sideEffectKey: `m1-pending-writer:${job.id}`,
    idempotencyKey: `m1-pending-writer:${job.id}`,
    dependsOnAttemptIds: [`attempt:${job.id}:analysis`],
    queuedAt: now
  };
  await runtime.recordToolAttemptAndEvent({
    attempt: queued,
    projectRevision: await requiredM1ProjectRevision(runtime),
    toolName: descriptor.name
  });
  await runtime.recordToolAttemptAndEvent({
    attempt: { ...queued, status: "running", startedAt: now },
    projectRevision: await requiredM1ProjectRevision(runtime),
    toolName: descriptor.name
  });
}

async function consumeWholeToolBudget(runtime: DurableJobRuntime, owner: CanonicalRunOwner): Promise<void> {
  const stored = await runtime.latestCanonicalRunState(owner);
  if (!stored) throw new Error("Canonical state was not stored before budget consumption.");
  const state = parseStoredRunStateRevision(stored.data);
  const job = await runtime.get(owner.jobId);
  if (!job?.startedAt) throw new Error("Canonical budget fixture requires an operational job start timestamp.");
  const invocation = {
    id: `llm:${jobSafeId(owner.jobId)}:budget-exhaustion`,
    projectId: owner.projectId,
    jobId: owner.jobId,
    model: "deterministic-budget-fixture",
    reasoningEffort: "none",
    promptVersion: "m1-budget-v1",
    schemaVersion: "m1-budget-v1",
    promptHash: durableJobRequestHash({ jobId: owner.jobId, purpose: "budget-exhaustion" }),
    repairCount: 0,
    status: "running" as const,
    startedAt: job.startedAt,
    data: { provider: "deterministic-budget-fixture", schemaName: "m1-budget-v1" }
  };
  await runtime.saveLlmInvocation(invocation);
  await runtime.saveLlmInvocation({
    ...invocation,
    responseHash: durableJobRequestHash({ jobId: owner.jobId, purpose: "budget-exhaustion-response" }),
    latencyMs: 0,
    status: "completed",
    completedAt: job.startedAt,
    data: {
      provider: "deterministic-budget-fixture",
      schemaName: "m1-budget-v1",
      accounting: {
        version: 1,
        inputUnits: state.budgetLimits.maxInputTokens,
        outputUnits: 0,
        unit: "estimated_token",
        estimator: "utf8_bytes_div_4_ceil_v1",
        monetaryCost: { availability: "unavailable", policy: "unmetered_codex_oauth_v1" }
      }
    }
  });
}

export async function attemptOptimisticConflict(runtime: DurableJobRuntime, owner: CanonicalRunOwner): Promise<unknown> {
  const stored = await runtime.latestCanonicalRunState(owner);
  if (!stored) throw new Error("Canonical state is missing before optimistic conflict verification.");
  const state = parseStoredRunStateRevision(stored.data);
  const next = reduceRunStateRevision(
    state,
    {
      schemaVersion: 1,
      eventId: `event:${jobSafeId(owner.jobId)}:stale-write`,
      runId: state.runId,
      projectId: state.projectId,
      expectedRevision: state.revision,
      expectedStateHash: state.stateHash,
      occurredAt: nextTimestamp(state.updatedAt),
      type: "budget.consumed",
      delta: { durationMs: 1, inputTokens: 0, outputTokens: 0, toolCalls: 0, retries: 0, estimatedCostMicrousd: 0, toolOutputBytes: 0 }
    },
    storageCanonicalHasher
  );
  return runtime
    .commitCanonicalRunState({ expectedRevision: Math.max(0, state.revision - 1), revision: storageRevision(owner, next) })
    .then(() => undefined)
    .catch((error: unknown) => error);
}

function storageRevision(owner: CanonicalRunOwner, state: RunStateRevision): StorageRunStateRevisionInput {
  return {
    id: `${owner.runId}:revision:${state.revision}`,
    projectId: owner.projectId,
    runId: owner.runId,
    jobId: owner.jobId,
    schemaVersion: state.schemaVersion,
    revision: state.revision,
    previousRevision: state.revision - 1,
    parentRevisionHash: state.parentRevisionHash,
    stateHash: state.stateHash,
    taskContractId: state.taskContractId,
    taskContractHash: state.taskContractHash,
    recordedAt: state.updatedAt,
    data: state
  };
}

function requiredDescriptor(name: string) {
  const descriptor = getToolDescriptor(name);
  if (!descriptor) throw new Error(`Required M1 descriptor is unavailable: ${name}.`);
  return descriptor;
}

function jobSafeId(value: string): string {
  return value.replace(/[^A-Za-z0-9._:-]/g, "-").slice(0, 96);
}

function nextTimestamp(value: string): string {
  return new Date(Date.parse(value) + 1).toISOString();
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
