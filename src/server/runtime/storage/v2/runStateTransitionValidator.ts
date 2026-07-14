import type { RunStateRevision } from "../../../../core/orchestration/runStateCapsule.js";
import { budgetUsageEqual, CANONICAL_BUDGET_DECISION_PREFIX, CANONICAL_BUDGET_RECEIPT_PREFIX } from "../../../../core/orchestration/budgetAccounting.js";
import type { StorageTerminalTransitionResult } from "./jobAtomicTypes.js";
import { storageCanonicalHasher, parseStoredRunStateRevision } from "./runStatePayloadValidator.js";
import type { StorageCanonicalBudgetCommitInput, StorageCanonicalFinalState } from "./runStateAtomicTypes.js";
import type { StorageCommitRunStateRevisionInput, StorageRunOwnership } from "./runStateTypes.js";
import type { StorageJob, StorageStepDispositionResult } from "./types.js";
import type { StorageV2RepositorySet } from "./repositories.js";
import { assertAuthoritativeTerminalReceipts } from "./terminalReceiptTransitionValidator.js";

export function readCanonicalState(repositories: StorageV2RepositorySet, owner: StorageRunOwnership): RunStateRevision {
  const stored = repositories.runState.latestRevision(owner);
  if (!stored) throw new Error("Canonical transition requires an existing run-state revision.");
  return parseStoredRunStateRevision(stored.data);
}

export function assertCanonicalResumePlan(
  previous: RunStateRevision,
  revisions: readonly StorageCommitRunStateRevisionInput[],
  finalState: StorageCanonicalFinalState,
  job: StorageJob,
  exactReplay: boolean
): void {
  const final = plannedFinal(previous, revisions, finalState, exactReplay);
  if (exactReplay) return assertResumeReplay(final, job);
  const payload = object(job.payload, "resume job payload");
  const predecessorJobId = requiredString(payload.resumesJobId, "resume predecessor job id");
  const checkpointId = optionalString(payload.resumeCheckpointId);
  if (checkpointId && !previous.decisions.some((decision) => decision.decisionReceiptId === checkpointId)) {
    throw new Error("Canonical resume is not bound to the selected predecessor checkpoint receipt.");
  }
  if (predecessorJobId === job.id) throw new Error("Canonical resume cannot name itself as predecessor.");
  const additions = final.decisions.filter((candidate) => !previous.decisions.some((item) => item.decisionId === candidate.decisionId));
  const decisionPrefix = checkpointId ? "resume:" : "bootstrap-resume:";
  const resumeDecisions = additions.filter((decision) => decision.decisionId.startsWith(decisionPrefix));
  const clearanceDecisions = additions.filter((decision) => decision.decisionId.startsWith("clearance:"));
  if (resumeDecisions.length !== 1 || resumeDecisions[0]?.decisionReceiptId !== job.id) {
    throw new Error("Canonical resume requires one authorization decision backed by the active resume job.");
  }
  const expectedClearanceIds = new Set(
    previous.blockedReasons.map(
      (blocker) =>
        `clearance:${storageCanonicalHasher
          .sha256Canonical({ runId: previous.runId, sourceReceiptId: blocker.sourceReceiptId, dispositionReceiptId: job.id })
          .slice(0, 48)}`
    )
  );
  if (
    clearanceDecisions.length !== expectedClearanceIds.size ||
    clearanceDecisions.some((decision) => decision.decisionReceiptId !== job.id || !expectedClearanceIds.has(decision.decisionId)) ||
    additions.length !== 1 + expectedClearanceIds.size
  ) {
    throw new Error("Canonical resume blocker clearances are not backed by the active resume job.");
  }
  if (revisions.length !== 1 + previous.blockedReasons.length * 2) {
    throw new Error("Canonical resume revision count does not match its authorization and blocker clearances.");
  }
  if (final.status !== "running" || final.blockedReasons.length !== 0 || !final.currentNodeId) {
    throw new Error("Canonical resume must restore the active node with no uncleared blocker.");
  }
  if (canonicalHash(resumeInvariant(previous)) !== canonicalHash(resumeInvariant(final))) {
    throw new Error("Canonical resume attempted to mutate state outside authorization and blocker clearance fields.");
  }
}

export function assertCanonicalCheckpointPlan(
  previous: RunStateRevision,
  revisions: readonly StorageCommitRunStateRevisionInput[],
  finalState: StorageCanonicalFinalState,
  step: StorageStepDispositionResult,
  exactReplay: boolean
): void {
  const final = plannedFinal(previous, revisions, finalState, exactReplay);
  const matching = final.decisions.filter((decision) => decision.decisionReceiptId === step.checkpoint.id);
  if (matching.length !== 1 || !matching[0]?.decisionId.startsWith("checkpoint:")) {
    throw new Error("Canonical checkpoint decision is not backed by the committed step checkpoint.");
  }
  if (!exactReplay) {
    if (revisions.length !== 1 || previous.decisions.some((decision) => decision.decisionId === matching[0]?.decisionId)) {
      throw new Error("Canonical checkpoint must append exactly one new checkpoint decision.");
    }
    if (canonicalHash(checkpointInvariant(previous)) !== canonicalHash(checkpointInvariant(final))) {
      throw new Error("Canonical checkpoint attempted to mutate unrelated run state.");
    }
  }
}

