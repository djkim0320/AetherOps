import { describe, expect, it } from "vitest";
import { ContextCompilerError, STANDARD_CONTEXT_PROVIDER_CAPABILITY_RECEIPT, type ContextPack } from "../../core/context/public.js";
import type { RunStateRevision } from "../../core/orchestration/runStateCapsule.js";
import type { TaskContract } from "../../core/orchestration/taskContract.js";
import { durableJobRequestHash } from "./durableJobRequestHash.js";
import { CanonicalRunRuntime } from "./canonicalRunRuntime.js";
import {
  CanonicalRunRuntimeError,
  type CanonicalRunGateway,
  type CanonicalRunOwner,
  type CanonicalRunPolicy,
  type CompilePlanningContextInput,
  type PrepareCanonicalRunInput,
  type RecordCanonicalBlockerInput,
  type RecordCanonicalCheckpointInput
} from "./canonicalRunTypes.js";
import { snapshotFixture, specificationFixture } from "./test/canonicalRunRuntimeFixtures.js";

const T0 = "2026-07-14T00:00:00.000Z";
const T1 = "2026-07-14T00:00:01.000Z";
const T2 = "2026-07-14T00:00:02.000Z";
const T3 = "2026-07-14T00:00:03.000Z";
const T4 = "2026-07-14T00:00:04.000Z";
const ROOT_OWNER = { projectId: "project-1", runId: "run:job-root", jobId: "job-root" } satisfies CanonicalRunOwner;
const hasher = { sha256Canonical: durableJobRequestHash };

