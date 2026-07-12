import { z } from "zod";
import { JobDetailSchema, JobReceiptSchema, JobSchema, type JobStatus } from "../../../contracts/api-v2/jobs.js";
import type { ResearchSnapshot } from "../../../core/shared/types.js";
import { durableJobRequestHash } from "../../composition/durableJobRequestHash.js";
import type { DurableJobDetail, DurableJobReceipt, DurableJobRecord } from "../../composition/durableJobTypes.js";
import { redactTraceText, safeTraceUrl, sanitizeTraceRecord } from "../../runtime/security/traceSanitizer.js";

export function mapJobStatusFromProjectStatus(status: ResearchSnapshot["project"]["status"] | string): JobStatus {
  if (status === "paused") return "paused";
  if (status === "aborted") return "aborted";
  if (status === "failed") return "failed";
  if (status === "blocked") return "blocked";
  if (status === "completed") return "completed";
  if (status === "running") return "running";
  return "queued";
}

export function toJobReceipt(job: DurableJobRecord, queuePosition = 0): DurableJobReceipt {
  return JobReceiptSchema.parse({
    jobId: job.id,
    projectId: job.projectId,
    kind: job.kind,
    status: "queued",
    queuePosition,
    acceptedAt: job.createdAt,
    projectRevision: job.projectRevision
  });
}

export function toJobResponse(job: DurableJobRecord): z.infer<typeof JobSchema> {
  return JobSchema.parse({
    id: job.id,
    projectId: job.projectId,
    kind: job.kind,
    status: job.status,
    currentStep: job.currentStep,
    idempotencyKey: job.idempotencyKey,
    resumesJobId: job.resumesJobId,
    resumeCheckpointId: job.resumeCheckpointId,
    blockedReason: job.blockedReason,
    failureReason: job.failureReason,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt
  });
}

export function toJobDetailResponse(job: DurableJobDetail): z.infer<typeof JobDetailSchema> {
  return JobDetailSchema.parse({
    ...toJobResponse(job),
    requestHash: job.requestHash,
    requestedCapabilities: job.requestedCapabilities,
    effectiveCapabilities: job.effectiveCapabilities,
    toolPolicy: publicToolPolicy(job.toolPolicy),
    traceAvailability: job.traceAvailability,
    trace: {
      llmInvocations: job.trace.llmInvocations.map((item) => ({
        id: item.id,
        model: item.model,
        reasoningEffort: item.reasoningEffort,
        promptVersion: item.promptVersion,
        schemaVersion: item.schemaVersion,
        promptHash: item.promptHash,
        responseHash: item.responseHash,
        latencyMs: item.latencyMs,
        repairCount: item.repairCount,
        status: item.status,
        startedAt: item.startedAt,
        completedAt: item.completedAt
      })),
      toolDecisions: job.trace.toolDecisions.map((item) => ({
        id: item.id,
        invocationId: item.invocationId,
        toolName: item.toolName,
        purpose: item.purpose,
        expectedOutcome: item.expectedOutcome,
        userPinned: item.userPinned,
        policyStatus: item.policyStatus,
        policyReason: redactTraceText(item.policyReason),
        actionHash: decisionInputHash(item.rawSelection),
        validatedInputs: sanitizeTraceRecord(sanitizeTraceRecord(item.rawSelection).inputs),
        actionSummary: actionSummary(item.compiledAction),
        createdAt: item.createdAt
      })),
      toolAttempts: job.trace.toolAttempts.map((item) => ({
        id: item.id,
        decisionId: item.decisionId,
        checkpointId: item.checkpointId,
        ordinal: item.ordinal,
        status: item.status,
        inputHash: item.inputHash,
        outputHash: item.outputHash,
        terminalCause: item.terminalCause,
        dependsOnAttemptIds: item.dependsOnAttemptIds,
        error: redactTraceText(item.error),
        queuedAt: item.queuedAt,
        startedAt: item.startedAt,
        completedAt: item.completedAt
      })),
      codexCliExecutions: (job.trace.codexCliExecutions ?? []).map((item) => ({
        id: item.id,
        attemptId: item.attemptId,
        model: item.model,
        reasoningEffort: item.reasoningEffort,
        sandboxProfile: item.sandboxProfile,
        networkPolicy: item.networkPolicy,
        durationMs: item.durationMs,
        exitCode: item.exitCode,
        terminationReason: item.terminationReason,
        eventCount: item.eventCount,
        workspaceManifestHash: item.workspaceManifestHash,
        outputManifestHash: item.outputManifestHash,
        createdAt: item.createdAt,
        completedAt: item.completedAt
      })),
      outputs: job.trace.outputs.map((item) => ({
        id: item.id,
        attemptId: item.attemptId,
        outputKind: item.outputKind,
        outputId: item.outputId,
        promoted: item.promoted,
        createdAt: item.createdAt,
        promotedAt: item.promotedAt
      })),
      networkAudits: job.trace.networkAudits.map((item) => ({
        id: item.id,
        attemptId: item.attemptId,
        url: safeTraceUrl(item.url),
        redirectChain: item.redirectChain.map(safeTraceUrl),
        policyDecision: item.policyDecision,
        reason: redactTraceText(item.reason),
        auditedAt: item.auditedAt
      }))
    }
  });
}

function decisionInputHash(rawSelection: unknown): string | undefined {
  if (!rawSelection || typeof rawSelection !== "object" || Array.isArray(rawSelection)) return undefined;
  const record = rawSelection as Record<string, unknown>;
  if (typeof record.inputHash === "string" && record.inputHash.trim()) return record.inputHash;
  return record.inputs === undefined ? undefined : durableJobRequestHash(record.inputs);
}

function publicToolPolicy(policy: DurableJobRecord["toolPolicy"]): DurableJobRecord["toolPolicy"] {
  if (!policy || policy.sourceAccess.mode !== "allowlist") return policy;
  return { ...policy, sourceAccess: { mode: "allowlist", urls: policy.sourceAccess.urls.map(safeTraceUrl) } };
}

function actionSummary(value: unknown): { phase?: string; ordinal?: number } | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const phase = typeof record.phase === "string" && record.phase.trim() ? record.phase.slice(0, 100) : undefined;
  const ordinal = typeof record.ordinal === "number" && Number.isInteger(record.ordinal) && record.ordinal >= 0 ? record.ordinal : undefined;
  return phase === undefined && ordinal === undefined ? undefined : { ...(phase ? { phase } : {}), ...(ordinal !== undefined ? { ordinal } : {}) };
}
