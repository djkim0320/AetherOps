import { z } from "zod";
import { JobDetailSchema, JobReceiptSchema, JobSchema, type JobStatus } from "../../../contracts/api-v2/jobs.js";
import type { ResearchSnapshot } from "../../../core/shared/types.js";
import type { DurableJobDetail, DurableJobReceipt, DurableJobRecord } from "../../composition/durableJobTypes.js";
import { safeTraceUrl } from "../../runtime/security/traceSanitizer.js";
import { assertSerializedTraceResponseBudget, toPublicJobTrace } from "./jobTraceResponse.js";
import { fitJobDetailToSerializedBudget } from "./jobTraceBudget.js";

export function mapJobStatusFromProjectStatus(status: ResearchSnapshot["project"]["status"] | string): JobStatus {
  if (status === "paused") return "paused";
  if (status === "aborted") return "aborted";
  if (status === "failed") return "failed";
  if (status === "blocked") return "blocked";
  if (status === "completed") return "completed";
  if (status === "running") return "running";
  return "queued";
}

export function toJobReceipt(job: DurableJobRecord, queuePosition?: number): DurableJobReceipt {
  return JobReceiptSchema.parse({
    jobId: job.id,
    projectId: job.projectId,
    kind: job.kind,
    status: job.status,
    ...(job.status === "queued" ? { queuePosition: queuePosition ?? 0 } : {}),
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
  const projected = JobDetailSchema.parse({
    ...toJobResponse(job),
    requestHash: job.requestHash,
    requestedCapabilities: job.requestedCapabilities,
    effectiveCapabilities: job.effectiveCapabilities,
    toolPolicy: publicToolPolicy(job.toolPolicy),
    traceAvailability: job.traceAvailability,
    trace: toPublicJobTrace(job)
  });
  const response = JobDetailSchema.parse(fitJobDetailToSerializedBudget(projected, job.traceContinuationCursors));
  assertSerializedTraceResponseBudget(response);
  return response;
}

function publicToolPolicy(policy: DurableJobRecord["toolPolicy"]): DurableJobRecord["toolPolicy"] {
  if (!policy || policy.sourceAccess.mode !== "allowlist") return policy;
  return { ...policy, sourceAccess: { mode: "allowlist", urls: policy.sourceAccess.urls.map(publicSourceUrl) } };
}

function publicSourceUrl(value: string): string {
  const url = new URL(safeTraceUrl(value));
  url.search = "";
  return url.toString();
}