describe("CanonicalRunRuntime", () => {
  it("idempotently persists one complete contract and rev0 -> active rev1", async () => {
    const gateway = new DeterministicCanonicalRunGateway();
    const runtime = new CanonicalRunRuntime({ gateway, hasher });
    const first = await runtime.prepareInitialRun(prepareInput());
    const replay = await runtime.prepareInitialRun(prepareInput());

    expect(first).toEqual(replay);
    expect(first.taskContract.acceptanceCriteria.length).toBeGreaterThan(2);
    expect(first.taskContract.requiredDeliverables).toHaveLength(1);
    expect(first.taskContract.resourceBudget.maxConcurrency).toBe(4);
    expect(first.state.revision).toBe(1);
    expect(first.state.status).toBe("running");
    expect(first.state.taskGraph.nodes).toEqual([{ id: "legacy-research-loop", kind: "legacy_research_loop", dependencyNodeIds: [], terminal: true }]);
    expect(gateway.commits.map((item) => item.revision)).toEqual([0, 1]);
  });

  it("binds the complete project brief and research input to instruction provenance", async () => {
    const firstSnapshot = snapshotFixture();
    const firstRuntime = new CanonicalRunRuntime({ gateway: new DeterministicCanonicalRunGateway(), hasher });
    const first = await firstRuntime.prepareInitialRun(prepareInput({ snapshot: firstSnapshot }));
    const projectProvenance = first.taskContract.instructionProvenance.find((item) => item.instructionId === "instruction:project-brief");
    const inputProvenance = first.taskContract.instructionProvenance.find((item) => item.instructionId === "instruction:research-input");

    expect(projectProvenance).toMatchObject({
      source: "user",
      contentHash: durableJobRequestHash({
        id: firstSnapshot.project.id,
        goal: firstSnapshot.project.goal,
        scope: firstSnapshot.project.scope,
        budget: firstSnapshot.project.budget
      })
    });
    const researchInput = firstSnapshot.researchInputs[0]!;
    expect(inputProvenance).toMatchObject({
      source: "user",
      contentHash: durableJobRequestHash({
        id: researchInput.id,
        projectId: researchInput.projectId,
        researchQuestion: researchInput.researchQuestion,
        constraints: researchInput.constraints,
        expectedOutputs: researchInput.expectedOutputs,
        createdAt: researchInput.createdAt
      })
    });

    const changedSnapshot = snapshotFixture({
      project: { ...firstSnapshot.project, scope: "A changed, still bounded local scope." },
      researchInputs: [{ ...firstSnapshot.researchInputs[0]!, constraints: ["Use a changed receipt-only constraint."] }]
    });
    const changedRuntime = new CanonicalRunRuntime({ gateway: new DeterministicCanonicalRunGateway(), hasher });
    const changed = await changedRuntime.prepareInitialRun(prepareInput({ snapshot: changedSnapshot }));
    expect(changed.taskContract.instructionProvenance.find((item) => item.instructionId === "instruction:project-brief")?.contentHash).not.toBe(
      projectProvenance?.contentHash
    );
    expect(changed.taskContract.instructionProvenance.find((item) => item.instructionId === "instruction:research-input")?.contentHash).not.toBe(
      inputProvenance?.contentHash
    );
    expect(changed.taskContract.contentHash).not.toBe(first.taskContract.contentHash);
  });

  it("replays initial preparation after mutable snapshot growth without changing the durable task", async () => {
    const gateway = new DeterministicCanonicalRunGateway();
    const runtime = new CanonicalRunRuntime({ gateway, hasher });
    const initialSnapshot = snapshotFixture({ specifications: [] });
    const first = await runtime.prepareInitialRun(prepareInput({ snapshot: initialSnapshot, specification: undefined }));
    const grown = snapshotFixture({ specifications: [specificationFixture()] });
    const terminalPolicy = policyFixture();
    terminalPolicy.externalSideEffects = [{ attemptId: "attempt-terminal", status: "committed" }];
    const replay = await runtime.prepareInitialRun(prepareInput({ snapshot: grown, specification: specificationFixture(), policy: terminalPolicy }));

    expect(replay.taskContract.contentHash).toBe(first.taskContract.contentHash);
    expect(replay.state.stateHash).toBe(first.state.stateHash);
    expect(gateway.commits).toHaveLength(2);
  });

  it("produces an exact ContextPack across forced resets and a distinct provider-bound pack after provider swap", async () => {
    const gateway = new DeterministicCanonicalRunGateway();
    const runtime = new CanonicalRunRuntime({ gateway, hasher });
    const { state } = await runtime.prepareInitialRun(prepareInput());
    const first = await runtime.compilePlanningContext(compileInput(state, { runtime: { forcedResetGeneration: 1 } }));
    const reset = await runtime.compilePlanningContext(compileInput(state, { runtime: { forcedResetGeneration: 99 } }));
    const swapped = await runtime.compilePlanningContext(
      compileInput(state, {
        provider: {
          providerId: "provider-neutral",
          modelId: "frontier-model",
          capabilityReceipt: STANDARD_CONTEXT_PROVIDER_CAPABILITY_RECEIPT
        },
        runtime: { forcedResetGeneration: 2 }
      })
    );

    expect(reset).toEqual(first);
    expect(reset.canonicalHash).toBe(first.canonicalHash);
    expect(swapped.providerInput).toBe(first.providerInput);
    expect(swapped.canonicalHash).not.toBe(first.canonicalHash);
    expect(first.selectedToolSpecVersions).toEqual([{ name: "DataAnalysisTool", version: "1", inputContractHash: "a".repeat(64) }]);
    expect(first.artifactIds).toEqual(["artifact-1"]);
    expect(first.evidenceIds).toEqual(["evidence-1"]);
    expect(first.runState).toMatchObject({
      runId: state.runId,
      projectId: state.projectId,
      stateHash: state.stateHash,
      taskContractId: state.taskContractId,
      taskContractHash: state.taskContractHash,
      taskGraph: { schemaVersion: 1, graphId: state.taskGraph.graphId, contentHash: state.taskGraph.contentHash },
      currentNodeId: state.currentNodeId,
      pendingNodeIds: state.pendingNodeIds,
      budgetLimits: state.budgetLimits,
      budgetUsage: state.budgetUsage
    });
    expect(first.providerInput).toContain(state.taskGraph.graphId);
    expect(first.providerInput).toContain('"budgetUsage"');
  });

  it("uses the resolved root run with a new resume job writer", async () => {
    const gateway = new DeterministicCanonicalRunGateway();
    const runtime = new CanonicalRunRuntime({ gateway, hasher });
    const { state } = await runtime.prepareInitialRun(prepareInput());
    const resumedOwner = { ...ROOT_OWNER, jobId: "job-resume" };
    const current = await runtime.readCurrentRun(resumedOwner);
    const pack = await runtime.compilePlanningContext(compileInput(state, { owner: resumedOwner, compiledAt: T2 }));

    expect(current.state.stateHash).toBe(state.stateHash);
    expect(current.taskContract.contentHash).toBe(state.taskContractHash);
    expect(pack.runId).toBe(ROOT_OWNER.runId);
    expect(gateway.contextWriters.at(-1)).toEqual(resumedOwner);
  });

  it("rejects stale planning state and insufficient critical-section budget", async () => {
    const gateway = new DeterministicCanonicalRunGateway();
    const runtime = new CanonicalRunRuntime({ gateway, hasher });
    const { state } = await runtime.prepareInitialRun(prepareInput());

    await expect(runtime.compilePlanningContext(compileInput(state, { expectedState: { revision: 0, stateHash: "0".repeat(64) } }))).rejects.toMatchObject<
      Partial<CanonicalRunRuntimeError>
    >({ code: "CANONICAL_STATE_STALE" });
    await expect(runtime.compilePlanningContext(compileInput(state, { budget: { tokenBudget: 128, maxChars: 512 } }))).rejects.toBeInstanceOf(
      ContextCompilerError
    );
  });

  it("advances checkpoint revisions once, returns exact replay, and rejects stale or cross-project writes", async () => {
    const gateway = new DeterministicCanonicalRunGateway();
    const runtime = new CanonicalRunRuntime({ gateway, hasher });
    const { state } = await runtime.prepareInitialRun(prepareInput());
    const checkpoint = checkpointInput(state);
    const advanced = await runtime.recordCheckpoint(checkpoint);
    const replay = await runtime.recordCheckpoint(checkpoint);

    expect(advanced.revision).toBe(2);
    expect(advanced.parentRevisionHash).toBe(state.stateHash);
    expect(advanced.decisions).toEqual([
      {
        decisionId: `checkpoint:${durableJobRequestHash({ checkpointId: "checkpoint-1" }).slice(0, 48)}`,
        decisionReceiptId: "step-receipt-1",
        recordedAt: T1
      }
    ]);
    expect(replay).toEqual(advanced);
    expect(gateway.commits.map((item) => item.revision)).toEqual([0, 1, 2]);
    await expect(runtime.prepareInitialRun(prepareInput())).resolves.toEqual({
      taskContract: expect.objectContaining({ contentHash: advanced.taskContractHash }),
      state: advanced
    });

    await expect(runtime.recordCheckpoint({ ...checkpoint, checkpointId: "checkpoint-2", stepReceiptId: "step-receipt-2" })).rejects.toMatchObject<
      Partial<CanonicalRunRuntimeError>
    >({ code: "CANONICAL_STATE_STALE" });
    await expect(runtime.recordCheckpoint({ ...checkpoint, owner: { ...ROOT_OWNER, projectId: "project-other" } })).rejects.toMatchObject<
      Partial<CanonicalRunRuntimeError>
    >({ code: "CANONICAL_RUN_OWNERSHIP_MISMATCH" });
  });

  it("records one authorization when a paused or interrupted predecessor has no canonical blockers", async () => {
    const gateway = new DeterministicCanonicalRunGateway();
    const runtime = new CanonicalRunRuntime({ gateway, hasher });
    const prepared = await runtime.prepareInitialRun(prepareInput());
    const checkpointed = await runtime.recordCheckpoint(checkpointInput(prepared.state));
    const resumeOwner = { ...ROOT_OWNER, jobId: "job-resume-paused" };
    const resume = {
      owner: resumeOwner,
      expectedState: { revision: checkpointed.revision, stateHash: checkpointed.stateHash },
      predecessorCheckpointId: "checkpoint-1",
      predecessorCheckpointReceiptId: "step-receipt-1",
      resumeAuthorizationReceiptId: resumeOwner.jobId,
      blockerClearances: [],
      recordedAt: T2
    };

    const plan = await runtime.prepareResumeRevision(resume);
    expect(plan.revisions).toHaveLength(1);
    expect(plan.finalState).toMatchObject({ status: "running", blockedReasons: [] });
    const resumed = await runtime.recordResume(resume);
    expect(resumed.decisions.at(-1)?.decisionReceiptId).toBe(resumeOwner.jobId);
    await expect(runtime.prepareResumeRevision(resume)).resolves.toMatchObject({ exactReplay: true, revisions: [] });
  });

  it("fails closed while an external side-effect attempt lacks a terminal receipt", async () => {
    const gateway = new DeterministicCanonicalRunGateway();
    const runtime = new CanonicalRunRuntime({ gateway, hasher });
    const input = prepareInput();
    input.policy.externalSideEffects = [{ attemptId: "attempt-pending", status: "running" }];
    await expect(runtime.prepareInitialRun(input)).rejects.toMatchObject<Partial<CanonicalRunRuntimeError>>({
      code: "PENDING_EXTERNAL_SIDE_EFFECT"
    });
    expect(gateway.commits).toHaveLength(0);
  });

  it("plans and records node completion plus terminal acceptance as two deterministic revisions", async () => {
    const gateway = new DeterministicCanonicalRunGateway();
    const runtime = new CanonicalRunRuntime({ gateway, hasher });
    const prepared = await runtime.prepareInitialRun(prepareInput());
    const input = completionInput(prepared.taskContract, prepared.state);
    const plan = await runtime.prepareTerminalRevisions({ ...input, outcome: "completed" });

    expect(plan.expectedRevision).toBe(1);
    expect(plan.revisions.map((state) => [state.revision, state.status])).toEqual([
      [2, "awaiting_completion"],
      [3, "completed"]
    ]);
    expect(gateway.commits).toHaveLength(2);

    const completed = await runtime.recordCompletion(input);
    expect(completed.status).toBe("completed");
    expect(completed.completedNodeReceipts[0]?.artifactRefs).toEqual(input.artifactRefs);
    expect(completed.completedNodeReceipts[0]?.evidenceRefs).toEqual(input.evidenceRefs);
    expect(completed.terminalReceipt?.outcome).toBe("completed");
    expect(gateway.commits.map((state) => state.revision)).toEqual([0, 1, 2, 3]);

    const replay = await runtime.prepareTerminalRevisions({ ...input, outcome: "completed" });
    expect(replay).toMatchObject({ expectedRevision: 3, revisions: [], exactReplay: true, finalState: completed });
    await expect(runtime.recordCompletion(input)).resolves.toEqual(completed);
    expect(gateway.commits).toHaveLength(4);
  });

  it("recovers the remaining terminal revision after a crash between node and run receipts", async () => {
    const gateway = new DeterministicCanonicalRunGateway();
    const runtime = new CanonicalRunRuntime({ gateway, hasher });
    const prepared = await runtime.prepareInitialRun(prepareInput());
    const input = completionInput(prepared.taskContract, prepared.state);
    gateway.failRevisionOnce = 3;

    await expect(runtime.recordCompletion(input)).rejects.toThrow("injected revision failure");
    expect((await runtime.readCurrentRun(ROOT_OWNER)).state.status).toBe("awaiting_completion");
    const recoveredPlan = await runtime.prepareTerminalRevisions({ ...input, outcome: "completed" });
    expect(recoveredPlan.revisions).toHaveLength(1);
    expect(recoveredPlan.revisions[0]?.status).toBe("completed");
    await expect(runtime.recordCompletion(input)).resolves.toMatchObject({ status: "completed", revision: 3 });
  });

  it("rejects missing acceptance verification, cross-project resources, and malformed hashes", async () => {
    const gateway = new DeterministicCanonicalRunGateway();
    const runtime = new CanonicalRunRuntime({ gateway, hasher });
    const prepared = await runtime.prepareInitialRun(prepareInput());
    const input = completionInput(prepared.taskContract, prepared.state);

    await expect(runtime.recordCompletion({ ...input, acceptanceVerifiers: input.acceptanceVerifiers.slice(1) })).rejects.toMatchObject<
      Partial<CanonicalRunRuntimeError>
    >({ code: "MISSING_ACCEPTANCE_VERIFIER" });
    await expect(runtime.recordCompletion({ ...input, artifactRefs: [{ ...input.artifactRefs[0]!, projectId: "project-other" }] })).rejects.toMatchObject<
      Partial<CanonicalRunRuntimeError>
    >({ code: "CANONICAL_RUN_OWNERSHIP_MISMATCH" });
    await expect(runtime.recordCompletion({ ...input, evidenceRefs: [{ ...input.evidenceRefs[0]!, contentHash: "not-a-hash" }] })).rejects.toMatchObject<
      Partial<CanonicalRunRuntimeError>
    >({ code: "INVALID_CANONICAL_RUN_INPUT" });
    expect(gateway.commits.map((state) => state.revision)).toEqual([0, 1]);
  });

  it("keeps ordinary job failure resumable and reserves terminal failure/cancellation for explicit dispositions", async () => {
    const blockedGateway = new DeterministicCanonicalRunGateway();
    const blockedRuntime = new CanonicalRunRuntime({ gateway: blockedGateway, hasher });
    const prepared = await blockedRuntime.prepareInitialRun(prepareInput());
    const checkpoint = await blockedRuntime.recordCheckpoint(checkpointInput(prepared.state));
    const blocker = blockerInput(checkpoint, { recordedAt: T2 });
    const firstBlocked = await blockedRuntime.recordResumableBlocker(blocker);
    const secondBlocker = blockerInput(firstBlocked, {
      reasonCode: "SECOND_RESUMABLE_FAILURE",
      sourceReceiptId: "job-settlement-receipt-2",
      recordedAt: T3
    });
    const blocked = await blockedRuntime.recordResumableBlocker(secondBlocker);
    expect(blocked.status).toBe("blocked");
    expect(blocked.terminalReceipt).toBeUndefined();
    const resumeOwner = { ...ROOT_OWNER, jobId: "job-resume-blocked" };
    await expect(blockedRuntime.prepareInitialRun(prepareInput({ owner: resumeOwner }))).resolves.toMatchObject({ state: blocked });
    await expect(blockedRuntime.recordResumableBlocker(blocker)).resolves.toEqual(blocked);
    const resume = {
      owner: resumeOwner,
      expectedState: { revision: blocked.revision, stateHash: blocked.stateHash },
      predecessorCheckpointId: "checkpoint-1",
      predecessorCheckpointReceiptId: "step-receipt-1",
      resumeAuthorizationReceiptId: resumeOwner.jobId,
      blockerClearances: [
        { sourceReceiptId: blocker.sourceReceiptId, dispositionReceiptId: resumeOwner.jobId },
        { sourceReceiptId: secondBlocker.sourceReceiptId, dispositionReceiptId: resumeOwner.jobId }
      ],
      recordedAt: T4
    };
    await expect(blockedRuntime.prepareResumeRevision({ ...resume, expectedState: { revision: 1, stateHash: "0".repeat(64) } })).rejects.toMatchObject<
      Partial<CanonicalRunRuntimeError>
    >({ code: "CANONICAL_STATE_STALE" });
    await expect(blockedRuntime.prepareResumeRevision({ ...resume, owner: { ...resumeOwner, projectId: "project-other" } })).rejects.toMatchObject<
      Partial<CanonicalRunRuntimeError>
    >({ code: "CANONICAL_RUN_OWNERSHIP_MISMATCH" });
    const resumePlan = await blockedRuntime.prepareResumeRevision(resume);
    expect(resumePlan.revisions).toHaveLength(5);
    expect(resumePlan.finalState).toMatchObject({ status: "running", blockedReasons: [] });
    const resumed = await blockedRuntime.recordResume(resume);
    expect(resumed.status).toBe("running");
    await expect(blockedRuntime.prepareResumeRevision(resume)).resolves.toMatchObject({ revisions: [], exactReplay: true, finalState: resumed });

    const failedGateway = new DeterministicCanonicalRunGateway();
    const failedRuntime = new CanonicalRunRuntime({ gateway: failedGateway, hasher });
    const failedPrepared = await failedRuntime.prepareInitialRun(prepareInput());
    const permanentFailure = {
      owner: ROOT_OWNER,
      expectedState: { revision: failedPrepared.state.revision, stateHash: failedPrepared.state.stateHash },
      reasonCode: "PERMANENT_POLICY_FAILURE",
      recordedAt: T1,
      terminalAuthorization: "explicit_permanent_failure" as const
    };
    await expect(failedRuntime.recordFailure({ ...permanentFailure, terminalAuthorization: "explicit_abort" })).rejects.toMatchObject<
      Partial<CanonicalRunRuntimeError>
    >({ code: "INVALID_CANONICAL_RUN_INPUT" });
    const failed = await failedRuntime.recordFailure(permanentFailure);
    expect(failed.status).toBe("failed");
    await expect(failedRuntime.recordFailure(permanentFailure)).resolves.toEqual(failed);

    const cancelledGateway = new DeterministicCanonicalRunGateway();
    const cancelledRuntime = new CanonicalRunRuntime({ gateway: cancelledGateway, hasher });
    const cancelledPrepared = await cancelledRuntime.prepareInitialRun(prepareInput());
    const cancelled = await cancelledRuntime.recordCancellation({
      owner: ROOT_OWNER,
      expectedState: { revision: cancelledPrepared.state.revision, stateHash: cancelledPrepared.state.stateHash },
      reasonCode: "EXPLICIT_USER_ABORT",
      recordedAt: T1,
      terminalAuthorization: "explicit_abort"
    });
    expect(cancelled.status).toBe("cancelled");
  });
});

