import {
  budgetUsageDelta,
  budgetUsageEqual,
  CANONICAL_BUDGET_DECISION_PREFIX,
  hasBudgetUsage,
  type CanonicalBudgetUsage
} from "../../core/orchestration/budgetAccounting.js";
import type { CanonicalHasher } from "../../core/orchestration/orchestrationSchemas.js";
import type { RunStateRevision } from "../../core/orchestration/runStateCapsule.js";
import type { RunStateEvent } from "../../core/orchestration/runStateEvents.js";
import { reduceRunStateRevision } from "../../core/orchestration/runStateReducer.js";
import { CanonicalRunRuntimeError, type CanonicalRevisionPlan, type CanonicalRunOwner, type CanonicalStateExpectation } from "./canonicalRunTypes.js";

export interface PrepareCanonicalBudgetInput {
  owner: CanonicalRunOwner;
  expectedState: CanonicalStateExpectation;
  target: CanonicalBudgetUsage;
  decisionId: string;
  receiptId: string;
  receiptHash: string;
  recordedAt: string;
}

export function prepareCanonicalBudgetPlan(input: PrepareCanonicalBudgetInput, state: RunStateRevision, hasher: CanonicalHasher): CanonicalRevisionPlan {
  assertInput(input, state);
  const latest = [...state.decisions].reverse().find((decision) => decision.decisionId.startsWith(CANONICAL_BUDGET_DECISION_PREFIX));
  if (budgetUsageEqual(state.budgetUsage, input.target) && latest?.decisionId === input.decisionId && latest.decisionReceiptId === input.receiptId) {
    return { expectedRevision: state.revision, revisions: [], finalState: state, exactReplay: true };
  }
  const delta = budgetUsageDelta(state.budgetUsage, input.target);
  const revisions: RunStateRevision[] = [];
  let current = state;
  if (hasBudgetUsage(delta)) {
    current = reduceRunStateRevision(current, budgetEvent(input, current, delta), hasher);
    revisions.push(current);
  }
  current = reduceRunStateRevision(current, receiptEvent(input, current), hasher);
  revisions.push(current);
  return { expectedRevision: state.revision, revisions, finalState: current, exactReplay: false };
}

function budgetEvent(input: PrepareCanonicalBudgetInput, state: RunStateRevision, delta: CanonicalBudgetUsage): RunStateEvent {
  return {
    ...eventIdentity(input, state, "consumed"),
    type: "budget.consumed",
    delta
  };
}

function receiptEvent(input: PrepareCanonicalBudgetInput, state: RunStateRevision): RunStateEvent {
  return {
    ...eventIdentity(input, state, "receipt"),
    type: "decision.recorded",
    decision: { decisionId: input.decisionId, decisionReceiptId: input.receiptId, recordedAt: input.recordedAt }
  };
}

function eventIdentity(input: PrepareCanonicalBudgetInput, state: RunStateRevision, kind: string) {
  return {
    schemaVersion: 1 as const,
    eventId: `event:budget:${input.receiptHash.slice(0, 40)}:${kind}`,
    runId: input.owner.runId,
    projectId: input.owner.projectId,
    expectedRevision: state.revision,
    expectedStateHash: state.stateHash,
    occurredAt: input.recordedAt
  };
}

function assertInput(input: PrepareCanonicalBudgetInput, state: RunStateRevision): void {
  if (
    input.owner.projectId !== state.projectId ||
    input.owner.runId !== state.runId ||
    input.expectedState.revision !== state.revision ||
    input.expectedState.stateHash !== state.stateHash
  ) {
    throw new CanonicalRunRuntimeError("CANONICAL_STATE_STALE", "Budget accounting expected a different canonical run-state revision.");
  }
  if (
    !/^[a-f0-9]{64}$/.test(input.receiptHash) ||
    !input.decisionId.endsWith(input.receiptHash) ||
    !input.receiptId.endsWith(input.receiptHash) ||
    !Number.isFinite(Date.parse(input.recordedAt))
  ) {
    throw new CanonicalRunRuntimeError("INVALID_CANONICAL_RUN_INPUT", "Canonical budget accounting receipt is malformed.");
  }
}
