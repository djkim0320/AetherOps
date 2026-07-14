import type { CanonicalHasher } from "../../core/orchestration/orchestrationSchemas.js";
import type { RunStateRevision } from "../../core/orchestration/runStateCapsule.js";
import type { RunStateEvent } from "../../core/orchestration/runStateEvents.js";
import { reduceRunStateRevision } from "../../core/orchestration/runStateReducer.js";
import { CanonicalRunRuntimeError, type CanonicalRevisionPlan, type PrepareCanonicalResumeInput } from "./canonicalRunTypes.js";

export function prepareCanonicalResumePlan(input: PrepareCanonicalResumeInput, state: RunStateRevision, hasher: CanonicalHasher): CanonicalRevisionPlan {
  validateResumeInput(input);
  if (input.mode !== "bootstrap") {
    const checkpointDecisionId = `checkpoint:${hasher.sha256Canonical({ checkpointId: input.predecessorCheckpointId }).slice(0, 48)}`;
    const checkpoint = state.decisions.find((decision) => decision.decisionId === checkpointDecisionId);
    if (!checkpoint || checkpoint.decisionReceiptId !== input.predecessorCheckpointReceiptId) {
      throw new CanonicalRunRuntimeError("CANONICAL_TASK_MISMATCH", "Selected predecessor checkpoint receipt is not recorded in canonical state.");
    }
  }
  const clearances = [...input.blockerClearances].sort((left, right) => left.sourceReceiptId.localeCompare(right.sourceReceiptId));
  const decisionId = resumeDecisionId(input, clearances, hasher);
  const existingDecision = state.decisions.find((decision) => decision.decisionId === decisionId);
  if (existingDecision && (existingDecision.decisionReceiptId !== input.resumeAuthorizationReceiptId || existingDecision.recordedAt !== input.recordedAt)) {
    conflict("Resume authorization replay changed its immutable receipt or timestamp.");
  }
  if (!existingDecision) assertExpectedState(input, state);
  assertBlockerSet(state, clearances, Boolean(existingDecision));
  const revisions: RunStateRevision[] = [];
  let next = state;
  if (!existingDecision) {
    next = reduceRunStateRevision(next, decisionEvent(next, decisionId, input, hasher), hasher);
    revisions.push(next);
  }
  for (const clearance of clearances) {
    const clearanceId = clearanceDecisionId(next.runId, clearance, hasher);
    const existingClearance = next.decisions.find((decision) => decision.decisionId === clearanceId);
    if (existingClearance && (existingClearance.decisionReceiptId !== clearance.dispositionReceiptId || existingClearance.recordedAt !== input.recordedAt)) {
      conflict("Blocker clearance replay changed its immutable disposition receipt or timestamp.");
    }
    if (!existingClearance) {
      if (!next.blockedReasons.some((reason) => reason.sourceReceiptId === clearance.sourceReceiptId)) {
        conflict("Blocker clearance decision is missing for an already-cleared blocker.");
      }
      next = reduceRunStateRevision(next, clearanceDecisionEvent(next, clearanceId, clearance.dispositionReceiptId, input.recordedAt, hasher), hasher);
      revisions.push(next);
    }
    if (!next.blockedReasons.some((reason) => reason.sourceReceiptId === clearance.sourceReceiptId)) continue;
    next = reduceRunStateRevision(next, clearanceEvent(next, clearance, input.recordedAt, hasher), hasher);
    revisions.push(next);
  }
  if (next.status !== "running" || next.blockedReasons.length !== 0 || !next.currentNodeId) {
    conflict("Resume must clear every predecessor blocker and restore the active node to running.");
  }
  const exactReplay = revisions.length === 0;
  return { expectedRevision: state.revision, revisions, finalState: next, exactReplay };
}

function decisionEvent(state: RunStateRevision, decisionId: string, input: PrepareCanonicalResumeInput, hasher: CanonicalHasher): RunStateEvent {
  return event(
    state,
    input.recordedAt,
    "decision.recorded",
    { decision: { decisionId, decisionReceiptId: input.resumeAuthorizationReceiptId, recordedAt: input.recordedAt } },
    hasher
  ) as RunStateEvent;
}

function clearanceDecisionEvent(
  state: RunStateRevision,
  decisionId: string,
  dispositionReceiptId: string,
  recordedAt: string,
  hasher: CanonicalHasher
): RunStateEvent {
  return event(
    state,
    recordedAt,
    "decision.recorded",
    { decision: { decisionId, decisionReceiptId: dispositionReceiptId, recordedAt } },
    hasher
  ) as RunStateEvent;
}