class DeterministicCanonicalRunGateway implements CanonicalRunGateway {
  readonly commits: RunStateRevision[] = [];
  readonly contextWriters: CanonicalRunOwner[] = [];
  private readonly contracts = new Map<string, TaskContract>();
  private readonly revisions = new Map<string, RunStateRevision[]>();
  private readonly packs = new Map<string, ContextPack>();
  failRevisionOnce?: number;
  private failedInjectedRevision = false;

  async saveTaskContract(owner: CanonicalRunOwner, contract: TaskContract): Promise<unknown> {
    if (owner.projectId !== contract.projectId) throw new Error("task owner mismatch");
    const existing = this.contracts.get(contract.id);
    if (existing && existing.contentHash !== contract.contentHash) throw new Error("immutable task conflict");
    this.contracts.set(contract.id, existing ?? contract);
    return this.contracts.get(contract.id)!;
  }

  async getTaskContract(projectId: string, taskContractId: string): Promise<unknown | undefined> {
    const value = this.contracts.get(taskContractId);
    return value?.projectId === projectId ? value : undefined;
  }

  async latestRunState(owner: CanonicalRunOwner): Promise<unknown | undefined> {
    return this.revisions.get(owner.runId)?.at(-1);
  }

  async commitRunState(owner: CanonicalRunOwner, expectedRevision: number | null, revision: RunStateRevision): Promise<unknown> {
    if (this.failRevisionOnce === revision.revision && !this.failedInjectedRevision) {
      this.failedInjectedRevision = true;
      throw new Error("injected revision failure");
    }
    const values = this.revisions.get(owner.runId) ?? [];
    const existing = values.find((item) => item.revision === revision.revision);
    if (existing) {
      if (existing.stateHash !== revision.stateHash) throw new Error("immutable revision conflict");
      return existing;
    }
    const actual = values.at(-1)?.revision ?? null;
    if (actual !== expectedRevision) throw new Error(`stale revision ${String(expectedRevision)} != ${String(actual)}`);
    values.push(revision);
    this.revisions.set(owner.runId, values);
    this.commits.push(revision);
    return revision;
  }

