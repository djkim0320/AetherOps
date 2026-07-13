import { randomUUID } from "node:crypto";
import type { JobStatus } from "../../contracts/api-v2/jobs.js";
import type { StorageWorkerClient } from "../runtime/storage/worker/typedRuntime.js";
import type { StorageEnqueueJobResult } from "../runtime/storage/v2/jobAtomicTypes.js";
import type { StorageCapabilityAudit, StorageJob, StorageJobEvent, StorageProjectJobPage } from "../runtime/storage/v2/types.js";
import { readDurableJobDetail } from "./durableJobDetailReader.js";
import { toDurableJobRecord } from "./durableJobMappers.js";
import { durableJobRequestHash } from "./durableJobRequestHash.js";
import type { DurableJobDetail, DurableJobReceipt, DurableJobRecord, DurableTracePageRequest, EnqueueDurableJob } from "./durableJobTypes.js";
import { assertDurablePayload } from "./durablePayload.js";
import { assertDurableResumeSource } from "./durableResumeValidator.js";
import { runtimeNow, type ResolvedDurableRuntimeConfig } from "./durableRuntimeConfig.js";

interface DurableJobStoreDependencies {
  client: StorageWorkerClient;
  config: ResolvedDurableRuntimeConfig;
  assertAccepting(): void;
  hasHandler(kind: EnqueueDurableJob["kind"]): boolean;
  schedule(projectId: string): void;
  publish(event: StorageJobEvent): void;
}

export async function enqueueDurableJob(dependencies: DurableJobStoreDependencies, input: EnqueueDurableJob): Promise<DurableJobReceipt> {
  dependencies.assertAccepting();
  if (!dependencies.hasHandler(input.kind)) throw new Error(`No durable handler is registered for ${input.kind}.`);
  assertDurablePayload(input.payload);
  if (input.resumeCheckpointId) await assertDurableResumeSource(dependencies.client, input);
  const acceptedAt = runtimeNow(dependencies.config);
  const result = await dependencies.client.request<StorageEnqueueJobResult>({
    name: "job.enqueue",
    job: {
      id: randomUUID(),
      projectId: input.projectId,
      operation: input.kind,
      payload: persistedPayload(input),
      idempotencyKey: input.idempotencyKey,
      requestHash: input.requestHash ?? durableJobRequestHash({ ...input, request: input.payload, payload: undefined }),
      requestedCapabilities: input.requestedCapabilities,
      effectiveCapabilities: input.effectiveCapabilities,
      toolPolicy: input.toolPolicy,
      createdAt: acceptedAt,
      queuedAt: acceptedAt
    }
  });
  const stored = result.job;
  if (result.event) dependencies.publish(result.event);
  const record = toDurableJobRecord(stored);
  const queuePosition = stored.status === "queued" ? await dependencies.client.request<number>({ name: "job.queuePosition", jobId: stored.id }) : undefined;
  if (stored.status === "queued") dependencies.schedule(stored.projectId);
  return {
    jobId: record.id,
    projectId: record.projectId,
    kind: record.kind,
    status: record.status,
    ...(queuePosition === undefined ? {} : { queuePosition }),
    acceptedAt: record.createdAt,
    projectRevision: record.projectRevision
  };
}

export async function getDurableJob(client: StorageWorkerClient, jobId: string): Promise<DurableJobRecord | undefined> {
  const job = await client.request<StorageJob | undefined>({ name: "job.get", jobId });
  return job ? toDurableJobRecord(job) : undefined;
}

export async function getDurableJobDetail(
  client: StorageWorkerClient,
  jobId: string,
  tracePage?: DurableTracePageRequest
): Promise<DurableJobDetail | undefined> {
  const job = await getDurableJob(client, jobId);
  return job ? readDurableJobDetail(client, job, tracePage) : undefined;
}

export async function listDurableJobs(
  client: StorageWorkerClient,
  projectId: string,
  options: { status?: JobStatus; limit?: number; cursor?: string }
): Promise<{ jobs: DurableJobRecord[]; nextCursor?: string }> {
  const page = await client.request<StorageProjectJobPage>({ name: "job.listProject", projectId, ...options });
  return { jobs: page.jobs.map(toDurableJobRecord), ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}) };
}

export async function recordDurableCapabilityAudits(client: StorageWorkerClient, audits: StorageCapabilityAudit[]): Promise<void> {
  for (const audit of audits) await client.request({ name: "capability.record", audit });
}

function persistedPayload(input: EnqueueDurableJob): Record<string, unknown> {
  return {
    kind: input.kind,
    projectRevision: input.projectRevision,
    currentStep: input.currentStep,
    resumesJobId: input.resumesJobId,
    resumeCheckpointId: input.resumeCheckpointId,
    request: input.payload
  };
}
