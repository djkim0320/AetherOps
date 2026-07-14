import { randomUUID } from "node:crypto";
import type { JobStatus } from "../../contracts/api-v2/jobs.js";
import type { StorageWorkerClient } from "../runtime/storage/worker/typedRuntime.js";
import type { StorageEnqueueJobResult } from "../runtime/storage/v2/jobAtomicTypes.js";
import type {
  StorageCapabilityAudit,
  StorageCheckpoint,
  StorageJob,
  StorageJobEvent,
  StorageProjectJobPage,
  StorageProjectPayload
} from "../runtime/storage/v2/types.js";
import { readDurableJobDetail } from "./durableJobDetailReader.js";
import { toDurableJobRecord } from "./durableJobMappers.js";
import { durableEnqueueRequestHash } from "./durableJobRequestHash.js";
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
  const requestHash = input.requestHash ?? durableEnqueueRequestHash(input);
  const replay = await findIdempotentDurableReceipt(dependencies.client, input.projectId, input.idempotencyKey, requestHash);
  if (replay) return replay;
  dependencies.assertAccepting();
  if (!dependencies.hasHandler(input.kind)) throw new Error(`No durable handler is registered for ${input.kind}.`);
  assertDurablePayload(input.payload);
  if (input.resumesJobId) await assertDurableResumeSource(dependencies.client, input);
  const acceptedAt = runtimeNow(dependencies.config);
  const jobId = input.jobId ?? randomUUID();
  const result = await dependencies.client.request<StorageEnqueueJobResult>({
    name: "job.enqueue",
    ...(input.project ? { project: input.project } : {}),
    ...(input.capabilityAudits ? { capabilityAudits: input.capabilityAudits } : {}),
    job: {
      id: jobId,
      projectId: input.projectId,
      operation: input.kind,
      payload: persistedPayload(input),
      idempotencyKey: input.idempotencyKey,
      requestHash,
      requestedCapabilities: input.requestedCapabilities,
      effectiveCapabilities: input.effectiveCapabilities,
      toolPolicy: input.toolPolicy,
      createdAt: acceptedAt,
      queuedAt: acceptedAt
    }
  });
  const stored = result.job;
  if (result.event) dependencies.publish(result.event);
  if (stored.status === "queued") dependencies.schedule(stored.projectId);
  return durableReceipt(dependencies.client, stored);
}

export async function findIdempotentDurableReceipt(
  client: StorageWorkerClient,
  projectId: string,
  idempotencyKey: string,
  requestHash: string
): Promise<DurableJobReceipt | undefined> {
  const stored = await client.request<StorageJob | undefined>({ name: "job.lookupIdempotency", projectId, idempotencyKey, requestHash });
  return stored ? durableReceipt(client, stored) : undefined;
}

async function durableReceipt(client: StorageWorkerClient, stored: StorageJob): Promise<DurableJobReceipt> {
  const record = toDurableJobRecord(stored);
  const queuePosition = stored.status === "queued" ? await client.request<number>({ name: "job.queuePosition", jobId: stored.id }) : undefined;
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

export async function latestDurableProjectExecution(
  client: StorageWorkerClient,
  projectId: string,
  operation: string
): Promise<{ job?: DurableJobRecord; checkpoint?: StorageCheckpoint }> {
  const result = await client.request<{ job?: StorageJob; checkpoint?: StorageCheckpoint }>({
    name: "job.latestProjectExecution",
    projectId,
    operation
  });
  return {
    ...(result.job ? { job: toDurableJobRecord(result.job) } : {}),
    ...(result.checkpoint ? { checkpoint: result.checkpoint } : {})
  };
}

export async function recordDurableCapabilityAudits(
  client: StorageWorkerClient,
  audits: StorageCapabilityAudit[],
  project?: StorageProjectPayload
): Promise<void> {
  await client.request({ name: "capability.recordSet", audits, ...(project ? { project } : {}) });
}

export async function syncDurableProject(client: StorageWorkerClient, project: StorageProjectPayload): Promise<void> {
  await client.request({ name: "project.upsert", project });
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
