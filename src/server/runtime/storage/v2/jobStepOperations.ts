import { controlTerminalReason, type CompletedStepDisposition } from "./jobTerminalResolution.js";
import { jobAtomicId, storageStepCheckpointId } from "./jobAtomicIds.js";
import type { StorageTerminalQuarantinedStepInput, StorageTerminalTransitionInput } from "./jobAtomicTypes.js";
import type { StorageV2RepositorySet } from "./repositories.js";
import type { StorageJob, StorageQuarantinedStepInput, StorageStepDispositionInput, StorageStepDispositionResult } from "./types.js";

export { storageStepCheckpointId } from "./jobAtomicIds.js";

export function commitStep(repositories: StorageV2RepositorySet, input: StorageStepDispositionInput): StorageStepDispositionResult {
  return recordStepDisposition(repositories, input, "committed");
}

export function quarantineStep(repositories: StorageV2RepositorySet, input: StorageQuarantinedStepInput): StorageStepDispositionResult {
  return recordStepDisposition(repositories, input, "quarantined");
}

export function recordTerminalStepTransition(
  repositories: StorageV2RepositorySet,
  job: StorageJob,
  input: StorageTerminalTransitionInput,
  disposition: CompletedStepDisposition
): StorageStepDispositionResult {
  if (input.quarantinedStep) return recordExplicitQuarantinedStep(repositories, input, input.quarantinedStep);
  const step = requiredCompletedStep(input);
  const occurredAt = input.occurredAt as string;
  if (disposition === "committed") {
    return recordStepDisposition(
      repositories,
      {
        fence: input.fence,
        step: step.step,
        projectRevision: input.projectRevision,
        occurredAt,
        checkpointData: step.checkpointData,
        outputRef: step.outputRef,
        outputHash: step.outputHash
      },
      "committed"
    );
  }
  return recordStepDisposition(
    repositories,
    {
      fence: input.fence,
      step: step.step,
      projectRevision: input.projectRevision,
      occurredAt,
      checkpointData: { phase: "control_requested_before_completion_commit", intendedStatus: "completed" },
      outputRef: step.outputRef,
      outputHash: step.outputHash,
      error: input.reason ?? controlTerminalReason(job.status === "cancel_requested" || job.status === "aborted" ? "aborted" : "paused")
    },
    "quarantined"
  );
}

export function readTerminalStepTransitionRetry(
  repositories: StorageV2RepositorySet,
  job: StorageJob,
  input: StorageTerminalTransitionInput,
  disposition: CompletedStepDisposition
): StorageStepDispositionResult {
  const stepName = input.quarantinedStep?.step ?? requiredCompletedStep(input).step;
  const durableDisposition = input.quarantinedStep ? "quarantined" : disposition;
  const checkpointId = storageStepCheckpointId(input.fence, stepName, durableDisposition);
  const attemptId = jobAtomicId("step-attempt", job.id, String(input.fence.attempt), stepName);
  const eventId = jobAtomicId("event", job.id, String(input.fence.attempt), stepName, durableDisposition);
  const checkpoint = repositories.checkpoints.get(checkpointId);
  const attempt = repositories.checkpoints.listStepAttempts(job.id).find((candidate) => candidate.id === attemptId);
  const event = repositories.events.get(eventId);
  if (!checkpoint || !attempt || !event) {
    throw new Error(`Terminal step retry is missing its durable ${durableDisposition} disposition.`);
  }
  return recordTerminalStepTransition(repositories, job, input, disposition);
}

export function hasTerminalStep(input: StorageTerminalTransitionInput): boolean {
  return Boolean(input.completedStep || input.quarantinedStep);
}

function recordStepDisposition(
  repositories: StorageV2RepositorySet,
  input: StorageStepDispositionInput | StorageQuarantinedStepInput,
  disposition: "committed" | "quarantined"
): StorageStepDispositionResult {
  const occurredAt = input.occurredAt ?? new Date().toISOString();
  const allowed =
    disposition === "committed"
      ? (["running", "completed"] as const)
      : (["running", "pause_requested", "cancel_requested", "paused", "aborted", "blocked", "failed"] as const);
  const job = repositories.jobs.assertFence(input.fence, allowed);
  const checkpointId = storageStepCheckpointId(input.fence, input.step, disposition);
  const attemptId = jobAtomicId("step-attempt", job.id, String(input.fence.attempt), input.step);
  const error = "error" in input ? input.error : undefined;
  const checkpoint = repositories.checkpoints.saveCheckpoint({
    id: checkpointId,
    projectId: job.projectId,
    jobId: job.id,
    attemptId,
    step: input.step,
    checkpointKey: `attempt-${input.fence.attempt}-${input.step}-${disposition}`,
    status: disposition,
    ...(input.outputRef ? { outputRef: input.outputRef } : {}),
    ...(error ? { error } : {}),
    data: input.checkpointData ?? { phase: disposition === "committed" ? "step_completed" : "step_failed" },
    createdAt: occurredAt,
    ...(disposition === "committed" ? { committedAt: occurredAt } : {})
  });
  const stepAttempt = repositories.checkpoints.recordStepAttempt({
    id: attemptId,
    projectId: job.projectId,
    jobId: job.id,
    step: input.step,
    attemptIndex: input.fence.attempt,
    status: disposition === "committed" ? "completed" : "quarantined",
    workerId: input.fence.leaseOwner,
    checkpointId,
    ...(input.outputHash !== undefined ? { outputHash: input.outputHash } : {}),
    ...(disposition === "quarantined" && "quarantineRef" in input && input.quarantineRef ? { quarantineRef: input.quarantineRef } : {}),
    ...(error ? { error } : {}),
    startedAt: job.startedAt ?? occurredAt,
    completedAt: occurredAt
  });
  const event = repositories.events.append({
    eventId: jobAtomicId("event", job.id, String(input.fence.attempt), input.step, disposition),
    projectId: job.projectId,
    jobId: job.id,
    type: "run.step.changed",
    createdAt: occurredAt,
    payload: { projectRevision: input.projectRevision, data: { jobId: job.id, step: input.step, checkpointId } }
  });
  return { job, checkpoint, stepAttempt, event };
}

function recordExplicitQuarantinedStep(
  repositories: StorageV2RepositorySet,
  input: StorageTerminalTransitionInput,
  step: StorageTerminalQuarantinedStepInput
): StorageStepDispositionResult {
  return recordStepDisposition(
    repositories,
    {
      fence: input.fence,
      step: step.step,
      projectRevision: input.projectRevision,
      occurredAt: input.occurredAt as string,
      checkpointData: step.checkpointData,
      outputRef: step.outputRef,
      outputHash: step.outputHash,
      quarantineRef: step.quarantineRef,
      error: step.error
    },
    "quarantined"
  );
}

function requiredCompletedStep(input: StorageTerminalTransitionInput): NonNullable<StorageTerminalTransitionInput["completedStep"]> {
  if (!input.completedStep) throw new Error("Completed step metadata is required.");
  return input.completedStep;
}
