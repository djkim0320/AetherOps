import { hashCanonical, hashTraceCanonical } from "./canonical.js";
import { HarnessError } from "./errors.js";
import { TraceSchema, type TraceEvent } from "./traceSchemas.js";
import { validateTraceContentBindings, validateTraceEnvelope } from "./traceIntegrity.js";
import { applyWorkOrderCompleted, applyWorkOrderCreated, type ReplayedWorkOrder } from "./workOrderReplay.js";

export type { ReplayedWorkOrder } from "./workOrderReplay.js";

export interface ReplayedToolCall {
  callId: string;
  selectionId: string;
  toolName: string;
  toolVersion: string;
  inputHash: string;
  mutating: boolean;
  idempotencyKey?: string;
  dependencyCallIds: string[];
  attempts: number;
  outcome?: string;
  verified?: boolean;
  outputArtifactIds: string[];
  promotedArtifactIds: string[];
  sideEffectReceiptId?: string;
}

export interface CanonicalTraceState {
  runId: string;
  task?: { taskId: string; taskContractHash: string; objectiveHash: string };
  revision: number | null;
  contextPackHashes: string[];
  selectedTools: Array<{ selectionId: string; toolName: string; rank: number }>;
  toolCalls: ReplayedToolCall[];
  rejectedCalls: Array<{ callId: string; toolName: string; reasonCode: string }>;
  recoveries: Array<{ failedCallId: string; strategy: string; retryCallId?: string }>;
  memory: {
    candidates: Array<{ candidateId: string; scope: string; sourceArtifactIds: string[]; contentHash: string; disposition?: string }>;
    retrievedRecordIds: string[];
    revalidated: Array<{ recordId: string; valid: boolean }>;
  };
  skills: Array<{ skillId: string; version: string }>;
  workOrders: ReplayedWorkOrder[];
  acceptance: Array<{ criterionId: string; passed: boolean }>;
  result?: string;
}

export interface TraceReplayResult {
  events: TraceEvent[];
  canonicalState: CanonicalTraceState;
  canonicalStateHash: string;
  canonicalTraceHash: string;
  rootHash: string;
  duplicateSideEffects: number;
}

interface ReplayContext {
  state: CanonicalTraceState;
  selections: Map<string, { toolName: string }>;
  calls: Map<string, ReplayedToolCall>;
  activeAttempts: Map<string, number>;
  memoryCandidates: Set<string>;
  retrievedMemory: Set<string>;
  workOrders: Map<string, ReplayedWorkOrder>;
  completedWorkOrders: Set<string>;
  receipts: Map<string, { receiptId: string; inputHash: string }>;
  lastRevision: number | null;
  lastCandidates: string[];
  lastTopK: number;
  rejectedCallIds: Set<string>;
  promotedArtifacts: Set<string>;
  pendingRetries: Set<string>;
}

export async function replayTrace(input: readonly TraceEvent[]): Promise<TraceReplayResult> {
  return replayTraceInternal(input, true);
}

export async function replayTracePrefix(input: readonly TraceEvent[]): Promise<TraceReplayResult> {
  return replayTraceInternal(input, false);
}

async function replayTraceInternal(input: readonly TraceEvent[], requireTerminal: boolean): Promise<TraceReplayResult> {
  const events = TraceSchema.parse(input);
  await validateTraceEnvelope(events, requireTerminal);
  await validateTraceContentBindings(events);
  const context = createReplayContext(events[0]!.runId);
  for (const event of events) applyEvent(context, event);
  validateTerminalState(context, events, requireTerminal);
  context.state.toolCalls = [...context.calls.values()].sort((left, right) => left.callId.localeCompare(right.callId));
  context.state.selectedTools.sort((left, right) => left.selectionId.localeCompare(right.selectionId));
  context.state.rejectedCalls.sort((left, right) => left.callId.localeCompare(right.callId));
  context.state.memory.candidates.sort((left, right) => left.candidateId.localeCompare(right.candidateId));
  context.state.memory.retrievedRecordIds.sort();
  context.state.memory.revalidated.sort((left, right) => left.recordId.localeCompare(right.recordId));
  context.state.skills.sort((left, right) => left.skillId.localeCompare(right.skillId));
  context.state.workOrders.sort((left, right) => left.workOrderId.localeCompare(right.workOrderId));
  return {
    events,
    canonicalState: context.state,
    canonicalStateHash: await hashCanonical(context.state),
    canonicalTraceHash: await hashTraceCanonical(events),
    rootHash: events.at(-1)!.eventHash,
    duplicateSideEffects: 0
  };
}

