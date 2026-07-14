import type { ContextPack } from "../../core/context/public.js";
import { createInitialRunStateRevision, parseRunStateRevision, type RunStateRevision } from "../../core/orchestration/runStateCapsule.js";
import type { RunStateEvent } from "../../core/orchestration/runStateEvents.js";
import { reduceRunStateRevision } from "../../core/orchestration/runStateReducer.js";
import { parseTaskContract, type TaskContract } from "../../core/orchestration/taskContract.js";
import { buildPlanningContextPack } from "./canonicalPlanningContext.js";
import { readCanonicalContextPack } from "./canonicalContextPackReadback.js";
import { assertCanonicalContextPack, assertCanonicalContextPackReadback } from "./canonicalContextPackValidation.js";
import { prepareCanonicalBudgetPlan, type PrepareCanonicalBudgetInput } from "./canonicalBudgetPlan.js";
import { anchoredCanonicalPreparation } from "./canonicalInitializationAnchor.js";
import {
  LEGACY_RESEARCH_LOOP_NODE_ID,
  assertCanonicalPolicy,
  assertCanonicalRunInput,
  buildCanonicalTaskContract,
  buildLegacyResearchTaskGraph,
  canonicalImmutableJobPolicy
} from "./canonicalTaskContractBuilder.js";
import { prepareCanonicalTerminalPlan } from "./canonicalTerminalPlan.js";
import { prepareCanonicalResumePlan } from "./canonicalResumePlan.js";
import {
  CanonicalRunRuntimeError,
  type CanonicalRunOwner,
  type CanonicalRunRuntimeDependencies,
  type CanonicalRevisionPlan,
  type CompilePlanningContextInput,
  type PrepareCanonicalRunInput,
  type PreparedCanonicalRun,
  type PrepareCanonicalResumeInput,
  type RecordCanonicalBlockerInput,
  type RecordCanonicalCheckpointInput,
  type RecordCanonicalCompletionInput,
  type RecordCanonicalNonCompletionInput,
  type RecordCanonicalTerminalInput
} from "./canonicalRunTypes.js";

export class CanonicalRunRuntime {
  constructor(private readonly dependencies: CanonicalRunRuntimeDependencies) {}

  async prepareInitialRun(input: PrepareCanonicalRunInput): Promise<PreparedCanonicalRun> {
    const { gateway, hasher } = this.dependencies;
    assertInitializationLineage(input);
    const graph = buildLegacyResearchTaskGraph(input.owner.runId, hasher);
    const existingInput = await gateway.latestRunState(input.owner);
    let contract: TaskContract;
    let state: RunStateRevision;
    if (existingInput) {
      assertCanonicalRunInput(input.owner, input.snapshot, input.specification, input.preparedAt);
      assertCanonicalPolicy(input.policy);
      state = parseRunStateRevision(existingInput, hasher);
      contract = await this.readTaskContract(input.owner.projectId, state.taskContractId);
      assertExistingPreparation(input, graph.contentHash, contract, state, hasher);
    } else {
      const candidateContract =
        input.initializationAnchor !== undefined
          ? anchoredCanonicalPreparation(input, input.initializationAnchor, hasher).taskContract
          : initialRootContract(input, hasher);
      contract = await this.saveTaskContract(input.owner, candidateContract);
      const initial = createInitialRunStateRevision(
        { runId: input.owner.runId, projectId: input.owner.projectId, taskContract: contract, taskGraph: graph, createdAt: input.preparedAt },
        hasher
      );
      state = await this.commitState(input.owner, null, initial);
    }
    assertCanonicalState(input.owner, contract, state);
    if (state.revision === 0) {
      const activated = reduceRunStateRevision(state, activationEvent(state, state.createdAt), hasher);
      state = await this.commitState(input.owner, 0, activated);
    }
    if (
      state.revision < 1 ||
      (state.status !== "running" && state.status !== "blocked") ||
      state.currentNodeId !== LEGACY_RESEARCH_LOOP_NODE_ID ||
      state.pendingNodeIds.length !== 0
    ) {
      throw new CanonicalRunRuntimeError("CANONICAL_RUN_NOT_READY", "Canonical preparation requires the active legacy research-loop node.");
    }
    return { taskContract: contract, state };
  }

