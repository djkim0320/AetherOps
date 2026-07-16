import { describe, expect, it } from "vitest";
import {
  ContextCompiler,
  createContextPackPersistenceReceipt,
  STANDARD_CONTEXT_PROVIDER_CAPABILITY_RECEIPT,
  type ContextCompilerInput,
  type ContextRunState
} from "../../core/context/public.js";
import type { RunStateRevision } from "../../core/orchestration/runStateCapsule.js";
import { plannerToolInputContract } from "../../core/planning/plannerContextPack.js";
import { getToolDescriptor } from "../../core/tools/toolDescriptors.js";
import { createCanonicalRunFixture } from "../../../tests/fixtures/canonicalRunState.js";
import type { StorageWorkerClient } from "../runtime/storage/worker/typedRuntime.js";
import type { StorageContextPack, StorageRunStateRevision } from "../runtime/storage/v2/runStateTypes.js";
import type { StorageCheckpoint, StorageJob } from "../runtime/storage/v2/types.js";
import type { StorageLlmInvocation, StorageToolAttempt, StorageToolDecision } from "../runtime/storage/v2/traceTypes.js";
import { DEFAULT_CANONICAL_TASK_LIMITS } from "./durableCanonicalResearchSession.js";
import { durableJobRequestHash } from "./durableJobRequestHash.js";
import { assertDurableResumeSource } from "./durableResumeValidator.js";

