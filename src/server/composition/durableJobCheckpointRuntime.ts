import { randomUUID } from "node:crypto";
import type { StorageWorkerClient } from "../runtime/storage/worker/typedRuntime.js";
import type { StorageJob, StorageJobEvent, StorageStepAttempt } from "../runtime/storage/v2/types.js";
import type { DurableJobRecord } from "./durableJobTypes.js";

interface CheckpointRuntimeDependencies {
  client: StorageWorkerClient;
  get(jobId: string): Promise<DurableJobRecord | undefined>;
  publish(event: StorageJobEvent): void;
}

export async function commitCompletedStep(
  dependencies: CheckpointRuntimeDependencies,
  job: StorageJob,
  step: string,
  attemptId: string,
  workerId: string
): Promise<void> {
  const settled = await dependencies.get(job.id);
  if (!settled || settled.status !== "completed") return;
  const now = new Date().toISOString();
  const checkpointId = randomUUID();
  const checkpoint = {
    id: checkpointId,
    projectId: job.projectId,
    jobId: job.id,
    attemptId,
    step,
    checkpointKey: `attempt-${job.attempt}-completed`,
    status: "committed",
    data: { phase: "step_completed", resultingStatus: settled.status },
    createdAt: now,
    committedAt: now
  } as const;
  const stepAttempt: StorageStepAttempt = {
    id: attemptId,
    projectId: job.projectId,
    jobId: job.id,
    step,
    attemptIndex: job.attempt,
    status: "completed",
    workerId,
    checkpointId,
    startedAt: job.startedAt ?? now,
    completedAt: now
  };
  const [, , event] = await dependencies.client.transaction<[unknown, unknown, StorageJobEvent]>([
    { name: "checkpoint.save", checkpoint },
    { name: "checkpoint.recordStepAttempt", attempt: stepAttempt },
    {
      name: "event.append",
      event: {
        projectId: job.projectId,
        jobId: job.id,
        type: "run.step.changed",
        createdAt: now,
        payload: { projectRevision: settled.projectRevision, data: { jobId: job.id, step, checkpointId } }
      }
    }
  ]);
  dependencies.publish(event);
}

export async function quarantineFailedStep(
  client: StorageWorkerClient,
  job: StorageJob,
  step: string,
  attemptId: string,
  workerId: string,
  error: string
): Promise<void> {
  const now = new Date().toISOString();
  const checkpointId = randomUUID();
  await client.request({
    name: "checkpoint.save",
    checkpoint: {
      id: checkpointId,
      projectId: job.projectId,
      jobId: job.id,
      attemptId,
      step,
      checkpointKey: `attempt-${job.attempt}-quarantined`,
      status: "quarantined",
      error,
      data: { phase: "step_failed" },
      createdAt: now
    }
  });
  await client.request({
    name: "checkpoint.recordStepAttempt",
    attempt: {
      id: attemptId,
      projectId: job.projectId,
      jobId: job.id,
      step,
      attemptIndex: job.attempt,
      status: "quarantined",
      workerId,
      checkpointId,
      error,
      startedAt: job.startedAt ?? now,
      completedAt: now
    }
  });
}