  async compilePlanningContext(input: CompilePlanningContextInput): Promise<ContextPack> {
    assertCanonicalRunInput(input.owner, input.snapshot, input.specification, input.compiledAt);
    const { taskContract: contract, state } = await this.readCurrentRun(input.owner);
    assertExpectedState(input, state);
    const pack = await buildPlanningContextPack(input, contract, state, this.dependencies.hasher);
    assertCanonicalContextPack(input, contract, state, pack);
    const readback = await this.dependencies.gateway.saveContextPack(input.owner, state.revision, pack);
    assertCanonicalContextPackReadback(readback, pack);
    return pack;
  }

  async recordCheckpoint(input: RecordCanonicalCheckpointInput): Promise<RunStateRevision> {
    return this.commitPlan(input.owner, await this.prepareCheckpointRevision(input));
  }

  async prepareBudgetRevision(input: PrepareCanonicalBudgetInput): Promise<CanonicalRevisionPlan> {
    const { state } = await this.readCurrentRun(input.owner);
    return prepareCanonicalBudgetPlan(input, state, this.dependencies.hasher);
  }

  async prepareResumableBlockerRevision(input: RecordCanonicalBlockerInput): Promise<CanonicalRevisionPlan> {
    const { state } = await this.readCurrentRun(input.owner);
    return this.prepareResumableBlockerRevisionFromState(input, state);
  }

  prepareResumableBlockerRevisionFromState(input: RecordCanonicalBlockerInput, state: RunStateRevision): CanonicalRevisionPlan {
    assertBlockerInput(input);
    const existing = state.blockedReasons.find((reason) => reason.sourceReceiptId === input.sourceReceiptId);
    if (existing) {
      if (existing.code === input.reasonCode && existing.recordedAt === input.recordedAt && existing.nodeId === LEGACY_RESEARCH_LOOP_NODE_ID) {
        return { expectedRevision: state.revision, revisions: [], finalState: state, exactReplay: true };
      }
      taskMismatch("Resumable blocker replay conflicts with its immutable reason receipt.");
    }
    if (state.status === "completed" || state.status === "failed" || state.status === "cancelled") {
      throw new CanonicalRunRuntimeError("CANONICAL_TERMINAL_CONFLICT", "A terminal canonical run cannot receive a resumable blocker.");
    }
    assertExpectedState(input, state);
    const event: RunStateEvent = {
      schemaVersion: 1,
      eventId: `event:${this.dependencies.hasher.sha256Canonical({ runId: state.runId, sourceReceiptId: input.sourceReceiptId }).slice(0, 48)}`,
      runId: state.runId,
      projectId: state.projectId,
      expectedRevision: state.revision,
      expectedStateHash: state.stateHash,
      occurredAt: input.recordedAt,
      type: "blocker.added",
      reason: { code: input.reasonCode, sourceReceiptId: input.sourceReceiptId, nodeId: LEGACY_RESEARCH_LOOP_NODE_ID, recordedAt: input.recordedAt }
    };
    const finalState = reduceRunStateRevision(state, event, this.dependencies.hasher);
    return { expectedRevision: state.revision, revisions: [finalState], finalState, exactReplay: false };
  }

  async recordResumableBlocker(input: RecordCanonicalBlockerInput): Promise<RunStateRevision> {
    return this.commitPlan(input.owner, await this.prepareResumableBlockerRevision(input));
  }

  async prepareResumeRevision(input: PrepareCanonicalResumeInput): Promise<CanonicalRevisionPlan> {
    const { state } = await this.readCurrentRun(input.owner);
    return prepareCanonicalResumePlan(input, state, this.dependencies.hasher);
  }

  async recordResume(input: PrepareCanonicalResumeInput): Promise<RunStateRevision> {
    return this.commitPlan(input.owner, await this.prepareResumeRevision(input));
  }

