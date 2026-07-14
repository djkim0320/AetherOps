import type { CanonicalHasher } from "../../core/orchestration/orchestrationSchemas.js";
import type { RunStateRevision } from "../../core/orchestration/runStateCapsule.js";
import type { RunStateEvent } from "../../core/orchestration/runStateEvents.js";
import { reduceRunStateRevision } from "../../core/orchestration/runStateReducer.js";
import type { TaskContract } from "../../core/orchestration/taskContract.js";
import { LEGACY_RESEARCH_LOOP_NODE_ID } from "./canonicalTaskContractBuilder.js";
import {
  CanonicalRunRuntimeError,
  type CanonicalRevisionPlan,
  type RecordCanonicalCompletionInput,
  type RecordCanonicalTerminalInput
} from "./canonicalRunTypes.js";

export function prepareCanonicalTerminalPlan(
  input: RecordCanonicalTerminalInput,
  contract: TaskContract,
  state: RunStateRevision,
  hasher: CanonicalHasher
): CanonicalRevisionPlan {
  assertCanonicalTerminalInput(input);
  return input.outcome === "completed" ? completionPlan(input, contract, state, hasher) : nonCompletionPlan(input, state, hasher);
}

function completionPlan(
  input: RecordCanonicalCompletionInput & { outcome: "completed" },
  contract: TaskContract,
  current: RunStateRevision,
  hasher: CanonicalHasher
): CanonicalRevisionPlan {
  const { nodeReceipt, acceptanceReceiptIds } = buildNodeCompletionReceipt(input, contract, current, hasher);
  if (current.status === "completed") {
    assertExactNodeReceipt(current, nodeReceipt.receiptHash);
    const terminal = completionTerminationReceipt(current, acceptanceReceiptIds, input.terminatedAt, hasher);
    if (current.terminalReceipt?.receiptHash !== terminal.receiptHash) terminalConflict("Completed-run replay changed its terminal receipt.");
    return exactReplay(current);
  }
  if (current.status === "failed" || current.status === "cancelled") terminalConflict("A non-completed terminal run cannot be completed.");
  const revisions: RunStateRevision[] = [];
  let state = current;
  if (state.status === "running") {
    assertExpectedState(input, state);
    state = reduceRunStateRevision(state, nodeCompletedEvent(state, nodeReceipt, input.completedAt, hasher), hasher);
    revisions.push(state);
  } else if (state.status === "awaiting_completion") {
    assertExactNodeReceipt(state, nodeReceipt.receiptHash);
  } else {
    throw new CanonicalRunRuntimeError("CANONICAL_RUN_NOT_READY", "Completion requires a running or receipt-complete canonical node.");
  }
  const terminal = completionTerminationReceipt(state, acceptanceReceiptIds, input.terminatedAt, hasher);
  state = reduceRunStateRevision(state, terminatedEvent(state, terminal, input.terminatedAt, hasher), hasher);
  revisions.push(state);
  return { expectedRevision: current.revision, revisions, finalState: state, exactReplay: false };
}

function nonCompletionPlan(
  input: RecordCanonicalTerminalInput & { outcome: "failed" | "cancelled" },
  state: RunStateRevision,
  hasher: CanonicalHasher
): CanonicalRevisionPlan {
  const receipt = nonCompletionReceipt(input, state, hasher);
  if (isTerminal(state)) {
    if (state.status !== input.outcome || state.terminalReceipt?.receiptHash !== receipt.receiptHash) {
      terminalConflict("Terminal replay changed its outcome, reason, or receipt.");
    }
    return exactReplay(state);
  }
  assertExpectedState(input, state);
  const finalState = reduceRunStateRevision(state, terminatedEvent(state, receipt, input.recordedAt, hasher), hasher);
  return { expectedRevision: state.revision, revisions: [finalState], finalState, exactReplay: false };
}