describe("durable resume validation", () => {
  it.each([
    { label: "checkpoint project", checkpointProject: "project-other", sourceProject: "project-1", operation: "chat_reply" },
    { label: "source project", checkpointProject: "project-1", sourceProject: "project-other", operation: "chat_reply" },
    { label: "job kind", checkpointProject: "project-1", sourceProject: "project-1", operation: "research_loop" }
  ])("rejects a mismatched $label", async ({ checkpointProject, sourceProject, operation }) => {
    const client = storageClient(checkpoint(checkpointProject), job(sourceProject, operation));
    await expect(assertDurableResumeSource(client, resumeInput())).rejects.toThrow(/committed checkpoint/);
  });
  it("accepts a committed checkpoint from the same project and kind", async () => {
    await expect(assertDurableResumeSource(storageClient(checkpoint("project-1"), job("project-1", "chat_reply")), resumeInput())).resolves.toBeUndefined();
  });
  it("rejects an older checkpoint when a newer committed checkpoint exists", async () => {
    const selected = checkpoint("project-1");
    const latest = { ...selected, id: "checkpoint-2", checkpointKey: "checkpoint-key-2" };
    await expect(assertDurableResumeSource(storageClient(selected, job("project-1", "chat_reply"), latest), resumeInput())).rejects.toThrow(
      /committed checkpoint/
    );
  });
  it("rejects resume while a prior tool attempt has no terminal receipt", async () => {
    const pending = toolAttempt("running");
    await expect(
      assertDurableResumeSource(storageClient(checkpoint("project-1"), job("project-1", "chat_reply"), undefined, [pending]), resumeInput())
    ).rejects.toThrow(/no durable terminal receipt/);
  });
  it("fails closed when a prior LLM invocation has no durable terminal receipt", async () => {
    await expect(
      assertDurableResumeSource(
        storageClient(checkpoint("project-1"), job("project-1", "chat_reply"), undefined, [], [], undefined, undefined, [runningLlmInvocation()]),
        resumeInput()
      )
    ).rejects.toMatchObject({ code: "NOT_READY", message: expect.stringMatching(/PENDING_EXTERNAL_SIDE_EFFECT.*no durable terminal receipt/i) });
  });
  it.each([
    { label: "response loss", status: "failed" as const, effects: ["filesystem" as const] },
    { label: "process interruption", status: "interrupted" as const, effects: ["process" as const] },
    { label: "completed without postcondition", status: "completed" as const, effects: ["filesystem" as const] }
  ])("rejects a vnext mutating attempt after $label", async ({ status, effects }) => {
    const attempt = vnextToolAttempt(status, effects);
    await expect(
      assertDurableResumeSource(storageClient(checkpoint("project-1"), job("project-1", "chat_reply"), undefined, [attempt]), resumeInput())
    ).rejects.toThrow(/ambiguous external side effect/i);
  });
  it("accepts a completed network-only observation without a postcondition receipt", async () => {
    const attempt = vnextToolAttempt("completed", ["network"]);
    await expect(
      assertDurableResumeSource(storageClient(checkpoint("project-1"), job("project-1", "chat_reply"), undefined, [attempt]), resumeInput())
    ).resolves.toBeUndefined();
  });

  it("rejects a completed attempt whose active descriptor version changed", async () => {
    const attempt = { ...vnextToolAttempt("completed", ["network"]), descriptorVersion: "stale-version" };
    await expect(
      assertDurableResumeSource(storageClient(checkpoint("project-1"), job("project-1", "chat_reply"), undefined, [attempt]), resumeInput())
    ).rejects.toMatchObject({ code: "NOT_READY" });
  });

  it("rejects unavailable selected tools and stale memory from the last persisted ContextPack", async () => {
    const state = canonicalResearchState();
    const source = researchJob();
    const unavailable = await contextPackReceipt({ toolName: "RemovedTool", staleMemory: false });
    await expect(
      assertDurableResumeSource(storageClient(checkpoint("project-1"), source, undefined, [], [], state, unavailable), researchResumeInput())
    ).rejects.toThrow(/no longer available/i);
    const stale = await contextPackReceipt({ toolName: "WebFetchTool", staleMemory: true });
    await expect(
      assertDurableResumeSource(storageClient(checkpoint("project-1"), source, undefined, [], [], state, stale), researchResumeInput())
    ).rejects.toThrow(/stale selected memory/i);
  });

  it("blocks exhausted canonical budgets and accepts a current catalog/context receipt", async () => {
    const source = researchJob();
    const current = await contextPackReceipt({ toolName: "WebFetchTool", staleMemory: false });
    await expect(
      assertDurableResumeSource(storageClient(checkpoint("project-1"), source, undefined, [], [], canonicalResearchState(), current), researchResumeInput())
    ).resolves.toBeUndefined();
    await expect(
      assertDurableResumeSource(
        storageClient(checkpoint("project-1"), source, undefined, [], [], canonicalResearchState(), current, [exhaustedLlmInvocation()]),
        researchResumeInput()
      )
    ).rejects.toMatchObject({ code: "NOT_READY" });
  });

  it("rejects a selected tool whose input contract changed without a version bump", async () => {
    const source = researchJob();
    const stale = await contextPackReceipt({ toolName: "WebFetchTool", staleMemory: false, inputContractHash: "f".repeat(64) });
    await expect(
      assertDurableResumeSource(storageClient(checkpoint("project-1"), source, undefined, [], [], canonicalResearchState(), stale), researchResumeInput())
    ).rejects.toThrow(/input contract/i);
  });

  it("accepts only a direct interrupted root before revision zero for checkpoint-free bootstrap", async () => {
    await expect(assertDurableResumeSource(bootstrapStorageClient(), bootstrapInput())).resolves.toBeUndefined();
  });

  it("blocks checkpoint-free bootstrap when an LLM process may already have run", async () => {
    await expect(
      assertDurableResumeSource(bootstrapStorageClient(undefined, undefined, false, undefined, [runningLlmInvocation()]), bootstrapInput())
    ).rejects.toMatchObject({
      code: "NOT_READY",
      message: expect.stringMatching(/PENDING_EXTERNAL_SIDE_EFFECT/i)
    });
  });

  it.each([0, 1] as const)("accepts a direct interrupted root after safe canonical revision %i", async (revision) => {
    await expect(
      assertDurableResumeSource(bootstrapStorageClient(researchFixture.revision(revision, "job-source")), bootstrapInput())
    ).resolves.toBeUndefined();
  });

  it("validates a checkpoint-free root ContextPack before authorizing bootstrap resume", async () => {
    const state = researchFixture.revision(1, "job-source");
    const stale = await contextPackReceipt({ toolName: "DataAnalysisTool", staleMemory: true });
    await expect(assertDurableResumeSource(bootstrapStorageClient(state, undefined, false, stale), bootstrapInput())).rejects.toThrow(/stale selected memory/i);
    const unavailable = await contextPackReceipt({ toolName: "RemovedTool", staleMemory: false });
    await expect(assertDurableResumeSource(bootstrapStorageClient(state, undefined, false, unavailable), bootstrapInput())).rejects.toThrow(
      /no longer available/i
    );
  });

  it.each([
    { label: "existing canonical state", existingState: { revision: 0 }, checkpointRow: undefined, mutate: false },
    { label: "an available checkpoint", existingState: undefined, checkpointRow: checkpoint("project-1"), mutate: false },
    { label: "a mutated anchor", existingState: undefined, checkpointRow: undefined, mutate: true }
  ])("rejects checkpoint-free bootstrap with $label", async ({ existingState, checkpointRow, mutate }) => {
    await expect(assertDurableResumeSource(bootstrapStorageClient(existingState, checkpointRow, mutate), bootstrapInput())).rejects.toThrow();
  });

  it("rejects a research resume when a lineage job lacks its frozen engineering baseline", async () => {
    const source = researchJob();
    source.payload = { kind: "research_loop", projectRevision: 1, request: { action: "start" } };
    await expect(
      assertDurableResumeSource(storageClient(checkpoint("project-1"), source, undefined, [], [], canonicalResearchState()), researchResumeInput())
    ).rejects.toMatchObject({ code: "NOT_READY", message: expect.stringMatching(/missing.*engineering baseline binding/i) });
  });

  it("rejects a checkpoint resume that changes the frozen engineering baseline", async () => {
    const changed = { ...researchResumeInput(), payload: { action: "resume", engineeringBaseline: baselineBinding() } };
    await expect(
      assertDurableResumeSource(storageClient(checkpoint("project-1"), researchJob(), undefined, [], [], canonicalResearchState()), changed)
    ).rejects.toMatchObject({ code: "CONFLICT", message: expect.stringMatching(/change.*engineering configuration baseline/i) });
  });

  it("rejects a checkpoint-free resume that changes the root engineering baseline", async () => {
    const changed = { ...bootstrapInput(), payload: { action: "resume", engineeringBaseline: baselineBinding() } };
    await expect(assertDurableResumeSource(bootstrapStorageClient(), changed)).rejects.toMatchObject({
      code: "CONFLICT",
      message: expect.stringMatching(/change.*engineering configuration baseline/i)
    });
  });
});