  async prepareCheckpointRevision(input: RecordCanonicalCheckpointInput): Promise<CanonicalRevisionPlan> {
    assertCheckpointInput(input);
    const { state } = await this.readCurrentRun(input.owner);
    const decisionId = `checkpoint:${this.dependencies.hasher.sha256Canonical({ checkpointId: input.checkpointId }).slice(0, 48)}`;
    const existing = state.decisions.find((decision) => decision.decisionId === decisionId);
    if (existing) {
      if (existing.decisionReceiptId === input.stepReceiptId && existing.recordedAt === input.recordedAt) {
        return { expectedRevision: state.revision, revisions: [], finalState: state, exactReplay: true };
      }
      taskMismatch("Checkpoint replay conflicts with its immutable step receipt or timestamp.");
    }
    assertExpectedState(input, state);
    const event: RunStateEvent = {
      schemaVersion: 1,
      eventId: `event:${this.dependencies.hasher
        .sha256Canonical({ runId: input.owner.runId, checkpointId: input.checkpointId, type: "decision.recorded" })
        .slice(0, 48)}`,
      runId: input.owner.runId,
      projectId: input.owner.projectId,
      expectedRevision: state.revision,
      expectedStateHash: state.stateHash,
      occurredAt: input.recordedAt,
      type: "decision.recorded",
      decision: { decisionId, decisionReceiptId: input.stepReceiptId, recordedAt: input.recordedAt }
    };
    const next = reduceRunStateRevision(state, event, this.dependencies.hasher);
    return { expectedRevision: state.revision, revisions: [next], finalState: next, exactReplay: false };
  }

  async prepareTerminalRevisions(input: RecordCanonicalTerminalInput): Promise<CanonicalRevisionPlan> {
    const { taskContract, state } = await this.readCurrentRun(input.owner);
    return this.prepareTerminalRevisionsFromState(input, taskContract, state);
  }

  prepareTerminalRevisionsFromState(input: RecordCanonicalTerminalInput, taskContract: TaskContract, state: RunStateRevision): CanonicalRevisionPlan {
    return prepareCanonicalTerminalPlan(input, taskContract, state, this.dependencies.hasher);
  }

  async recordCompletion(input: RecordCanonicalCompletionInput): Promise<RunStateRevision> {
    return this.commitPlan(input.owner, await this.prepareTerminalRevisions({ ...input, outcome: "completed" }));
  }

  async recordFailure(input: RecordCanonicalNonCompletionInput): Promise<RunStateRevision> {
    return this.commitPlan(input.owner, await this.prepareTerminalRevisions({ ...input, outcome: "failed" }));
  }

  async recordCancellation(input: RecordCanonicalNonCompletionInput): Promise<RunStateRevision> {
    return this.commitPlan(input.owner, await this.prepareTerminalRevisions({ ...input, outcome: "cancelled" }));
  }

  async readCurrentRun(owner: CanonicalRunOwner): Promise<PreparedCanonicalRun> {
    assertCanonicalOwner(owner);
    const latestInput = await this.dependencies.gateway.latestRunState(owner);
    if (!latestInput) throw new CanonicalRunRuntimeError("CANONICAL_RUN_NOT_READY", "Canonical run state does not exist.");
    const state = parseRunStateRevision(latestInput, this.dependencies.hasher);
    assertStateOwner(owner, state);
    const taskContract = await this.readTaskContract(owner.projectId, state.taskContractId);
    assertCanonicalState(owner, taskContract, state);
    return { taskContract, state };
  }

  async readContextPack(owner: CanonicalRunOwner, predecessorJobId: string, contextPackId: string) {
    assertCanonicalOwner(owner);
    return readCanonicalContextPack(this.dependencies, owner, predecessorJobId, contextPackId);
  }

  private async saveTaskContract(owner: CanonicalRunOwner, candidate: TaskContract): Promise<TaskContract> {
    const saved = await this.dependencies.gateway.saveTaskContract(owner, candidate);
    const contract = parseTaskContract(saved, this.dependencies.hasher);
    if (contract.id !== candidate.id || contract.contentHash !== candidate.contentHash) readbackMismatch("Task contract readback changed identity or hash.");
    return contract;
  }