function createReplayContext(runId: string): ReplayContext {
  return {
    state: {
      runId,
      revision: null,
      contextPackHashes: [],
      selectedTools: [],
      toolCalls: [],
      rejectedCalls: [],
      recoveries: [],
      memory: { candidates: [], retrievedRecordIds: [], revalidated: [] },
      skills: [],
      workOrders: [],
      acceptance: []
    },
    selections: new Map(),
    calls: new Map(),
    activeAttempts: new Map(),
    memoryCandidates: new Set(),
    retrievedMemory: new Set(),
    workOrders: new Map(),
    completedWorkOrders: new Set(),
    receipts: new Map(),
    lastRevision: null,
    lastCandidates: [],
    lastTopK: 0,
    rejectedCallIds: new Set(),
    promotedArtifacts: new Set(),
    pendingRetries: new Set()
  };
}

function applyEvent(context: ReplayContext, event: TraceEvent): void {
  switch (event.type) {
    case "task.created":
      context.state.task = { ...event.data };
      return;
    case "run_state.revised":
      applyRevision(context, event.data);
      return;
    case "context.compiled":
      context.state.contextPackHashes.push(event.data.contextPackHash);
      return;
    case "tool.candidates.retrieved":
      if (new Set(event.data.candidateNames).size !== event.data.candidateNames.length) invalid("Tool candidate retrieval contains duplicate names.");
      if (event.data.topK > event.data.candidateNames.length) invalid("Tool candidate topK exceeds the returned candidate count.");
      context.lastCandidates = [...event.data.candidateNames];
      context.lastTopK = event.data.topK;
      return;
    case "tool.selected":
      if (event.data.rank > context.lastTopK || context.lastCandidates[event.data.rank - 1] !== event.data.toolName)
        invalid(`Selected tool rank does not match retrieved candidates: ${event.data.toolName}`);
      if (context.selections.has(event.data.selectionId)) invalid(`Tool selection ID is duplicated: ${event.data.selectionId}`);
      context.selections.set(event.data.selectionId, { toolName: event.data.toolName });
      context.state.selectedTools.push({ selectionId: event.data.selectionId, toolName: event.data.toolName, rank: event.data.rank });
      return;
    case "tool.call.proposed":
      applyToolProposal(context, event.data);
      return;
    case "tool.call.started":
      applyToolStart(context, event.data.callId, event.data.attempt, event.data.inputHash);
      return;
    case "tool.call.completed":
      applyToolCompletion(context, event.runId, event.data);
      return;
    case "tool.call.verified":
      applyToolVerification(context, event.data.callId, event.data.passed, event.data.promotedArtifactIds);
      return;
    case "tool.call.rejected":
      if (!context.lastCandidates.includes(event.data.toolName)) invalid(`Rejected tool was not retrieved as a candidate: ${event.data.toolName}`);
      if (context.rejectedCallIds.has(event.data.callId) || context.calls.has(event.data.callId))
        invalid(`Rejected tool call ID is duplicated: ${event.data.callId}`);
      context.rejectedCallIds.add(event.data.callId);
      context.state.rejectedCalls.push({ callId: event.data.callId, toolName: event.data.toolName, reasonCode: event.data.reasonCode });
      return;
    case "recovery.selected":
      applyRecovery(context, event.data.failedCallId, event.data.strategy, event.data.retryCallId);
      return;
    case "memory.candidate.created":
      if (context.memoryCandidates.has(event.data.candidateId)) invalid(`Memory candidate is duplicated: ${event.data.candidateId}`);
      context.memoryCandidates.add(event.data.candidateId);
      context.state.memory.candidates.push({
        candidateId: event.data.candidateId,
        scope: event.data.scope,
        sourceArtifactIds: [...event.data.sourceArtifactIds],
        contentHash: event.data.contentHash
      });
      return;
    case "memory.candidate.dispositioned":
      applyMemoryDisposition(context, event.data.candidateId, event.data.disposition);
      return;
    case "memory.retrieved":
      applyMemoryRetrieval(context, event);
      return;
    case "memory.revalidated":
      if (!context.retrievedMemory.has(event.data.recordId)) invalid(`Memory was revalidated before retrieval: ${event.data.recordId}`);
      context.state.memory.revalidated.push({ recordId: event.data.recordId, valid: event.data.valid });
      return;
    case "skill.selected":
      context.state.skills.push({ skillId: event.data.skillId, version: event.data.version });
      return;
    case "work_order.created":
      applyWorkOrderCreated(context, context.state.workOrders, event.data);
      return;
    case "work_order.completed":
      applyWorkOrderCompleted(context, event.data);
      return;
    case "acceptance.checked":
      if (context.state.acceptance.some((item) => item.criterionId === event.data.criterionId))
        invalid(`Acceptance criterion is duplicated: ${event.data.criterionId}`);
      context.state.acceptance.push({ criterionId: event.data.criterionId, passed: event.data.passed });
      return;
    case "eval.completed":
      context.state.result = event.data.result;
      return;
  }
}