function baselineBinding() {
  return { id: "baseline-1", revision: 1, contentHash: "a".repeat(64) };
}

function storageClient(
  checkpointRow: StorageCheckpoint,
  jobRow: StorageJob,
  latestCheckpoint: StorageCheckpoint | undefined = checkpointRow,
  attempts: StorageToolAttempt[] = [],
  decisions: StorageToolDecision[] = attempts.map(toolDecision),
  runState?: StorageRunStateRevision,
  contextPackRow?: StorageContextPack,
  llmInvocations: StorageLlmInvocation[] = []
): StorageWorkerClient {
  const selectedCheckpoint =
    jobRow.operation === "research_loop"
      ? {
          ...checkpointRow,
          data: {
            ...(recordValue(checkpointRow.data) ?? {}),
            engineeringBaseline: null,
            ...(contextPackRow ? { canonicalContextPackId: contextPackRow.id } : {})
          }
        }
      : checkpointRow;
  const selectedLatest = latestCheckpoint?.id === checkpointRow.id ? selectedCheckpoint : latestCheckpoint;
  return {
    request: (command: { name: string }) =>
      Promise.resolve(
        command.name === "checkpoint.get"
          ? selectedCheckpoint
          : command.name === "checkpoint.latestCommittedForJob"
            ? selectedLatest
            : command.name === "runState.latest" || command.name === "runState.latestForJob"
              ? runState
              : command.name === "contextPack.latest" || command.name === "contextPack.latestForJob" || command.name === "contextPack.get"
                ? contextPackRow
                : command.name === "trace.llm.listJob"
                  ? llmInvocations
                  : command.name === "trace.attempt.listJob"
                    ? attempts
                    : command.name === "trace.decision.listJob"
                      ? decisions
                      : command.name === "job.get"
                        ? jobRow
                        : undefined
      )
  } as unknown as StorageWorkerClient;
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function resumeInput() {
  return {
    projectId: "project-1",
    kind: "chat_reply" as const,
    projectRevision: 2,
    idempotencyKey: "resume-key",
    resumesJobId: "job-source",
    resumeCheckpointId: "checkpoint-1"
  };
}

function bootstrapInput() {
  return {
    projectId: "project-1",
    kind: "research_loop" as const,
    projectRevision: 2,
    idempotencyKey: "bootstrap-key",
    resumesJobId: "job-source",
    requestedCapabilities: { agent: true, engineering: false, search: false },
    effectiveCapabilities: { agent: true, engineering: false, search: false },
    toolPolicy: { allowCodexCli: false, sourceAccess: { mode: "offline" as const } },
    payload: { action: "resume", engineeringBaseline: null }
  };
}

function researchResumeInput() {
  return {
    projectId: "project-1",
    kind: "research_loop" as const,
    projectRevision: 2,
    idempotencyKey: "research-resume-key",
    resumesJobId: "job-source",
    resumeCheckpointId: "checkpoint-1",
    requestedCapabilities: { agent: true, engineering: false, search: true },
    effectiveCapabilities: { agent: true, engineering: false, search: true },
    toolPolicy: { allowCodexCli: false, sourceAccess: { mode: "discovery" as const, allowedDomains: [] } },
    payload: { action: "resume", engineeringBaseline: null }
  };
}

function bootstrapStorageClient(
  existingState?: unknown,
  checkpointRow?: StorageCheckpoint,
  mutateAnchor = false,
  contextPackRow?: StorageContextPack,
  llmInvocations: StorageLlmInvocation[] = []
): StorageWorkerClient {
  const source = job("project-1", "research_loop");
  const anchor = initializationAnchor();
  source.requestedCapabilities = { agent: true, engineering: false, search: false };
  source.effectiveCapabilities = { agent: true, engineering: false, search: false };
  source.toolPolicy = { allowCodexCli: false, sourceAccess: { mode: "offline" } };
  source.payload = {
    kind: "research_loop",
    projectRevision: 1,
    request: {
      action: "start",
      engineeringBaseline: null,
      canonicalInitializationAnchor: mutateAnchor ? { ...anchor, projectId: "project-mutated" } : anchor
    }
  };
  return {
    request: (command: { name: string }) =>
      Promise.resolve(
        command.name === "job.get"
          ? source
          : command.name === "checkpoint.latestCommittedForJob"
            ? checkpointRow
            : command.name === "runState.latest" || command.name === "runState.latestForJob"
              ? existingState
              : command.name === "contextPack.latest" || command.name === "contextPack.latestForJob"
                ? contextPackRow
                : command.name === "trace.llm.listJob"
                  ? llmInvocations
                  : command.name === "trace.attempt.listJob"
                    ? []
                    : undefined
      )
  } as unknown as StorageWorkerClient;
}

function initializationAnchor() {
  const body = {
    schemaVersion: 1 as const,
    projectId: "project-1",
    taskSource: { project: { id: "project-1", goal: "Recover root intent.", scope: "Local bootstrap.", budget: "Bounded." } },
    immutablePolicy: {
      requestedCapabilities: { agent: true, engineering: false, search: false },
      effectiveCapabilities: { agent: true, engineering: false, search: false },
      toolPolicy: { allowCodexCli: false, sourceAccess: { mode: "offline" as const } }
    },
    taskLimits: DEFAULT_CANONICAL_TASK_LIMITS
  };
  return { ...body, contentHash: durableJobRequestHash(body) };
}

function checkpoint(projectId: string): StorageCheckpoint {
  return {
    id: "checkpoint-1",
    projectId,
    jobId: "job-source",
    step: "EXECUTE_TOOLS",
    checkpointKey: "checkpoint-key",
    status: "committed",
    data: { phase: "step_completed" },
    createdAt: "2026-07-14T00:00:00.000Z",
    committedAt: "2026-07-14T00:00:00.000Z"
  };
}

function job(projectId: string, operation: string): StorageJob {
  return {
    id: "job-source",
    projectId,
    operation,
    status: "interrupted",
    priority: 0,
    attempt: 1,
    leaseGeneration: 1,
    payload: null,
    idempotencyKey: "source-key",
    queuedAt: "2026-07-14T00:00:00.000Z",
    startedAt: "2026-07-14T00:00:00.000Z",
    createdAt: "2026-07-14T00:00:00.000Z",
    updatedAt: "2026-07-14T00:00:00.000Z"
  };
}

function researchJob(): StorageJob {
  return {
    ...job("project-1", "research_loop"),
    requestedCapabilities: { agent: true, engineering: false, search: true },
    effectiveCapabilities: { agent: true, engineering: false, search: true },
    toolPolicy: { allowCodexCli: false, sourceAccess: { mode: "discovery", allowedDomains: [] } },
    payload: { kind: "research_loop", projectRevision: 1, request: { action: "start", engineeringBaseline: null } }
  };
}

function toolAttempt(status: StorageToolAttempt["status"]): StorageToolAttempt {
  return {
    id: "attempt-1",
    projectId: "project-1",
    jobId: "job-source",
    decisionId: "decision-1",
    ordinal: 0,
    status,
    inputHash: "input-hash",
    dependsOnAttemptIds: [],
    queuedAt: "2026-07-14T00:00:00.000Z"
  };
}

function vnextToolAttempt(
  status: StorageToolAttempt["status"],
  descriptorSideEffects: NonNullable<StorageToolAttempt["descriptorSideEffects"]>
): StorageToolAttempt {
  return {
    ...toolAttempt(status),
    traceVersion: 1,
    traceAvailability: "vnext",
    descriptorVersion: "1",
    descriptorSideEffects,
    sideEffectKey: descriptorSideEffects.some((effect) => effect === "filesystem" || effect === "process") ? "side-effect-1" : undefined,
    idempotencyKey: "idempotency-1"
  };
}

function toolDecision(attempt: StorageToolAttempt): StorageToolDecision {
  return {
    id: attempt.decisionId,
    projectId: attempt.projectId,
    jobId: attempt.jobId,
    toolName: "WebFetchTool",
    purpose: "Verify resume trace catalog binding.",
    expectedOutcome: "One verified network observation.",
    rawSelection: {},
    userPinned: false,
    policyStatus: "accepted",
    createdAt: "2026-07-14T00:00:00.000Z"
  };
}

const researchFixture = createCanonicalRunFixture({
  projectId: "project-1",
  runId: "run:job-source",
  taskId: "task-resume-validator",
  createdAt: "2026-07-14T00:00:00.000Z"
});

function canonicalResearchState(): StorageRunStateRevision {
  return researchFixture.revision(1, "job-source");
}

function exhaustedLlmInvocation(): StorageLlmInvocation {
  return {
    id: "llm-budget-exhausted",
    projectId: "project-1",
    jobId: "job-source",
    model: "deterministic-budget-fixture",
    reasoningEffort: "none",
    promptVersion: "budget-test-v1",
    schemaVersion: "budget-test-v1",
    promptHash: "a".repeat(64),
    latencyMs: 0,
    repairCount: 0,
    status: "completed",
    startedAt: "2026-07-14T00:00:00.000Z",
    completedAt: "2026-07-14T00:00:00.000Z",
    data: {
      accounting: {
        version: 1,
        inputUnits: (canonicalResearchState().data as RunStateRevision).budgetLimits.maxInputTokens,
        outputUnits: 0,
        unit: "estimated_token",
        estimator: "utf8_bytes_div_4_ceil_v1",
        monetaryCost: { availability: "unavailable", policy: "unmetered_codex_oauth_v1" }
      }
    }
  };
}

function runningLlmInvocation(): StorageLlmInvocation {
  return {
    id: "llm-running",
    projectId: "project-1",
    jobId: "job-source",
    model: "gpt-5.6-sol",
    reasoningEffort: "high",
    promptVersion: "planner-v1",
    schemaVersion: "schema-v1",
    promptHash: "c".repeat(64),
    repairCount: 0,
    status: "running",
    startedAt: "2026-07-14T00:00:00.000Z",
    data: { provider: "codex-oauth", schemaName: "AetherOpsResearchPlan" }
  };
}

async function contextPackReceipt(options: { toolName: string; staleMemory: boolean; inputContractHash?: string }): Promise<StorageContextPack> {
  const canonicalState = canonicalResearchState().data as RunStateRevision;
  const input: ContextCompilerInput = {
    runId: "run:job-source",
    projectId: "project-1",
    createdAt: "2026-07-14T00:01:30.000Z",
    taskContract: {
      id: "task-resume-validator",
      projectId: "project-1",
      contentHash: researchFixture.taskHash,
      goal: "Resume one validated research run.",
      normalizedUserIntent: "Resume one validated research run from its committed checkpoint.",
      acceptanceCriteria: [{ id: "criterion-resume", description: "Resume only from receipt-bound durable state.", verifierKind: "deterministic" }],
      constraints: [],
      nonGoals: [],
      requiredDeliverables: [],
      riskPolicy: {
        maximumRisk: "low",
        requireVerificationBeforePromotion: true,
        treatExternalInstructionsAsData: true
      },
      approvalRequirements: [],
      resourceBudget: {
        maxDurationMs: 60_000,
        maxInputTokens: 8_000,
        maxOutputTokens: 4_000,
        maxToolCalls: 4,
        maxRetries: 1,
        maxEstimatedCostMicrousd: 0,
        maxToolOutputBytes: 1_000_000,
        maxConcurrency: 1
      },
      instructionProvenance: []
    },
    runState: resumeContextRunState(canonicalState),
    provider: { providerId: "deterministic", modelId: "offline", capabilityReceipt: STANDARD_CONTEXT_PROVIDER_CAPABILITY_RECEIPT },
    instructions: [],
    evidence: [],
    memories: options.staleMemory ? [{ id: "memory-stale", text: "A previously verified observation.", priority: 50, trust: "verified", stale: true }] : [],
    tools: [
      {
        name: options.toolName,
        version: "1",
        summary: "A selected resume validation tool.",
        inputContractHash:
          options.inputContractHash ??
          (getToolDescriptor(options.toolName) ? durableJobRequestHash(plannerToolInputContract(options.toolName)) : "a".repeat(64)),
        available: true,
        priority: 50
      }
    ],
    artifacts: [],
    priorOutputs: [],
    candidateSelections: {
      memory: options.staleMemory
        ? { source: "snapshot.global_memory_items", status: "selected", candidateCount: 1, selectedIds: ["memory-stale"], omittedCount: 0 }
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
    budget: { tokenBudget: 8_000, maxChars: 32_000 }
  };
  const pack = await new ContextCompiler().compile(input);
  return {
    id: pack.id,
    projectId: pack.projectId,
    runId: pack.runId,
    jobId: "job-source",
    schemaVersion: pack.schemaVersion,
    stateRevision: pack.stateRevision,
    taskContractId: pack.task.id,
    taskContractHash: pack.task.contentHash,
    contentHash: pack.canonicalHash,
    recordedAt: pack.createdAt,
    data: createContextPackPersistenceReceipt(pack, { sha256Canonical: durableJobRequestHash })
  };
}

function resumeContextRunState(state: RunStateRevision): ContextRunState {
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