  private async readTaskContract(projectId: string, taskContractId: string): Promise<TaskContract> {
    const stored = await this.dependencies.gateway.getTaskContract(projectId, taskContractId);
    if (!stored) throw new CanonicalRunRuntimeError("CANONICAL_TASK_MISMATCH", "Canonical task contract is missing.");
    const contract = parseTaskContract(stored, this.dependencies.hasher);
    if (contract.projectId !== projectId || contract.id !== taskContractId) taskMismatch("Canonical task contract ownership or identity changed.");
    return contract;
  }

  private async commitState(owner: CanonicalRunOwner, expectedRevision: number | null, revision: RunStateRevision): Promise<RunStateRevision> {
    const stored = await this.dependencies.gateway.commitRunState(owner, expectedRevision, revision);
    const readback = parseRunStateRevision(stored, this.dependencies.hasher);
    if (readback.stateHash !== revision.stateHash || readback.revision !== revision.revision) readbackMismatch("Run-state readback changed revision or hash.");
    return readback;
  }

  private async commitPlan(owner: CanonicalRunOwner, plan: CanonicalRevisionPlan): Promise<RunStateRevision> {
    let state = plan.finalState;
    let expected = plan.expectedRevision;
    for (const revision of plan.revisions) {
      state = await this.commitState(owner, expected, revision);
      expected = state.revision;
    }
    return state;
  }
}

function initialRootContract(input: PrepareCanonicalRunInput, hasher: CanonicalRunRuntimeDependencies["hasher"]): TaskContract {
  if (input.owner.jobId !== input.rootJobId) {
    throw new CanonicalRunRuntimeError(
      "CANONICAL_RUN_NOT_READY",
      "A resume successor cannot initialize revision zero without the immutable root initialization anchor."
    );
  }
  return buildCanonicalTaskContract(input, hasher);
}

function assertInitializationLineage(input: PrepareCanonicalRunInput): void {
  if (
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(input.rootJobId) ||
    input.owner.runId !== `run:${input.rootJobId}` ||
    input.preparedAt !== input.rootJobCreatedAt ||
    !Number.isFinite(Date.parse(input.rootJobCreatedAt))
  ) {
    throw new CanonicalRunRuntimeError("CANONICAL_RUN_OWNERSHIP_MISMATCH", "Canonical initialization does not match the immutable root lineage.");
  }
}

function activationEvent(state: RunStateRevision, occurredAt: string): RunStateEvent {
  return {
    schemaVersion: 1,
    eventId: `event:${state.taskGraph.contentHash.slice(0, 48)}`,
    runId: state.runId,
    projectId: state.projectId,
    expectedRevision: state.revision,
    expectedStateHash: state.stateHash,
    occurredAt,
    type: "node.activated",
    nodeId: LEGACY_RESEARCH_LOOP_NODE_ID
  };
}

function assertExpectedState(input: { expectedState: { revision: number; stateHash: string } }, state: RunStateRevision): void {
  if (input.expectedState.revision !== state.revision || input.expectedState.stateHash !== state.stateHash) {
    throw new CanonicalRunRuntimeError(
      "CANONICAL_STATE_STALE",
      `Canonical run state changed: expected revision ${input.expectedState.revision}, actual revision ${state.revision}.`
    );
  }
}

function assertCanonicalState(owner: CanonicalRunOwner, contract: TaskContract, state: RunStateRevision): void {
  assertStateOwner(owner, state);
  if (contract.projectId !== owner.projectId) {
    throw new CanonicalRunRuntimeError("CANONICAL_RUN_OWNERSHIP_MISMATCH", "Canonical task or state ownership does not match the resolved run owner.");
  }
  if (state.taskContractId !== contract.id || state.taskContractHash !== contract.contentHash) {
    taskMismatch("Canonical state no longer binds the stored task contract hash.");
  }
  if (state.taskGraph.nodes.length !== 1 || state.taskGraph.nodes[0]?.id !== LEGACY_RESEARCH_LOOP_NODE_ID || state.taskGraph.nodes[0]?.terminal !== true) {
    taskMismatch("Canonical M1 state must contain exactly one terminal legacy research-loop node.");
  }
  if (state.budgetLimits.maxConcurrency < 1 || state.budgetLimits.maxConcurrency > 16)
    taskMismatch("Canonical task concurrency is outside its immutable bound.");
}