  async saveContextPack(owner: CanonicalRunOwner, expectedRevision: number, pack: ContextPack): Promise<unknown> {
    const latest = this.revisions.get(owner.runId)?.at(-1);
    if (!latest || latest.revision !== expectedRevision) throw new Error("stale context revision");
    const existing = this.packs.get(pack.id);
    if (existing && existing.canonicalHash !== pack.canonicalHash) throw new Error("immutable context conflict");
    this.packs.set(pack.id, existing ?? pack);
    this.contextWriters.push({ ...owner });
    return this.packs.get(pack.id)!;
  }
}

function prepareInput(overrides: Partial<PrepareCanonicalRunInput> = {}): PrepareCanonicalRunInput {
  return {
    owner: ROOT_OWNER,
    rootJobId: "job-root",
    rootJobCreatedAt: T0,
    snapshot: snapshotFixture(),
    specification: specificationFixture(),
    policy: policyFixture(),
    taskLimits: {
      maxDurationMs: 600_000,
      maxInputTokens: 100_000,
      maxOutputTokens: 20_000,
      maxToolCalls: 32,
      maxRetries: 2,
      maxEstimatedCostMicrousd: 1_000_000,
      maxToolOutputBytes: 10_000_000,
      maxConcurrency: 4
    },
    preparedAt: T0,
    ...overrides
  };
}

