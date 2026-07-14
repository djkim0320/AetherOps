import type { CanonicalHasher } from "./orchestrationSchemas.js";
import { parseRunStateRevision, type RunStateRevision } from "./runStateCapsule.js";
import { parseRunStateEvent, type RunStateEvent } from "./runStateEvents.js";

export class RunStateRevisionConflictError extends Error {
  readonly code = "STALE_RUN_STATE";

  constructor(
    readonly expectedRevision: number,
    readonly actualRevision: number,
    readonly expectedStateHash: string,
    readonly actualStateHash: string
  ) {
    super(`Run state changed: expected revision ${expectedRevision}, actual revision ${actualRevision}.`);
    this.name = "RunStateRevisionConflictError";
  }
}

export class RunStateTransitionError extends Error {
  constructor(
    readonly code: string,
    message: string
  ) {
    super(message);
    this.name = "RunStateTransitionError";
  }
}

export function reduceRunStateRevision(currentInput: RunStateRevision, eventInput: RunStateEvent, hasher: CanonicalHasher): RunStateRevision {
  const current = parseRunStateRevision(currentInput, hasher);
  const event = parseRunStateEvent(eventInput, hasher);
  assertEventGuard(current, event);
  assertMutable(current);
  if (Date.parse(event.occurredAt) < Date.parse(current.updatedAt)) fail("EVENT_TIME_REGRESSION", "Run-state events cannot move time backwards.");

  switch (event.type) {
    case "node.activated":
      return activateNode(current, event, hasher);
    case "node.completed":
      return completeNode(current, event, hasher);
    case "fact.verified":
      assertRecordedAt(event.fact.recordedAt, event.occurredAt);
      assertUnique(current.verifiedFacts, "factId", event.fact.factId, "FACT_ALREADY_RECORDED");
      assertEvidenceExists(current, event.fact.evidenceIds);
      return commit(current, event, { verifiedFacts: [...current.verifiedFacts, event.fact] }, hasher);
    case "decision.recorded":
      assertRecordedAt(event.decision.recordedAt, event.occurredAt);
      assertUnique(current.decisions, "decisionId", event.decision.decisionId, "DECISION_ALREADY_RECORDED");
      return commit(current, event, { decisions: [...current.decisions, event.decision] }, hasher);
    case "assumption.recorded":
      assertRecordedAt(event.assumption.recordedAt, event.occurredAt);
      assertUnique(current.assumptions, "assumptionId", event.assumption.assumptionId, "ASSUMPTION_ALREADY_RECORDED");
      return commit(current, event, { assumptions: [...current.assumptions, event.assumption] }, hasher);
    case "question.opened":
      assertRecordedAt(event.question.recordedAt, event.occurredAt);
      assertUnique(current.openQuestions, "questionId", event.question.questionId, "QUESTION_ALREADY_OPEN");
      return commit(current, event, { openQuestions: [...current.openQuestions, event.question] }, hasher);
    case "question.closed":
      return closeQuestion(current, event, hasher);
    case "blocker.added":
      return addBlocker(current, event, hasher);
    case "blocker.cleared":
      return clearBlocker(current, event, hasher);
    case "budget.consumed":
      return consumeBudget(current, event, hasher);
    case "next_actions.set":
      return setNextActions(current, event, hasher);
    case "run.terminated":
      return terminateRun(current, event, hasher);
  }
}

export function foldRunStateRevisions(initial: RunStateRevision, events: readonly RunStateEvent[], hasher: CanonicalHasher): RunStateRevision {
  return events.reduce((state, event) => reduceRunStateRevision(state, event, hasher), initial);
}

function assertEventGuard(state: RunStateRevision, event: RunStateEvent): void {
  if (state.projectId !== event.projectId || state.runId !== event.runId) fail("RUN_OWNERSHIP_MISMATCH", "Event ownership does not match the run state.");
  if (state.revision !== event.expectedRevision || state.stateHash !== event.expectedStateHash) {
    throw new RunStateRevisionConflictError(event.expectedRevision, state.revision, event.expectedStateHash, state.stateHash);
  }
}