function applyRevision(context: ReplayContext, data: Extract<TraceEvent, { type: "run_state.revised" }>["data"]): void {
  if (data.previousRevision !== context.lastRevision) invalid(`Run-state previous revision mismatch at revision ${data.revision}.`);
  const expected = context.lastRevision === null ? 0 : context.lastRevision + 1;
  if (data.revision !== expected) invalid(`Run-state revision must advance by one; expected ${expected}.`);
  context.lastRevision = data.revision;
  context.state.revision = data.revision;
}

function applyToolProposal(context: ReplayContext, data: Extract<TraceEvent, { type: "tool.call.proposed" }>["data"]): void {
  const selection = context.selections.get(data.selectionId);
  if (!selection || selection.toolName !== data.toolName) invalid(`Tool proposal has no matching selection: ${data.callId}`);
  if (context.calls.has(data.callId)) invalid(`Tool call ID is duplicated: ${data.callId}`);
  if (data.mutating && !data.idempotencyKey) invalid(`Mutating tool proposal has no idempotency key: ${data.callId}`);
  for (const dependency of data.dependencyCallIds) if (!context.calls.has(dependency)) invalid(`Tool call dependency was not proposed first: ${dependency}`);
  context.calls.set(data.callId, { ...data, attempts: 0, outputArtifactIds: [], promotedArtifactIds: [] });
}

function applyToolStart(context: ReplayContext, callId: string, attempt: number, inputHash: string): void {
  const call = requiredCall(context, callId);
  if (call.inputHash !== inputHash) invalid(`Tool start input hash differs from proposal: ${callId}`);
  if (context.activeAttempts.has(callId)) invalid(`Tool call already has an active attempt: ${callId}`);
  if (attempt !== call.attempts + 1) invalid(`Tool attempt is not contiguous for call: ${callId}`);
  if (attempt > 1) {
    if (call.outcome !== "transient_failure" || !context.pendingRetries.delete(callId))
      invalid(`Tool retry has no matching unconsumed transient recovery receipt: ${callId}`);
  }
  for (const dependencyId of call.dependencyCallIds) {
    const dependency = requiredCall(context, dependencyId);
    if (dependency.outcome !== "success" || dependency.verified !== true) invalid(`Tool dependency is not verified: ${dependencyId}`);
  }
  call.attempts = attempt;
  context.activeAttempts.set(callId, attempt);
}

function applyToolCompletion(context: ReplayContext, runId: string, data: Extract<TraceEvent, { type: "tool.call.completed" }>["data"]): void {
  const call = requiredCall(context, data.callId);
  if (context.activeAttempts.get(data.callId) !== data.attempt) invalid(`Tool completion has no matching active attempt: ${data.callId}`);
  context.activeAttempts.delete(data.callId);
  call.outcome = data.outcome;
  call.outputArtifactIds = [...data.outputArtifactIds];
  if (data.sideEffectReceipt) applySideEffectReceipt(context, runId, call, data.sideEffectReceipt);
}

function applySideEffectReceipt(
  context: ReplayContext,
  runId: string,
  call: ReplayedToolCall,
  receipt: NonNullable<Extract<TraceEvent, { type: "tool.call.completed" }>["data"]["sideEffectReceipt"]>
): void {
  if (!call.mutating || !call.idempotencyKey) invalid(`Non-mutating tool emitted a side-effect receipt: ${call.callId}`);
  if (
    receipt.runId !== runId ||
    receipt.toolName !== call.toolName ||
    receipt.toolVersion !== call.toolVersion ||
    receipt.effectKey !== call.idempotencyKey ||
    receipt.inputHash !== call.inputHash
  ) {
    invalid(`Side-effect receipt does not match run/tool/version/input/effect identity: ${call.callId}`);
  }
  const identity = `${receipt.runId}:${receipt.toolName}:${receipt.toolVersion}:${receipt.effectKey}`;
  const existing = context.receipts.get(identity);
  if (existing && (existing.receiptId !== receipt.receiptId || existing.inputHash !== receipt.inputHash))
    invalid(`Duplicate side effect detected for receipt identity: ${identity}`);
  context.receipts.set(identity, { receiptId: receipt.receiptId, inputHash: receipt.inputHash });
  call.sideEffectReceiptId = receipt.receiptId;
}

function applyToolVerification(context: ReplayContext, callId: string, passed: boolean, promotedArtifactIds: string[]): void {
  const call = requiredCall(context, callId);
  if (call.outcome !== "success" && call.outcome !== "partial") invalid(`Tool verification requires a completed result: ${callId}`);
  if (call.verified !== undefined) invalid(`Tool call was verified more than once: ${callId}`);
  if (passed && call.outcome !== "success") invalid(`Only a successful tool completion can pass verification: ${callId}`);
  if (!passed && promotedArtifactIds.length) invalid(`Failed verification promoted artifacts: ${callId}`);
  for (const artifactId of promotedArtifactIds)
    if (!call.outputArtifactIds.includes(artifactId)) invalid(`Verification promoted an artifact not emitted by the tool call: ${artifactId}`);
  call.verified = passed;
  call.promotedArtifactIds = [...promotedArtifactIds];
  if (passed) for (const artifactId of promotedArtifactIds) context.promotedArtifacts.add(artifactId);
}