function compileInput(state: RunStateRevision, overrides: Partial<CompilePlanningContextInput> = {}): CompilePlanningContextInput {
  return {
    owner: ROOT_OWNER,
    snapshot: snapshotFixture(),
    specification: specificationFixture(),
    iteration: 1,
    provider: { providerId: "codex-oauth", modelId: "gpt-5.6-sol", capabilityReceipt: STANDARD_CONTEXT_PROVIDER_CAPABILITY_RECEIPT },
    selectedTools: [
      {
        name: "DataAnalysisTool",
        version: "1",
        summary: "Validate evidence coverage deterministically.",
        inputContractHash: "a".repeat(64),
        requiredCapabilities: [],
        sideEffects: [],
        priority: 900
      }
    ],
    policyInstructions: [],
    evidence: [{ id: "evidence-1", projectId: ROOT_OWNER.projectId, text: "Verified fixture observation.", priority: 800, trust: "verified" }],
    artifactHandles: [{ artifactId: "artifact-1", projectId: ROOT_OWNER.projectId, kind: "dataset", sha256: "b".repeat(64), priority: 800, trust: "verified" }],
    memories: [],
    priorOutputs: [],
    candidateSelections: emptyCandidateSelections(),
    budget: { tokenBudget: 24_000, maxChars: 24_000 },
    expectedState: { revision: state.revision, stateHash: state.stateHash },
    compiledAt: T1,
    policy: policyFixture(),
    ...overrides
  };
}