function assertMutable(state: RunStateRevision): void {
  if (state.status === "completed" || state.status === "failed" || state.status === "cancelled") {
    fail("RUN_ALREADY_TERMINAL", "A terminal run state cannot be revised.");
  }
}

function activateNode(state: RunStateRevision, event: Extract<RunStateEvent, { type: "node.activated" }>, hasher: CanonicalHasher): RunStateRevision {
  if (state.status !== "ready" || state.currentNodeId) fail("RUN_NOT_READY", "A task node can start only while the run is ready.");
  if (!state.pendingNodeIds.includes(event.nodeId)) fail("NODE_NOT_PENDING", "The selected task node is not pending.");
  const node = state.taskGraph.nodes.find((candidate) => candidate.id === event.nodeId);
  if (!node) fail("NODE_NOT_FOUND", "The selected task node is absent from the task graph.");
  const completed = new Set(state.completedNodeReceipts.map((receipt) => receipt.nodeId));
  if (node.dependencyNodeIds.some((dependencyId) => !completed.has(dependencyId))) fail("NODE_DEPENDENCY_PENDING", "Task node dependencies are incomplete.");
  return commit(
    state,
    event,
    {
      status: "running",
      currentNodeId: event.nodeId,
      pendingNodeIds: state.pendingNodeIds.filter((nodeId) => nodeId !== event.nodeId),
      nextProposedNodeIds: []
    },
    hasher
  );
}

function completeNode(state: RunStateRevision, event: Extract<RunStateEvent, { type: "node.completed" }>, hasher: CanonicalHasher): RunStateRevision {
  const receipt = event.receipt;
  if (state.status !== "running" || state.currentNodeId !== receipt.nodeId) fail("NODE_NOT_ACTIVE", "Only the active task node can complete.");
  if (receipt.runId !== state.runId || receipt.projectId !== state.projectId) fail("RUN_OWNERSHIP_MISMATCH", "Node receipt ownership does not match the run.");
  if (receipt.completedAt !== event.occurredAt) fail("RECEIPT_TIME_MISMATCH", "Node receipt time must match its state event.");
  assertProjectResources(state.projectId, receipt.artifactRefs, receipt.evidenceRefs);
  const pendingNodeIds = state.pendingNodeIds.filter((nodeId) => nodeId !== receipt.nodeId);
  return commit(
    state,
    event,
    {
      status: pendingNodeIds.length === 0 ? "awaiting_completion" : "ready",
      currentNodeId: null,
      pendingNodeIds,
      completedNodeReceipts: [...state.completedNodeReceipts, receipt],
      artifactRefs: mergeReferences(state.artifactRefs, receipt.artifactRefs, "artifactId"),
      evidenceRefs: mergeReferences(state.evidenceRefs, receipt.evidenceRefs, "evidenceId"),
      nextProposedNodeIds: []
    },
    hasher
  );
}

function closeQuestion(state: RunStateRevision, event: Extract<RunStateEvent, { type: "question.closed" }>, hasher: CanonicalHasher): RunStateRevision {
  if (!state.openQuestions.some((question) => question.questionId === event.questionId)) fail("QUESTION_NOT_OPEN", "Only an open question can be closed.");
  return commit(state, event, { openQuestions: state.openQuestions.filter((question) => question.questionId !== event.questionId) }, hasher);
}

function addBlocker(state: RunStateRevision, event: Extract<RunStateEvent, { type: "blocker.added" }>, hasher: CanonicalHasher): RunStateRevision {
  assertRecordedAt(event.reason.recordedAt, event.occurredAt);
  if (event.reason.nodeId && !state.taskGraph.nodes.some((node) => node.id === event.reason.nodeId))
    fail("NODE_NOT_FOUND", "Blocker references an unknown node.");
  assertUnique(currentBlockers(state), "sourceReceiptId", event.reason.sourceReceiptId, "BLOCKER_ALREADY_RECORDED");
  return commit(state, event, { status: "blocked", blockedReasons: [...state.blockedReasons, event.reason], nextProposedNodeIds: [] }, hasher);
}

