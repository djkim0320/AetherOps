import { createHash } from "node:crypto";
import { storageLeaseFence } from "./leaseFence.js";
import { controlTerminalReason, resolveDurableTerminal, type CompletedStepDisposition } from "./jobTerminalResolution.js";
import type { StorageV2RepositorySet } from "./repositories.js";
import type {
  StorageExpiredLeaseSweepResult,
  StorageEnqueueJobResult,
  StorageJobControlInput,
  StorageJobControlResult,
  StorageOutputPromotion,
  StorageTerminalTransitionInput,
  StorageTerminalTransitionResult
} from "./jobAtomicTypes.js";
import type {
  StorageClaimStartOptions,
  StorageClaimStartResult,
  StorageJobEvent,
  StorageJob,
  StorageJobInput,
  StorageLeaseFence,
  StorageQuarantinedStepInput,
  StorageStepAttempt,
  StorageStepDispositionInput,
  StorageStepDispositionResult
} from "./types.js";
import type { StorageToolOutputLink } from "./traceTypes.js";

export function enqueueJob(repositories: StorageV2RepositorySet, input: StorageJobInput): StorageEnqueueJobResult {
  const existing = input.idempotencyKey ? repositories.jobs.getByIdempotencyKey(input.projectId, input.idempotencyKey) : undefined;
  const job = repositories.jobs.enqueue(input);
  const eventId = stableId("event", job.id, "queued");
  if (existing || job.id !== input.id) {
    const event = repositories.events.get(eventId);
    return { job, ...(event ? { event } : {}) };
  }
  const event = repositories.events.append({
    eventId,
    projectId: job.projectId,
    jobId: job.id,
    type: "run.status.changed",
    createdAt: job.queuedAt,
    payload: { projectRevision: requiredProjectRevision(job), data: { jobId: job.id, status: "queued" } }
  });
  return { job, event };
}

export function claimAndStart(repositories: StorageV2RepositorySet, options: StorageClaimStartOptions): StorageClaimStartResult | undefined {
  const job = repositories.jobs.claimNext(options);
  if (!job) return undefined;
  const fence = storageLeaseFence(job);
  const occurredAt = options.now ?? new Date().toISOString();
  const metadata = requiredClaimMetadata(job);
  const stepAttempt = metadata.step ? runningStepAttempt(job, metadata.step, occurredAt) : undefined;
  if (stepAttempt) repositories.checkpoints.recordStepAttempt(stepAttempt);
  const event = repositories.events.append({
    eventId: stableId("event", job.id, String(job.attempt), "running"),
    projectId: job.projectId,
    jobId: job.id,
    type: "run.status.changed",
    createdAt: occurredAt,
    payload: { projectRevision: metadata.projectRevision, data: { jobId: job.id, status: "running", previousStatus: "queued" } }
  });
  return { job, fence, event, ...(stepAttempt ? { stepAttempt } : {}) };
}

export function transitionTerminal(repositories: StorageV2RepositorySet, input: StorageTerminalTransitionInput): StorageTerminalTransitionResult {
  const occurredAt = input.occurredAt ?? new Date().toISOString();
  if (input.completedStep && input.status !== "completed") {
    throw new Error("A completed step can be committed only with a completed terminal request.");
  }
  if (input.promotions?.length && input.status !== "completed") {
    throw new Error("Output promotions are allowed only when completing a job.");
  }
  const before = repositories.jobs.assertFence(input.fence, occurredAt, [
    "running",
    "pause_requested",
    "cancel_requested",
    "paused",
    "aborted",
    "blocked",
    "failed",
    "completed"
  ]);
  const resolution = resolveDurableTerminal(before.status, input.status, input.reason, Boolean(input.completedStep));
  const resolvedInput: StorageTerminalTransitionInput = {
    ...input,
    status: resolution.status,
    reason: resolution.reason,
    occurredAt,
    promotions: resolution.status === "completed" ? input.promotions : undefined
  };
  if (before.status === resolution.status) {
    const terminal = readTerminalRetry(repositories, before, resolvedInput);
    const stepDisposition = input.completedStep ? readCompletedStepTransitionRetry(repositories, before, resolvedInput, resolution.stepDisposition) : undefined;
    return {
      ...terminal,
      events: [...(stepDisposition ? [stepDisposition.event] : []), ...terminal.events],
      ...(stepDisposition ? { stepDisposition } : {})
    };
  }
  const stepDisposition = input.completedStep ? recordCompletedStepTransition(repositories, before, resolvedInput, resolution.stepDisposition) : undefined;
  const promoted =
    resolution.status === "completed"
      ? (input.promotions ?? []).map((promotion) => promoteTerminalOutput(repositories, input.fence, promotion, input.projectRevision, occurredAt))
      : [];
  const job = repositories.jobs.transitionFenced(
    input.fence,
    {
      status: resolution.status,
      result: { projectRevision: input.projectRevision },
      error: resolution.reason,
      ...(resolution.status === "blocked" && resolution.reason ? { blockedReason: resolution.reason } : {}),
      ...(resolution.status === "failed" && resolution.reason ? { failureReason: resolution.reason } : {}),
      updatedAt: occurredAt
    },
    occurredAt
  );
  const event = repositories.events.append({
    eventId: stableId("event", job.id, String(input.fence.attempt), `terminal-${resolution.status}`),
    projectId: job.projectId,
    jobId: job.id,
    type: "run.status.changed",
    createdAt: occurredAt,
    payload: {
      projectRevision: input.projectRevision,
      data: { jobId: job.id, status: resolution.status, previousStatus: before.status, ...(resolution.reason ? { reason: resolution.reason } : {}) }
    }
  });
  return {
    job,
    event,
    events: [...(stepDisposition ? [stepDisposition.event] : []), ...promoted.flatMap((entry) => (entry.event ? [entry.event] : [])), event],
    links: promoted.map((entry) => entry.link),
    ...(stepDisposition ? { stepDisposition } : {})
  };
}