function buildNodeCompletionReceipt(input: RecordCanonicalCompletionInput, contract: TaskContract, state: RunStateRevision, hasher: CanonicalHasher) {
  const byCriterion = new Map(input.acceptanceVerifiers.map((item) => [item.criterionId, item.verifierReceiptId]));
  const acceptanceReceiptIds = contract.acceptanceCriteria.map((criterion) => byCriterion.get(criterion.id));
  const knownCriteria = new Set(contract.acceptanceCriteria.map((criterion) => criterion.id));
  if (
    byCriterion.size !== input.acceptanceVerifiers.length ||
    acceptanceReceiptIds.some((id) => !id) ||
    input.acceptanceVerifiers.some((item) => !knownCriteria.has(item.criterionId)) ||
    new Set(input.acceptanceVerifiers.map((item) => item.verifierReceiptId)).size !== input.acceptanceVerifiers.length
  ) {
    missingAcceptanceVerifier();
  }
  const nodeVerifiers = [...new Set(input.nodeVerifierReceiptIds)].sort();
  if (nodeVerifiers.length !== input.nodeVerifierReceiptIds.length || acceptanceReceiptIds.some((id) => !nodeVerifiers.includes(id!))) {
    missingAcceptanceVerifier();
  }
  const seed = {
    runId: state.runId,
    projectId: state.projectId,
    nodeId: LEGACY_RESEARCH_LOOP_NODE_ID,
    artifactRefs: [...input.artifactRefs].sort((left, right) => left.artifactId.localeCompare(right.artifactId)),
    evidenceRefs: [...input.evidenceRefs].sort((left, right) => left.evidenceId.localeCompare(right.evidenceId)),
    verifierReceiptIds: nodeVerifiers,
    completedAt: input.completedAt
  };
  const withoutHash = { receiptId: `receipt:node:${hasher.sha256Canonical(seed).slice(0, 48)}`, ...seed };
  return { nodeReceipt: { ...withoutHash, receiptHash: hasher.sha256Canonical(withoutHash) }, acceptanceReceiptIds: acceptanceReceiptIds as string[] };
}

function completionTerminationReceipt(state: RunStateRevision, acceptanceReceiptIds: string[], createdAt: string, hasher: CanonicalHasher) {
  const seed = {
    runId: state.runId,
    projectId: state.projectId,
    completedNodeReceiptIds: state.completedNodeReceipts.map((receipt) => receipt.receiptId),
    createdAt,
    outcome: "completed" as const,
    acceptanceReceiptIds
  };
  return hashedTerminationReceipt(seed, hasher);
}

function nonCompletionReceipt(input: RecordCanonicalTerminalInput & { outcome: "failed" | "cancelled" }, state: RunStateRevision, hasher: CanonicalHasher) {
  return hashedTerminationReceipt(
    {
      runId: state.runId,
      projectId: state.projectId,
      completedNodeReceiptIds: state.completedNodeReceipts.map((receipt) => receipt.receiptId),
      createdAt: input.recordedAt,
      outcome: input.outcome,
      reasonCode: input.reasonCode
    },
    hasher
  );
}

function hashedTerminationReceipt<Seed extends object>(seed: Seed, hasher: CanonicalHasher) {
  const withoutHash = { receiptId: `receipt:run:${hasher.sha256Canonical(seed).slice(0, 48)}`, ...seed };
  return { ...withoutHash, receiptHash: hasher.sha256Canonical(withoutHash) };
}

function nodeCompletedEvent(
  state: RunStateRevision,
  receipt: ReturnType<typeof buildNodeCompletionReceipt>["nodeReceipt"],
  occurredAt: string,
  hasher: CanonicalHasher
): RunStateEvent {
  return guardedEvent(state, occurredAt, "node.completed", { receipt }, hasher) as RunStateEvent;
}

function terminatedEvent(state: RunStateRevision, receipt: object, occurredAt: string, hasher: CanonicalHasher): RunStateEvent {
  return guardedEvent(state, occurredAt, "run.terminated", { receipt }, hasher) as RunStateEvent;
}