function clearBlocker(state: RunStateRevision, event: Extract<RunStateEvent, { type: "blocker.cleared" }>, hasher: CanonicalHasher): RunStateRevision {
  if (!state.blockedReasons.some((reason) => reason.sourceReceiptId === event.sourceReceiptId)) fail("BLOCKER_NOT_FOUND", "The blocker receipt is not active.");
  const blockedReasons = state.blockedReasons.filter((reason) => reason.sourceReceiptId !== event.sourceReceiptId);
  const status = blockedReasons.length > 0 ? "blocked" : state.currentNodeId ? "running" : state.pendingNodeIds.length > 0 ? "ready" : "awaiting_completion";
  return commit(state, event, { status, blockedReasons }, hasher);
}

function consumeBudget(state: RunStateRevision, event: Extract<RunStateEvent, { type: "budget.consumed" }>, hasher: CanonicalHasher): RunStateRevision {
  const usage = addUsage(state.budgetUsage, event.delta);
  // Consumption is an immutable observation, not an authorization. An in-flight
  // operation can cross a limit before its exact usage is known; preserving that
  // overage lets the terminal transaction record the trace and a budget blocker.
  return commit(state, event, { budgetUsage: usage }, hasher);
}

function setNextActions(state: RunStateRevision, event: Extract<RunStateEvent, { type: "next_actions.set" }>, hasher: CanonicalHasher): RunStateRevision {
  const unique = new Set(event.nodeIds);
  if (unique.size !== event.nodeIds.length) fail("DUPLICATE_NEXT_ACTION", "Next actions must be unique.");
  const completed = new Set(state.completedNodeReceipts.map((receipt) => receipt.nodeId));
  for (const nodeId of event.nodeIds) {
    const node = state.taskGraph.nodes.find((candidate) => candidate.id === nodeId);
    if (!node || !state.pendingNodeIds.includes(nodeId)) fail("NODE_NOT_PENDING", "Next actions may reference only pending task nodes.");
    if (node.dependencyNodeIds.some((dependencyId) => !completed.has(dependencyId)))
      fail("NODE_DEPENDENCY_PENDING", "A proposed task node has incomplete dependencies.");
  }
  return commit(state, event, { nextProposedNodeIds: [...event.nodeIds] }, hasher);
}

function terminateRun(state: RunStateRevision, event: Extract<RunStateEvent, { type: "run.terminated" }>, hasher: CanonicalHasher): RunStateRevision {
  const receipt = event.receipt;
  if (receipt.runId !== state.runId || receipt.projectId !== state.projectId)
    fail("RUN_OWNERSHIP_MISMATCH", "Termination receipt ownership does not match the run.");
  if (receipt.createdAt !== event.occurredAt) fail("RECEIPT_TIME_MISMATCH", "Termination receipt time must match its state event.");
  assertReceiptSet(
    state.completedNodeReceipts.map((item) => item.receiptId),
    receipt.completedNodeReceiptIds
  );
  if (receipt.outcome === "completed" && state.status !== "awaiting_completion")
    fail("RUN_NOT_COMPLETABLE", "A run can complete only after every task node has a receipt.");
  const pendingNodeIds = receipt.outcome === "completed" ? [] : graphOrderedPending(state);
  return commit(state, event, { status: receipt.outcome, currentNodeId: null, pendingNodeIds, nextProposedNodeIds: [], terminalReceipt: receipt }, hasher);
}