function emptyCandidateSelections() {
  return {
    memory: {
      source: "snapshot.global_memory_items" as const,
      status: "empty" as const,
      candidateCount: 0,
      selectedIds: [],
      omittedCount: 0,
      emptyReason: "no_project_validated_candidates" as const
    },
    priorOutputs: {
      source: "snapshot.conversation_artifacts" as const,
      status: "empty" as const,
      candidateCount: 0,
      selectedIds: [],
      omittedCount: 0,
      emptyReason: "no_hash_bearing_conversation_artifacts" as const
    }
  };
}

function checkpointInput(state: RunStateRevision): RecordCanonicalCheckpointInput {
  return {
    owner: ROOT_OWNER,
    checkpointId: "checkpoint-1",
    stepReceiptId: "step-receipt-1",
    recordedAt: T1,
    expectedState: { revision: state.revision, stateHash: state.stateHash }
  };
}

function completionInput(contract: TaskContract, state: RunStateRevision) {
  const acceptanceVerifiers = contract.acceptanceCriteria.map((criterion) => ({
    criterionId: criterion.id,
    verifierReceiptId: `verify:${durableJobRequestHash(criterion.id).slice(0, 40)}`
  }));
  return {
    owner: ROOT_OWNER,
    expectedState: { revision: state.revision, stateHash: state.stateHash },
    artifactRefs: [
      {
        artifactId: "artifact-final",
        projectId: ROOT_OWNER.projectId,
        contentHash: "c".repeat(64),
        attestationId: "attestation-artifact-final",
        attestationHash: "e".repeat(64),
        promotionReceiptId: "promote-artifact-final"
      }
    ],
    evidenceRefs: [
      {
        evidenceId: "evidence-final",
        projectId: ROOT_OWNER.projectId,
        contentHash: "d".repeat(64),
        attestationId: "attestation-evidence-final",
        attestationHash: "f".repeat(64),
        verificationReceiptId: "verify-evidence-final"
      }
    ],
    nodeVerifierReceiptIds: acceptanceVerifiers.map((item) => item.verifierReceiptId),
    acceptanceVerifiers,
    completedAt: T1,
    terminatedAt: T2
  };
}

function blockerInput(state: RunStateRevision, overrides: Partial<RecordCanonicalBlockerInput> = {}): RecordCanonicalBlockerInput {
  return {
    owner: ROOT_OWNER,
    expectedState: { revision: state.revision, stateHash: state.stateHash },
    reasonCode: "RESUMABLE_JOB_FAILURE",
    sourceReceiptId: "job-settlement-receipt-1",
    recordedAt: T1,
    ...overrides
  };
}

function policyFixture(): CanonicalRunPolicy {
  return {
    requestedCapabilities: { agent: true, engineering: false, search: false },
    effectiveCapabilities: { agent: true, engineering: false, search: false },
    toolPolicy: { allowCodexCli: false, sourceAccess: { mode: "offline" as const } },
    externalSideEffects: []
  };
}