export function assertCanonicalBudgetPlan(previous: RunStateRevision, input: StorageCanonicalBudgetCommitInput): void {
  if (input.targetUsage.estimatedCostMicrousd !== 0) throw new Error("Unavailable provider monetary cost cannot be replaced with an estimate.");
  const final = plannedFinal(previous, input.revisions, input.finalState, input.exactReplay);
  assertBudgetReceipt(final, input.receiptHash);
  if (!budgetUsageEqual(final.budgetUsage, input.targetUsage)) throw new Error("Canonical budget plan did not reach its declared cumulative target.");
  if (input.exactReplay) return;
  if (input.revisions.length < 1 || input.revisions.length > 2) {
    throw new Error("Canonical budget plan requires one receipt revision and at most one usage revision.");
  }
  const states = input.revisions.map((revision) => parseStoredRunStateRevision(revision.revision.data));
  const receiptState = states.at(-1) as RunStateRevision;
  const usageState = states.length === 2 ? (states[0] as RunStateRevision) : previous;
  assertBudgetUsageTransition(previous, usageState, states.length === 2);
  assertBudgetReceiptTransition(usageState, receiptState);
  if (canonicalHash(budgetInvariant(previous)) !== canonicalHash(budgetInvariant(final))) {
    throw new Error("Canonical budget plan attempted to mutate unrelated run state.");
  }
}

export function assertCanonicalTerminalPlan(
  repositories: StorageV2RepositorySet,
  previous: RunStateRevision,
  revisions: readonly StorageCommitRunStateRevisionInput[],
  finalState: StorageCanonicalFinalState,
  terminal: StorageTerminalTransitionResult,
  exactReplay: boolean
): void {
  const final = plannedFinal(previous, revisions, finalState, exactReplay);
  const status = terminal.job.status;
  if (status === "completed") {
    assertCompletedTerminal(final, terminal);
    assertAuthoritativeTerminalReceipts(repositories, previous, final, terminal);
  } else if (status === "aborted") assertCancelledTerminal(final, terminal.job);
  else if (status === "blocked" || status === "failed") assertResumableTerminal(final, terminal.job);
  else if (status === "paused" || status === "interrupted") assertSuspendedTerminal(final);
  else throw new Error(`Canonical terminal transition does not support durable status ${status}.`);
}

function assertCompletedTerminal(final: RunStateRevision, terminal: StorageTerminalTransitionResult): void {
  if (final.status !== "completed" || final.terminalReceipt?.outcome !== "completed") {
    throw new Error("Completed durable jobs require a completed canonical state and receipt.");
  }
  const nodeReceipt = final.completedNodeReceipts.at(-1);
  const checkpointId = terminal.stepDisposition?.checkpoint.id;
  if (!nodeReceipt || !checkpointId) throw new Error("Canonical completion lacks a checkpoint-bearing node receipt.");
  const acceptance = final.terminalReceipt.acceptanceReceiptIds;
  if (!acceptance.length || acceptance.some((receipt) => !nodeReceipt.verifierReceiptIds.includes(receipt))) {
    throw new Error("Canonical acceptance receipts are not backed by node verifier receipts.");
  }
  for (const link of terminal.links) {
    if (link.outputKind === "source") throw new Error("Raw source output cannot be promoted into canonical completion.");
    const matched =
      link.outputKind === "artifact"
        ? nodeReceipt.artifactRefs.some((item) => item.artifactId === link.outputId)
        : nodeReceipt.evidenceRefs.some((item) => item.evidenceId === link.outputId);
    if (!matched) throw new Error(`Canonical completion omitted promoted output receipt ${link.id}.`);
  }
}

function assertCancelledTerminal(final: RunStateRevision, job: StorageJob): void {
  if (final.status !== "cancelled" || final.terminalReceipt?.outcome !== "cancelled" || final.terminalReceipt.reasonCode !== "USER_ABORTED") {
    throw new Error(`Aborted durable job ${job.id} requires an explicitly authorized canonical cancellation receipt.`);
  }
}

function assertResumableTerminal(final: RunStateRevision, job: StorageJob): void {
  if (final.status !== "blocked" || final.terminalReceipt || !final.blockedReasons.some((reason) => reason.sourceReceiptId === job.id)) {
    throw new Error(`Recoverable durable job ${job.id} must remain a non-terminal canonical blocker.`);
  }
}

function assertSuspendedTerminal(final: RunStateRevision): void {
  if (final.terminalReceipt || (final.status !== "running" && final.status !== "blocked")) {
    throw new Error("Paused or interrupted durable work must remain resumable in canonical state.");
  }
}