function commit(state: RunStateRevision, event: RunStateEvent, patch: object, hasher: CanonicalHasher): RunStateRevision {
  const { stateHash, ...stateWithoutHash } = state;
  const nextWithoutHash = {
    ...stateWithoutHash,
    ...patch,
    revision: state.revision + 1,
    parentRevisionHash: stateHash,
    updatedAt: event.occurredAt
  };
  const next = { ...nextWithoutHash, stateHash: hasher.sha256Canonical(nextWithoutHash) };
  return parseRunStateRevision(next, hasher);
}

function mergeReferences<Item extends Record<Key, string>, Key extends keyof Item>(existing: readonly Item[], incoming: readonly Item[], key: Key): Item[] {
  const merged = new Map(existing.map((item) => [item[key], item]));
  for (const item of incoming) {
    const previous = merged.get(item[key]);
    if (previous && !sameReference(previous, item)) fail("RESOURCE_REFERENCE_CONFLICT", `Conflicting resource reference: ${item[key]}`);
    merged.set(item[key], item);
  }
  return [...merged.values()].sort((left, right) => left[key].localeCompare(right[key]));
}

function sameReference(left: object, right: object): boolean {
  const leftValues = Object.entries(left).sort(([a], [b]) => a.localeCompare(b));
  const rightValues = Object.entries(right).sort(([a], [b]) => a.localeCompare(b));
  return (
    leftValues.length === rightValues.length && leftValues.every(([key, value], index) => rightValues[index]?.[0] === key && rightValues[index]?.[1] === value)
  );
}

function addUsage(left: RunStateRevision["budgetUsage"], right: RunStateRevision["budgetUsage"]): RunStateRevision["budgetUsage"] {
  return {
    durationMs: left.durationMs + right.durationMs,
    inputTokens: left.inputTokens + right.inputTokens,
    outputTokens: left.outputTokens + right.outputTokens,
    toolCalls: left.toolCalls + right.toolCalls,
    retries: left.retries + right.retries,
    estimatedCostMicrousd: left.estimatedCostMicrousd + right.estimatedCostMicrousd,
    toolOutputBytes: left.toolOutputBytes + right.toolOutputBytes
  };
}

function assertEvidenceExists(state: RunStateRevision, ids: readonly string[]): void {
  const evidenceIds = new Set(state.evidenceRefs.map((reference) => reference.evidenceId));
  if (ids.some((id) => !evidenceIds.has(id))) fail("EVIDENCE_NOT_RECORDED", "A verified fact references missing evidence.");
}

function assertProjectResources(projectId: string, artifacts: readonly { projectId: string }[], evidence: readonly { projectId: string }[]): void {
  if ([...artifacts, ...evidence].some((reference) => reference.projectId !== projectId))
    fail("RESOURCE_OWNERSHIP_MISMATCH", "Resource ownership does not match the run project.");
}

function assertRecordedAt(recordedAt: string, occurredAt: string): void {
  if (recordedAt !== occurredAt) fail("RECEIPT_TIME_MISMATCH", "Recorded reference time must match its state event.");
}

function assertUnique<Item, Key extends keyof Item>(items: readonly Item[], key: Key, value: Item[Key], code: string): void {
  if (items.some((item) => item[key] === value)) fail(code, `Duplicate stable reference: ${String(value)}`);
}

function currentBlockers(state: RunStateRevision): RunStateRevision["blockedReasons"] {
  return state.blockedReasons;
}

function assertReceiptSet(expected: readonly string[], actual: readonly string[]): void {
  const unique = new Set(actual);
  if (unique.size !== actual.length || expected.length !== actual.length || expected.some((id) => !unique.has(id))) {
    fail("TERMINATION_RECEIPT_MISMATCH", "Termination receipt must bind every completed node receipt exactly once.");
  }
}

function graphOrderedPending(state: RunStateRevision): string[] {
  const completed = new Set(state.completedNodeReceipts.map((receipt) => receipt.nodeId));
  return state.taskGraph.nodes.filter((node) => !completed.has(node.id)).map((node) => node.id);
}

function fail(code: string, message: string): never {
  throw new RunStateTransitionError(code, message);
}
