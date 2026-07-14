import { hashCanonical, hashCanonicalSync } from "./canonical.js";
import type { EvalRun } from "./evalSchemas.js";
import type { DeterministicGradeMetrics } from "./graders.js";
import type { DeterministicCasePlan } from "./testProviders.js";
import { DeterministicTraceRecorder } from "./traceRecorder.js";
import { replayTrace } from "./traceReplay.js";

export interface ToolExecutionMetrics {
  attempts: number;
  retries: number;
  outputBytes: number;
  completedCallIds: string[];
  failedCallIds: Set<string>;
}

export function createToolExecutionMetrics(): ToolExecutionMetrics {
  return { attempts: 0, retries: 0, outputBytes: 0, completedCallIds: [], failedCallIds: new Set() };
}

export function gradeMetrics(plan: DeterministicCasePlan, durationMs: number, tool: ToolExecutionMetrics): DeterministicGradeMetrics {
  return { durationMs, inputTokens: plan.inputTokens, outputTokens: plan.outputTokens, toolCalls: tool.attempts, retries: tool.retries, estimatedCostUsd: 0 };
}

export function metricEnvelope(
  plan: DeterministicCasePlan,
  metrics: DeterministicGradeMetrics,
  tool: ToolExecutionMetrics,
  duplicateSideEffects: number,
  restartRecovered: boolean,
  sideEffectObserved: boolean
) {
  const number = (value: number, unit: string) => ({ value, unit });
  const boolean = (value: boolean) => ({ value, unit: "boolean" as const });
  const unmeasuredNumber = (unit: string, unmeasuredReason: string) => ({ value: null, unit, unmeasuredReason });
  const unmeasuredBoolean = (unmeasuredReason: string) => ({ value: null, unit: "boolean" as const, unmeasuredReason });
  const restartApplicable = plan.calls.some((call) => call.toolName === "state.checkpoint");
  return {
    durationMs: number(metrics.durationMs, "ms"),
    inputTokens: number(metrics.inputTokens, "tokens"),
    outputTokens: number(metrics.outputTokens, "tokens"),
    contextTokens: number(plan.contextTokens, "tokens"),
    toolCalls: number(metrics.toolCalls, "calls"),
    retries: number(metrics.retries, "retries"),
    estimatedCostUsd: number(metrics.estimatedCostUsd, "usd"),
    humanIntervention: boolean(false),
    invalidArguments: number(0, "arguments"),
    duplicateSideEffects: sideEffectObserved ? number(duplicateSideEffects, "effects") : unmeasuredNumber("effects", "Case emitted no side-effect receipt."),
    totalToolOutputBytes: number(tool.outputBytes, "bytes"),
    restartRecovered: restartApplicable ? boolean(restartRecovered) : unmeasuredBoolean("Case does not exercise deterministic restart recovery."),
    peakConcurrency: number(1, "workers")
  };
}

export function restartRecoveredFromReplay(replay: Awaited<ReturnType<typeof replayTrace>>): boolean {
  const checkpoint = replay.canonicalState.toolCalls.find(
    (call) => call.toolName === "state.checkpoint" && call.attempts > 1 && call.outcome === "success" && call.verified === true
  );
  return Boolean(
    checkpoint &&
    replay.canonicalState.recoveries.some(
      (recovery) => recovery.failedCallId === checkpoint.callId && recovery.strategy === "retry" && recovery.retryCallId === checkpoint.callId
    ) &&
    replay.events.some((event) => event.type === "run_state.revised" && event.data.reason === "resume")
  );
}

export async function emitMemory(plan: DeterministicCasePlan, recorder: DeterministicTraceRecorder): Promise<void> {
  for (const retrieval of plan.memory.retrievals) {
    await recorder.emit("memory.retrieved", {
      queryHash: await hashCanonical({ caseId: recorder.caseId, records: retrieval.records.map((record) => record.recordId) }),
      ...retrieval,
      authorizationReceipt: {
        requestedProjectId: recorder.projectId,
        decision: "allowed",
        policyHash: await hashCanonical({ projectId: recorder.projectId, scope: retrieval.scope })
      }
    });
  }
  for (const revalidation of plan.memory.revalidations) await recorder.emit("memory.revalidated", revalidation);
  for (const candidate of plan.memory.candidates) {
    await recorder.emit("memory.candidate.created", {
      candidateId: candidate.candidateId,
      sourceArtifactIds: candidate.sourceArtifactIds,
      scope: candidate.scope,
      contentHash: await hashCanonical({ candidateId: candidate.candidateId, sourceArtifactIds: candidate.sourceArtifactIds })
    });
    await recorder.emit("memory.candidate.dispositioned", {
      candidateId: candidate.candidateId,
      disposition: candidate.disposition,
      policyReason: candidate.policyReason
    });
  }
}

export async function emitSkillsAndWorkOrders(plan: DeterministicCasePlan, recorder: DeterministicTraceRecorder): Promise<void> {
  for (const skill of plan.skills) await recorder.emit("skill.selected", skill);
  for (const workOrder of plan.workOrders) {
    await recorder.emit("work_order.created", {
      workOrderId: workOrder.workOrderId,
      readOnly: workOrder.readOnly,
      scopeKeys: workOrder.scopeKeys,
      dependencyWorkOrderIds: workOrder.dependencyWorkOrderIds
    });
  }
  for (const workOrder of plan.workOrders) {
    await recorder.emit("work_order.completed", {
      workOrderId: workOrder.workOrderId,
      outcome: workOrder.outcome,
      ...(workOrder.outcome === "completed" ? { receiptHash: await hashCanonical(workOrder) } : {}),
      ...(workOrder.reasonCode ? { reasonCode: workOrder.reasonCode } : {}),
      ...(workOrder.conflictingWorkOrderId ? { conflictingWorkOrderId: workOrder.conflictingWorkOrderId } : {})
    });
  }
}

export async function emitAcceptance(results: EvalRun["acceptanceResults"], recorder: DeterministicTraceRecorder): Promise<void> {
  for (const result of results) {
    await recorder.emit(
      "acceptance.checked",
      { criterionId: result.criterionId, passed: result.passed, evidenceEventIds: result.evidenceEventIds, message: result.message },
      result.evidenceEventIds.length ? result.evidenceEventIds : undefined
    );
  }
}

export function structuredRedactionReceipt(canonicalTraceHash: string) {
  return {
    policyVersion: "harness-redaction-v1",
    status: "not_performed_structured_input" as const,
    removedFieldCount: null,
    unmeasuredReason: "Core deterministic runtime accepts strict structured envelopes; outer artifact writers own redaction.",
    structuredEnvelopeHash: hashCanonicalSync({ policyVersion: "harness-redaction-v1", canonicalTraceHash })
  };
}