function readTerminalRetry(repositories: StorageV2RepositorySet, job: StorageJob, input: StorageTerminalTransitionInput): StorageTerminalTransitionResult {
  const links = (input.promotions ?? []).map((promotion) => {
    const link = repositories.trace
      .listOutputLinks(promotion.link.attemptId, 1_000)
      .find((candidate) => candidate.outputKind === promotion.link.outputKind && candidate.outputId === promotion.link.outputId);
    if (!link || link.id !== promotion.link.id || link.jobId !== job.id || link.projectId !== job.projectId || !link.promoted) {
      throw new Error(`Completed job promotion retry does not match durable output ${promotion.link.outputId}.`);
    }
    return link;
  });
  const artifactEvents = (input.promotions ?? []).flatMap((promotion) => {
    if (promotion.link.outputKind !== "artifact") return [];
    const event = repositories.events.get(stableId("event", promotion.link.attemptId, promotion.link.outputId, "artifact-created"));
    if (!event) throw new Error(`Completed job promotion event is missing for ${promotion.link.outputId}.`);
    return [event];
  });
  const event = repositories.events.get(stableId("event", job.id, String(input.fence.attempt), `terminal-${input.status}`));
  if (!event) throw new Error(`Completed job terminal event is missing for ${job.id}.`);
  const payload = event.payload && typeof event.payload === "object" && !Array.isArray(event.payload) ? (event.payload as Record<string, unknown>) : undefined;
  const data = payload?.data && typeof payload.data === "object" && !Array.isArray(payload.data) ? (payload.data as Record<string, unknown>) : undefined;
  if (payload?.projectRevision !== input.projectRevision || data?.jobId !== job.id || data?.status !== input.status || data?.reason !== input.reason) {
    throw new Error(`Completed job terminal retry does not match durable event ${event.eventId}.`);
  }
  return { job, event, events: [...artifactEvents, event], links };
}

export function requestControl(repositories: StorageV2RepositorySet, input: StorageJobControlInput): StorageJobControlResult {
  const occurredAt = input.occurredAt ?? new Date().toISOString();
  const before = requiredJob(repositories, input.jobId);
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

export function interruptExpiredLeases(repositories: StorageV2RepositorySet, now = new Date().toISOString()): StorageExpiredLeaseSweepResult {
  const jobs = repositories.jobs.markInterruptedExpiredLeases(now);
  const events = jobs.map((job) => {
    repositories.checkpoints.interruptRunningStepAttempts(job.id, now, "Worker lease expired.");
    repositories.trace.interruptActiveToolAttempts(job.id, now, "Worker lease expired.");
    return repositories.events.append({
      eventId: stableId("event", job.id, String(job.attempt), String(job.leaseGeneration), "lease-expired"),
      projectId: job.projectId,
      jobId: job.id,
      type: "run.status.changed",
      createdAt: now,
      payload: {
        projectRevision: requiredProjectRevision(job),
        data: { jobId: job.id, status: "interrupted", reason: "Worker lease expired." }
      }
    });
  });
  return { jobs, events, projectIds: [...new Set(jobs.map((job) => job.projectId))].sort() };
}

export function commitStep(repositories: StorageV2RepositorySet, input: StorageStepDispositionInput): StorageStepDispositionResult {
  return recordStepDisposition(repositories, input, "committed");
}

export function quarantineStep(repositories: StorageV2RepositorySet, input: StorageQuarantinedStepInput): StorageStepDispositionResult {
  return recordStepDisposition(repositories, input, "quarantined");
}

function promoteTerminalOutput(
  repositories: StorageV2RepositorySet,
  fence: StorageLeaseFence,
  promotion: StorageOutputPromotion,
  projectRevision: number,
  occurredAt: string
): { link: StorageToolOutputLink; event?: StorageJobEvent } {
  const job = repositories.jobs.assertFence(fence, occurredAt);
  if (promotion.link.jobId !== job.id || promotion.link.projectId !== job.projectId) throw new Error("Promoted output does not belong to the fenced job.");
  if (!promotion.link.promoted) throw new Error("A terminal promotion requires promoted=true.");
  const attempt = repositories.trace.getToolAttempt(promotion.link.attemptId);
  if (!attempt || attempt.jobId !== job.id || attempt.projectId !== job.projectId || attempt.status !== "completed") {
    throw new Error("A promoted output must originate from a completed tool attempt for the fenced job.");
  }
  const link = repositories.trace.recordOutputLink(promotion.link);
  if (link.outputKind !== "artifact") return { link };
  if (!promotion.artifact) throw new Error("A promoted artifact requires public artifact metadata.");
  const event = repositories.events.append({
    eventId: stableId("event", link.attemptId, link.outputId, "artifact-created"),
    projectId: link.projectId,
    jobId: link.jobId,
    type: "artifact.created",
    createdAt: occurredAt,
    payload: {
      projectRevision,
      data: { jobId: link.jobId, artifactId: link.outputId, name: promotion.artifact.name, kind: promotion.artifact.kind }
    }
  });
  return { link, event };
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
  const job = repositories.jobs.assertFence(input.fence, occurredAt, allowed);
  const checkpointId = stableId("checkpoint", job.id, String(input.fence.attempt), input.step, disposition);
  const attemptId = stableId("step-attempt", job.id, String(input.fence.attempt), input.step);
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
    eventId: stableId("event", job.id, String(input.fence.attempt), input.step, disposition),
    projectId: job.projectId,
    jobId: job.id,
    type: "run.step.changed",
    createdAt: occurredAt,
    payload: { projectRevision: input.projectRevision, data: { jobId: job.id, step: input.step, checkpointId } }
  });
  return { job, checkpoint, stepAttempt, event };
}