function applyRecovery(context: ReplayContext, failedCallId: string, strategy: string, retryCallId?: string): void {
  const call = requiredCall(context, failedCallId);
  if (call.outcome !== "transient_failure" && call.outcome !== "permanent_failure" && call.outcome !== "partial")
    invalid(`Recovery has no failed or partial call: ${failedCallId}`);
  if (strategy === "retry") {
    if (call.outcome !== "transient_failure" || retryCallId !== failedCallId)
      invalid(`Retry recovery requires a transient failure and the same call ID: ${failedCallId}`);
    if (context.pendingRetries.has(failedCallId)) invalid(`Retry recovery receipt is duplicated: ${failedCallId}`);
    context.pendingRetries.add(failedCallId);
  } else if (retryCallId) {
    invalid(`Non-retry recovery cannot carry retryCallId: ${failedCallId}`);
  }
  context.state.recoveries.push({ failedCallId, strategy, ...(retryCallId ? { retryCallId } : {}) });
}

function applyMemoryDisposition(context: ReplayContext, candidateId: string, disposition: string): void {
  if (!context.memoryCandidates.has(candidateId)) invalid(`Memory disposition has no candidate: ${candidateId}`);
  const candidate = context.state.memory.candidates.find((item) => item.candidateId === candidateId)!;
  if (candidate.disposition) invalid(`Memory candidate was dispositioned twice: ${candidateId}`);
  if (disposition === "accepted") {
    for (const artifactId of candidate.sourceArtifactIds)
      if (!context.promotedArtifacts.has(artifactId)) invalid(`Accepted memory candidate references an unverified artifact: ${artifactId}`);
  }
  candidate.disposition = disposition;
}

function applyMemoryRetrieval(context: ReplayContext, event: Extract<TraceEvent, { type: "memory.retrieved" }>): void {
  if (!event.projectId || event.data.authorizationReceipt.requestedProjectId !== event.projectId)
    invalid("Memory authorization receipt does not match the trace project.");
  for (const record of event.data.records) {
    if (event.data.scope === "project" && record.owningProjectId !== event.projectId)
      invalid(`Cross-project memory retrieval is forbidden: ${record.recordId}`);
    context.retrievedMemory.add(record.recordId);
    context.state.memory.retrievedRecordIds.push(record.recordId);
  }
}

function validateTerminalState(context: ReplayContext, events: TraceEvent[], requireTerminal: boolean): void {
  if (context.activeAttempts.size) invalid(`Trace ended with active tool attempts: ${[...context.activeAttempts.keys()].join(", ")}`);
  if (context.pendingRetries.size) invalid(`Trace ended with unconsumed retry recovery receipts: ${[...context.pendingRetries.keys()].join(", ")}`);
  if (context.completedWorkOrders.size !== context.workOrders.size) invalid("Trace ended with incomplete work orders.");
  for (const call of context.calls.values()) {
    if (!call.outcome) invalid(`Trace ended with an uncompleted tool call: ${call.callId}`);
    if ((call.outcome === "success" || call.outcome === "partial") && call.verified === undefined)
      invalid(`Completed tool call has no terminal verifier disposition: ${call.callId}`);
  }
  for (const candidate of context.state.memory.candidates)
    if (!candidate.disposition) invalid(`Trace ended with an undispositioned memory candidate: ${candidate.candidateId}`);
  if (!requireTerminal) return;
  const terminal = events.at(-1);
  if (terminal?.type !== "eval.completed") invalid("Trace has no terminal eval event.");
  if (terminal.data.acceptanceTotal !== context.state.acceptance.length) invalid("Eval acceptance total does not match acceptance events.");
  const passed = context.state.acceptance.filter((item) => item.passed).length;
  if (terminal.data.acceptancePassed !== passed) invalid("Eval acceptance pass count does not match acceptance events.");
  const allPassed = passed === context.state.acceptance.length;
  if ((terminal.data.result === "passed") !== allPassed) invalid("Eval result does not match deterministic acceptance outcomes.");
}

function requiredCall(context: ReplayContext, callId: string): ReplayedToolCall {
  const call = context.calls.get(callId);
  if (!call) invalid(`Trace references an unknown tool call: ${callId}`);
  return call;
}

function invalid(message: string): never {
  throw new HarnessError("TRACE_INVALID", message);
}