function clearanceEvent(
  state: RunStateRevision,
  clearance: PrepareCanonicalResumeInput["blockerClearances"][number],
  recordedAt: string,
  hasher: CanonicalHasher
): RunStateEvent {
  return event(
    state,
    recordedAt,
    "blocker.cleared",
    { sourceReceiptId: clearance.sourceReceiptId, dispositionReceiptId: clearance.dispositionReceiptId },
    hasher
  ) as RunStateEvent;
}

function event(state: RunStateRevision, occurredAt: string, type: string, payload: object, hasher: CanonicalHasher): object {
  return {
    schemaVersion: 1,
    eventId: `event:${hasher.sha256Canonical({ runId: state.runId, revision: state.revision, type, payload }).slice(0, 48)}`,
    runId: state.runId,
    projectId: state.projectId,
    expectedRevision: state.revision,
    expectedStateHash: state.stateHash,
    occurredAt,
    type,
    ...payload
  };
}

function resumeDecisionId(input: PrepareCanonicalResumeInput, clearances: PrepareCanonicalResumeInput["blockerClearances"], hasher: CanonicalHasher): string {
  const prefix = input.mode === "bootstrap" ? "bootstrap-resume" : "resume";
  return `${prefix}:${hasher
    .sha256Canonical({
      mode: input.mode ?? "checkpoint",
      runId: input.owner.runId,
      resumeJobId: input.owner.jobId,
      predecessorStateHash: input.expectedState.stateHash,
      checkpointReceiptId: input.mode === "bootstrap" ? null : input.predecessorCheckpointReceiptId,
      clearances
    })
    .slice(0, 48)}`;
}

function clearanceDecisionId(runId: string, clearance: PrepareCanonicalResumeInput["blockerClearances"][number], hasher: CanonicalHasher): string {
  return `clearance:${hasher
    .sha256Canonical({
      runId,
      sourceReceiptId: clearance.sourceReceiptId,
      dispositionReceiptId: clearance.dispositionReceiptId
    })
    .slice(0, 48)}`;
}

function assertBlockerSet(state: RunStateRevision, clearances: PrepareCanonicalResumeInput["blockerClearances"], partialReplay: boolean): void {
  const requested = new Set(clearances.map((item) => item.sourceReceiptId));
  const active = new Set(state.blockedReasons.map((reason) => reason.sourceReceiptId));
  const valid =
    state.status === "running" && active.size === 0
      ? partialReplay || requested.size === 0
      : partialReplay
        ? [...active].every((receiptId) => requested.has(receiptId))
        : state.status === "blocked" && active.size > 0 && active.size === requested.size && [...active].every((receiptId) => requested.has(receiptId));
  if (!valid) conflict("Resume blocker clearances must exactly cover the predecessor blocker set.");
}

function validateResumeInput(input: PrepareCanonicalResumeInput): void {
  const values = [
    input.owner.projectId,
    input.owner.runId,
    input.owner.jobId,
    ...(input.mode === "bootstrap" ? [] : [input.predecessorCheckpointId, input.predecessorCheckpointReceiptId]),
    input.resumeAuthorizationReceiptId,
    ...input.blockerClearances.flatMap((item) => [item.sourceReceiptId, item.dispositionReceiptId])
  ];
  if (values.some((value) => !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(value)) || !Number.isFinite(Date.parse(input.recordedAt))) {
    invalid("Resume ownership, receipts, or timestamp are invalid.");
  }
  const sources = input.blockerClearances.map((item) => item.sourceReceiptId);
  if (
    sources.length > 15 ||
    new Set(sources).size !== sources.length ||
    input.blockerClearances.some((item) => item.dispositionReceiptId !== input.resumeAuthorizationReceiptId)
  ) {
    invalid("Resume requires unique blocker source receipts bound to the resume authorization receipt.");
  }
}

function assertExpectedState(input: PrepareCanonicalResumeInput, state: RunStateRevision): void {
  if (input.expectedState.revision !== state.revision || input.expectedState.stateHash !== state.stateHash) {
    throw new CanonicalRunRuntimeError(
      "CANONICAL_STATE_STALE",
      `Canonical run state changed: expected revision ${input.expectedState.revision}, actual ${state.revision}.`
    );
  }
  const resumableBlocked = state.status === "blocked" && state.blockedReasons.length > 0;
  const interruptedWithoutBlocker = state.status === "running" && state.blockedReasons.length === 0 && Boolean(state.currentNodeId);
  if (!resumableBlocked && !interruptedWithoutBlocker) {
    conflict("Resume requires either a blocked predecessor or an active checkpointed predecessor without blockers.");
  }
}

function conflict(message: string): never {
  throw new CanonicalRunRuntimeError("CANONICAL_RESUME_CONFLICT", message);
}

function invalid(message: string): never {
  throw new CanonicalRunRuntimeError("INVALID_CANONICAL_RUN_INPUT", message);
}