function recordCompletedStepTransition(
  repositories: StorageV2RepositorySet,
  job: StorageJob,
  input: StorageTerminalTransitionInput,
  disposition: CompletedStepDisposition
): StorageStepDispositionResult {
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

function readCompletedStepTransitionRetry(
  repositories: StorageV2RepositorySet,
  job: StorageJob,
  input: StorageTerminalTransitionInput,
  disposition: CompletedStepDisposition
): StorageStepDispositionResult {
  const step = requiredCompletedStep(input);
  const checkpointId = stableId("checkpoint", job.id, String(input.fence.attempt), step.step, disposition);
  const attemptId = stableId("step-attempt", job.id, String(input.fence.attempt), step.step);
  const eventId = stableId("event", job.id, String(input.fence.attempt), step.step, disposition);
  const checkpoint = repositories.checkpoints.get(checkpointId);
  const attempt = repositories.checkpoints.listStepAttempts(job.id).find((candidate) => candidate.id === attemptId);
  const event = repositories.events.get(eventId);
  if (!checkpoint || !attempt || !event) {
    throw new Error(`Completed step terminal retry is missing its durable ${disposition} disposition.`);
  }
  return recordCompletedStepTransition(repositories, job, input, disposition);
}

function requiredCompletedStep(input: StorageTerminalTransitionInput): NonNullable<StorageTerminalTransitionInput["completedStep"]> {
  if (!input.completedStep) throw new Error("Completed step metadata is required.");
  return input.completedStep;
}

function runningStepAttempt(job: StorageJob, step: string, startedAt: string): StorageStepAttempt {
  return {
    id: stableId("step-attempt", job.id, String(job.attempt), step),
    projectId: job.projectId,
    jobId: job.id,
    step,
    attemptIndex: job.attempt,
    status: "running",
    workerId: job.leaseOwner,
    startedAt
  };
}

function requiredJob(repositories: StorageV2RepositorySet, jobId: string): StorageJob {
  const job = repositories.jobs.get(jobId);
  if (!job) throw new Error(`Storage job not found: ${jobId}`);
  return job;
}

function requiredProjectRevision(job: StorageJob): number {
  const payload = job.payload && typeof job.payload === "object" && !Array.isArray(job.payload) ? (job.payload as Record<string, unknown>) : undefined;
  const result = job.result && typeof job.result === "object" && !Array.isArray(job.result) ? (job.result as Record<string, unknown>) : undefined;
  const revision = result?.projectRevision ?? payload?.projectRevision;
  if (!Number.isInteger(revision) || Number(revision) < 0) {
    throw new Error(`Expired durable job is missing a valid project revision: ${job.id}`);
  }
  return Number(revision);
}

function requiredClaimMetadata(job: StorageJob): { projectRevision: number; step?: string } {
  const payload = job.payload && typeof job.payload === "object" && !Array.isArray(job.payload) ? (job.payload as Record<string, unknown>) : undefined;
  const projectRevision = requiredProjectRevision(job);
  if (payload?.currentStep === undefined) return { projectRevision };
  if (typeof payload.currentStep !== "string" || !payload.currentStep.trim()) {
    throw new Error(`Durable job has an invalid current step: ${job.id}`);
  }
  return { projectRevision, step: payload.currentStep };
}

function stableId(prefix: string, ...parts: string[]): string {
  return `${prefix}-${createHash("sha256").update(parts.join("\u0000")).digest("hex")}`;
}