function guardedEvent(state: RunStateRevision, occurredAt: string, type: string, payload: object, hasher: CanonicalHasher): object {
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

function assertCanonicalTerminalInput(input: RecordCanonicalTerminalInput): void {
  assertStable(input.owner.projectId, "project id");
  assertStable(input.owner.runId, "run id");
  assertStable(input.owner.jobId, "job id");
  if (input.outcome !== "completed") {
    const required = input.outcome === "failed" ? "explicit_permanent_failure" : "explicit_abort";
    if (input.terminalAuthorization !== required) invalid("Terminal failure or cancellation requires an explicit permanent disposition.");
    if (!/^[A-Z][A-Z0-9_]{0,119}$/.test(input.reasonCode) || !validTime(input.recordedAt)) invalid("Terminal reason and timestamp are invalid.");
    return;
  }
  if (
    !validTime(input.completedAt) ||
    !validTime(input.terminatedAt) ||
    Date.parse(input.terminatedAt) < Date.parse(input.completedAt) ||
    input.artifactRefs.length > 128 ||
    input.evidenceRefs.length > 128 ||
    input.nodeVerifierReceiptIds.length > 64 ||
    input.acceptanceVerifiers.length > 64
  ) {
    invalid("Completion timestamps or receipt bounds are invalid.");
  }
  validateResources(input);
  assertUnique(input.nodeVerifierReceiptIds, "node verifier receipt");
  for (const id of input.nodeVerifierReceiptIds) assertStable(id, "node verifier receipt id");
  for (const verifier of input.acceptanceVerifiers) {
    assertStable(verifier.criterionId, "acceptance criterion id");
    assertStable(verifier.verifierReceiptId, "acceptance verifier receipt id");
  }
}

function validateResources(input: RecordCanonicalCompletionInput): void {
  const resources = [
    ...input.artifactRefs.map((item) => ({
      id: item.artifactId,
      projectId: item.projectId,
      hash: item.contentHash,
      attestationId: item.attestationId,
      attestationHash: item.attestationHash,
      receiptId: item.promotionReceiptId
    })),
    ...input.evidenceRefs.map((item) => ({
      id: item.evidenceId,
      projectId: item.projectId,
      hash: item.contentHash,
      attestationId: item.attestationId,
      attestationHash: item.attestationHash,
      receiptId: item.verificationReceiptId
    }))
  ];
  if (resources.some((item) => item.projectId !== input.owner.projectId)) ownership("Terminal resources contain a cross-project reference.");
  for (const resource of resources) {
    assertStable(resource.id, "resource id");
    assertStable(resource.receiptId, "resource receipt id");
    assertStable(resource.attestationId, "resource attestation id");
    if (!/^[a-f0-9]{64}$/.test(resource.hash) || !/^[a-f0-9]{64}$/.test(resource.attestationHash)) {
      invalid("Terminal resource and attestation hashes must be lowercase SHA-256 digests.");
    }
  }
  assertUnique(
    input.artifactRefs.map((item) => item.artifactId),
    "artifact reference"
  );
  assertUnique(
    input.evidenceRefs.map((item) => item.evidenceId),
    "evidence reference"
  );
}

function assertExpectedState(input: { expectedState: { revision: number; stateHash: string } }, state: RunStateRevision): void {
  if (input.expectedState.revision !== state.revision || input.expectedState.stateHash !== state.stateHash) {
    throw new CanonicalRunRuntimeError(
      "CANONICAL_STATE_STALE",
      `Canonical run state changed: expected revision ${input.expectedState.revision}, actual ${state.revision}.`
    );
  }
}

function assertExactNodeReceipt(state: RunStateRevision, expectedHash: string): void {
  const receipt = state.completedNodeReceipts.find((item) => item.nodeId === LEGACY_RESEARCH_LOOP_NODE_ID);
  if (!receipt || receipt.receiptHash !== expectedHash) terminalConflict("Node-completion replay changed its receipt or resource references.");
}

function exactReplay(state: RunStateRevision): CanonicalRevisionPlan {
  return { expectedRevision: state.revision, revisions: [], finalState: state, exactReplay: true };
}

function isTerminal(state: RunStateRevision): boolean {
  return state.status === "completed" || state.status === "failed" || state.status === "cancelled";
}

function assertUnique(values: string[], label: string): void {
  if (new Set(values).size !== values.length) invalid(`Duplicate ${label}.`);
}

function assertStable(value: string, label: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(value)) invalid(`${label} must be a stable identifier.`);
}

function validTime(value: string): boolean {
  return Number.isFinite(Date.parse(value));
}

function missingAcceptanceVerifier(): never {
  throw new CanonicalRunRuntimeError("MISSING_ACCEPTANCE_VERIFIER", "Every task acceptance criterion requires one unique node verifier receipt.");
}

function terminalConflict(message: string): never {
  throw new CanonicalRunRuntimeError("CANONICAL_TERMINAL_CONFLICT", message);
}

function ownership(message: string): never {
  throw new CanonicalRunRuntimeError("CANONICAL_RUN_OWNERSHIP_MISMATCH", message);
}

function invalid(message: string): never {
  throw new CanonicalRunRuntimeError("INVALID_CANONICAL_RUN_INPUT", message);
}
