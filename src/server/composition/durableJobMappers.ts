import { SseEventSchema, type SseEvent } from "../../contracts/api-v2/events.js";
import type { JobKind } from "../../contracts/api-v2/jobs.js";
import type { ResearchLoopStep } from "../../shared/kernel/researchLoop.js";
import type { StorageJob, StorageJobEvent } from "../runtime/storage/v2/types.js";
import type { DurableJobRecord } from "./durableJobTypes.js";

export function toDurableJobRecord(job: StorageJob): DurableJobRecord {
  const payload = objectRecord(job.payload);
  const request = objectRecord(payload.request);
  const result = objectRecord(job.result);
  return {
    id: job.id,
    projectId: job.projectId,
    kind: job.operation as JobKind,
    status: job.status,
    projectRevision: Number(result.projectRevision ?? payload.projectRevision ?? 0),
    currentStep: payload.currentStep as ResearchLoopStep | undefined,
    idempotencyKey: job.idempotencyKey ?? job.id,
    requestHash: job.requestHash,
    requestedCapabilities: job.requestedCapabilities,
    effectiveCapabilities: job.effectiveCapabilities,
    toolPolicy: job.toolPolicy,
    engineeringBaseline: engineeringBaselineBinding(request),
    resumesJobId: payload.resumesJobId as string | undefined,
    resumeCheckpointId: payload.resumeCheckpointId as string | undefined,
    canonicalInitializationAnchor: request.canonicalInitializationAnchor,
    blockedReason: job.blockedReason ?? (job.status === "blocked" ? job.error : undefined),
    failureReason: job.failureReason ?? (job.status !== "blocked" ? job.error : undefined),
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    startedAt: job.startedAt,
    finishedAt: job.completedAt,
    leaseExpiresAt: job.leaseExpiresAt
  };
}

function engineeringBaselineBinding(value: Record<string, unknown>): DurableJobRecord["engineeringBaseline"] {
  if (!("engineeringBaseline" in value)) return undefined;
  const candidate = value.engineeringBaseline;
  if (candidate === null) return null;
  const record = objectRecord(candidate);
  if (
    typeof record.id !== "string" ||
    !record.id ||
    !Number.isInteger(record.revision) ||
    Number(record.revision) < 1 ||
    typeof record.contentHash !== "string" ||
    !/^[a-f0-9]{64}$/.test(record.contentHash)
  ) {
    throw new Error("Durable research job contains an invalid engineering baseline binding.");
  }
  return { id: record.id, revision: Number(record.revision), contentHash: record.contentHash };
}

export function eventFromStorage(event: StorageJobEvent): SseEvent {
  const payload = objectRecord(event.payload);
  return SseEventSchema.parse({
    id: event.sequence,
    projectId: event.projectId,
    projectRevision: payload.projectRevision,
    occurredAt: event.createdAt,
    type: event.type,
    data: payload.data
  });
}

function objectRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}