function assertResumeReplay(state: RunStateRevision, job: StorageJob): void {
  if (
    state.status !== "running" ||
    state.blockedReasons.length ||
    !state.decisions.some(
      (item) => item.decisionReceiptId === job.id && (item.decisionId.startsWith("resume:") || item.decisionId.startsWith("bootstrap-resume:"))
    )
  ) {
    throw new Error("Canonical resume replay lacks its durable authorization decision.");
  }
}

function plannedFinal(
  previous: RunStateRevision,
  revisions: readonly StorageCommitRunStateRevisionInput[],
  expected: StorageCanonicalFinalState,
  exactReplay: boolean
): RunStateRevision {
  const final = exactReplay ? previous : parseStoredRunStateRevision(requiredLast(revisions).revision.data);
  if (final.revision !== expected.revision || final.stateHash !== expected.stateHash) {
    throw new Error("Canonical plan does not match its declared final revision and hash.");
  }
  return final;
}

function resumeInvariant(state: RunStateRevision): unknown {
  const { revision, parentRevisionHash, stateHash, status, decisions, blockedReasons, updatedAt, ...invariant } = state;
  void revision;
  void parentRevisionHash;
  void stateHash;
  void status;
  void decisions;
  void blockedReasons;
  void updatedAt;
  return invariant;
}

function checkpointInvariant(state: RunStateRevision): unknown {
  const { revision, parentRevisionHash, stateHash, decisions, updatedAt, ...invariant } = state;
  void revision;
  void parentRevisionHash;
  void stateHash;
  void decisions;
  void updatedAt;
  return invariant;
}

function assertBudgetReceipt(state: RunStateRevision, receiptHash: string): void {
  if (!/^[a-f0-9]{64}$/.test(receiptHash)) throw new Error("Canonical budget receipt hash is malformed.");
  const decision = [...state.decisions].reverse().find((item) => item.decisionId.startsWith(CANONICAL_BUDGET_DECISION_PREFIX));
  if (
    decision?.decisionId !== `${CANONICAL_BUDGET_DECISION_PREFIX}${receiptHash}` ||
    decision.decisionReceiptId !== `${CANONICAL_BUDGET_RECEIPT_PREFIX}${receiptHash}`
  ) {
    throw new Error("Canonical budget state lacks its immutable accounting receipt.");
  }
}

function assertBudgetUsageTransition(previous: RunStateRevision, next: RunStateRevision, changed: boolean): void {
  const deltas = Object.keys(previous.budgetUsage).map(
    (key) => next.budgetUsage[key as keyof typeof next.budgetUsage] - previous.budgetUsage[key as keyof typeof previous.budgetUsage]
  );
  if (
    deltas.some((value) => value < 0) ||
    changed !== deltas.some((value) => value > 0) ||
    canonicalHash(usageInvariant(previous)) !== canonicalHash(usageInvariant(next))
  ) {
    throw new Error("Canonical budget usage revision is not a monotonic reducer transition.");
  }
}

function assertBudgetReceiptTransition(previous: RunStateRevision, next: RunStateRevision): void {
  const additions = next.decisions.filter((candidate) => !previous.decisions.some((item) => item.decisionId === candidate.decisionId));
  if (additions.length !== 1 || !additions[0]?.decisionId.startsWith(CANONICAL_BUDGET_DECISION_PREFIX)) {
    throw new Error("Canonical budget accounting must append exactly one immutable receipt decision.");
  }
  if (canonicalHash(receiptInvariant(previous)) !== canonicalHash(receiptInvariant(next))) {
    throw new Error("Canonical budget receipt revision mutated unrelated run state.");
  }
}

function budgetInvariant(state: RunStateRevision): unknown {
  const { revision, parentRevisionHash, stateHash, budgetUsage, decisions, updatedAt, ...invariant } = state;
  void revision;
  void parentRevisionHash;
  void stateHash;
  void budgetUsage;
  void decisions;
  void updatedAt;
  return invariant;
}

function usageInvariant(state: RunStateRevision): unknown {
  const { revision, parentRevisionHash, stateHash, budgetUsage, updatedAt, ...invariant } = state;
  void revision;
  void parentRevisionHash;
  void stateHash;
  void budgetUsage;
  void updatedAt;
  return invariant;
}

function receiptInvariant(state: RunStateRevision): unknown {
  const { revision, parentRevisionHash, stateHash, decisions, updatedAt, ...invariant } = state;
  void revision;
  void parentRevisionHash;
  void stateHash;
  void decisions;
  void updatedAt;
  return invariant;
}

function canonicalHash(value: unknown): string {
  return storageCanonicalHasher.sha256Canonical(value);
}

function requiredLast<T>(values: readonly T[]): T {
  const value = values.at(-1);
  if (!value) throw new Error("Canonical transition is missing its final revision.");
  return value;
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Canonical ${label} is malformed.`);
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value) throw new Error(`Canonical ${label} is missing.`);
  return value;
}

function optionalString(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !value) throw new Error("Canonical optional receipt identifier is malformed.");
  return value;
}
