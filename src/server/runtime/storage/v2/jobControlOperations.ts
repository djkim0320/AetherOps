import { jobAtomicId as stableId } from "./jobAtomicIds.js";
import type { StorageJobControlInput, StorageJobControlResult } from "./jobAtomicTypes.js";
import type { StorageV2RepositorySet } from "./repositories.js";
import type { StorageJob } from "./types.js";

export function requestControl(repositories: StorageV2RepositorySet, input: StorageJobControlInput): StorageJobControlResult {
  const occurredAt = input.occurredAt ?? new Date().toISOString();
  const before = requiredJob(repositories, input.jobId);
  const replay = readControlRetry(repositories, before, input.control);
  if (replay) return replay;
  repositories.projectRevisions.assertCurrent(before.projectId, input.projectRevision);
  const job = input.control === "pause" ? repositories.jobs.requestPause(input.jobId, occurredAt) : repositories.jobs.requestCancel(input.jobId, occurredAt);
  const event = repositories.events.append({
    eventId: stableId("event", job.id, String(job.attempt), `control-${input.control}-${job.status}`),
    projectId: job.projectId,
    jobId: job.id,
    type: "run.status.changed",
    createdAt: occurredAt,
    payload: {
      projectRevision: input.projectRevision,
      data: { jobId: job.id, status: job.status, previousStatus: before.status, reason: `${input.control}_requested` }
    }
  });
  return { job, event };
}

function requiredJob(repositories: StorageV2RepositorySet, jobId: string): StorageJob {
  const job = repositories.jobs.get(jobId);
  if (!job) throw new Error(`Durable job not found: ${jobId}.`);
  return job;
}

function readControlRetry(
  repositories: StorageV2RepositorySet,
  job: StorageJob,
  control: StorageJobControlInput["control"]
): StorageJobControlResult | undefined {
  const statuses: readonly StorageJob["status"][] = control === "pause" ? ["pause_requested", "paused"] : ["cancel_requested", "aborted"];
  if (!statuses.includes(job.status)) return undefined;
  for (const status of statuses) {
    const event = repositories.events.get(stableId("event", job.id, String(job.attempt), `control-${control}-${status}`));
    if (!event) continue;
    const data = objectRecord(objectRecord(event.payload).data);
    if (
      event.projectId !== job.projectId ||
      event.jobId !== job.id ||
      event.type !== "run.status.changed" ||
      data.jobId !== job.id ||
      data.status !== status ||
      data.reason !== `${control}_requested`
    ) {
      throw new Error(`Durable ${control} control receipt does not match its job: ${job.id}.`);
    }
    return { job, event };
  }
  throw new Error(`Durable ${control} control receipt is unavailable: ${job.id}.`);
}

function objectRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}