function assertStateOwner(owner: CanonicalRunOwner, state: RunStateRevision): void {
  if (state.projectId !== owner.projectId || state.runId !== owner.runId) {
    throw new CanonicalRunRuntimeError("CANONICAL_RUN_OWNERSHIP_MISMATCH", "Canonical state ownership does not match the resolved run owner.");
  }
}

function assertExistingPreparation(
  input: PrepareCanonicalRunInput,
  candidateGraphHash: string,
  contract: TaskContract,
  state: RunStateRevision,
  hasher: CanonicalRunRuntimeDependencies["hasher"]
): void {
  const jobPolicy = contract.instructionProvenance.find((item) => item.instructionId === "instruction:job-policy");
  if (!jobPolicy || jobPolicy.contentHash !== hasher.sha256Canonical(canonicalImmutableJobPolicy(input.policy))) {
    taskMismatch("Initial preparation attempted to change the immutable canonical job policy.");
  }
  if (candidateGraphHash !== state.taskGraph.contentHash || !sameTaskLimits(input.taskLimits, state.budgetLimits)) {
    taskMismatch("Initial preparation attempted to change the immutable task graph or resource budget.");
  }
}

function sameTaskLimits(left: PrepareCanonicalRunInput["taskLimits"], right: RunStateRevision["budgetLimits"]): boolean {
  return (
    left.maxDurationMs === right.maxDurationMs &&
    left.maxInputTokens === right.maxInputTokens &&
    left.maxOutputTokens === right.maxOutputTokens &&
    left.maxToolCalls === right.maxToolCalls &&
    left.maxRetries === right.maxRetries &&
    left.maxEstimatedCostMicrousd === right.maxEstimatedCostMicrousd &&
    left.maxToolOutputBytes === right.maxToolOutputBytes &&
    left.maxConcurrency === right.maxConcurrency
  );
}

function assertCheckpointInput(input: RecordCanonicalCheckpointInput): void {
  assertCanonicalOwner(input.owner);
  const stableId = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
  if (!stableId.test(input.checkpointId) || !stableId.test(input.stepReceiptId)) {
    throw new CanonicalRunRuntimeError("INVALID_CANONICAL_RUN_INPUT", "Checkpoint and receipt identifiers must be stable identifiers.");
  }
  if (!Number.isFinite(Date.parse(input.recordedAt))) {
    throw new CanonicalRunRuntimeError("INVALID_CANONICAL_RUN_INPUT", "Checkpoint recordedAt must be an ISO-8601 timestamp.");
  }
}

function assertBlockerInput(input: RecordCanonicalBlockerInput): void {
  assertCanonicalOwner(input.owner);
  if (
    !/^[A-Z][A-Z0-9_]{0,119}$/.test(input.reasonCode) ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(input.sourceReceiptId) ||
    !Number.isFinite(Date.parse(input.recordedAt))
  ) {
    throw new CanonicalRunRuntimeError("INVALID_CANONICAL_RUN_INPUT", "Resumable blocker reason, receipt, or timestamp is invalid.");
  }
}

function assertCanonicalOwner(owner: CanonicalRunOwner): void {
  const stableId = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
  if (!stableId.test(owner.projectId) || !stableId.test(owner.runId) || !stableId.test(owner.jobId)) {
    throw new CanonicalRunRuntimeError("INVALID_CANONICAL_RUN_INPUT", "Canonical run ownership identifiers must be stable identifiers.");
  }
}

function taskMismatch(message: string): never {
  throw new CanonicalRunRuntimeError("CANONICAL_TASK_MISMATCH", message);
}

function readbackMismatch(message: string): never {
  throw new CanonicalRunRuntimeError("CANONICAL_READBACK_MISMATCH", message);
}
