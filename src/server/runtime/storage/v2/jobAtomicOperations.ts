import { storageLeaseFence } from "./leaseFence.js";
import { resolveDurableTerminal } from "./jobTerminalResolution.js";
import { jobAtomicId as stableId } from "./jobAtomicIds.js";
import { hasTerminalStep, readTerminalStepTransitionRetry, recordTerminalStepTransition } from "./jobStepOperations.js";
import { assertNoActiveToolAttempts, interruptTerminalToolAttempts } from "./jobToolAttemptSettlement.js";
import type { StorageV2RepositorySet } from "./repositories.js";
import type {
  StorageExpiredLeaseSweepResult,
  StorageOutputPromotion,
  StorageProjectSnapshotChange,
  StorageTerminalTransitionInput,
  StorageTerminalTransitionResult
} from "./jobAtomicTypes.js";
import type { StorageClaimStartOptions, StorageClaimStartResult, StorageJobEvent, StorageJob, StorageLeaseFence, StorageStepAttempt } from "./types.js";
import type { StorageToolOutputLink } from "./traceTypes.js";
import { assertToolAttemptOutputPromotionAllowed } from "./toolPostcondition.js";
export { enqueueJob } from "./jobEnqueueAtomic.js";
export { requestControl } from "./jobControlOperations.js";
export { commitStep, quarantineStep, storageStepCheckpointId } from "./jobStepOperations.js";
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
  assertSnapshotChange(input);
  if (input.completedStep && input.quarantinedStep) {
    throw new Error("A terminal transition cannot commit and quarantine a step at the same time.");
  }
  if (input.completedStep && input.status !== "completed") {
    throw new Error("A completed step can be committed only with a completed terminal request.");
  }
  if (input.quarantinedStep && input.status === "completed") {
    throw new Error("A quarantined step cannot accompany a completed terminal request.");
  }
  if (input.promotions?.length && input.status !== "completed") {
    throw new Error("Output promotions are allowed only when completing a job.");
  }
  const before = repositories.jobs.assertFence(input.fence, [
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
    assertNoActiveToolAttempts(repositories, before.id);
    const terminal = readTerminalRetry(repositories, before, resolvedInput);
    const stepDisposition = hasTerminalStep(input)
      ? readTerminalStepTransitionRetry(repositories, before, resolvedInput, resolution.stepDisposition)
      : undefined;
    return {
      ...terminal,
      events: [...(stepDisposition ? [stepDisposition.event] : []), ...terminal.events],
      ...(stepDisposition ? { stepDisposition } : {})
    };
  }
  repositories.projectRevisions.assertCurrent(before.projectId, input.projectRevision);
  const committedProjectRevision = repositories.projectRevisions.allocate(before.projectId);
  const committedInput: StorageTerminalTransitionInput = {
    ...resolvedInput,
    projectRevision: committedProjectRevision,
    ...(resolvedInput.snapshotChange ? { snapshotChange: { ...resolvedInput.snapshotChange, snapshotVersion: committedProjectRevision } } : {})
  };
  let toolSettlementEvents: StorageJobEvent[] = [];
  if (resolution.status !== "completed") {
    toolSettlementEvents = interruptTerminalToolAttempts(
      repositories,
      before,
      committedProjectRevision,
      occurredAt,
      resolution.reason ?? `Durable job settled as ${resolution.status}.`,
      `job_${resolution.status}`
    ).events;
  }
  const stepDisposition = hasTerminalStep(input) ? recordTerminalStepTransition(repositories, before, committedInput, resolution.stepDisposition) : undefined;
  const promoted =
    resolution.status === "completed"
      ? (input.promotions ?? []).map((promotion) => promoteTerminalOutput(repositories, input.fence, promotion, committedProjectRevision, occurredAt))
      : [];
  if (resolution.status === "completed") assertNoActiveToolAttempts(repositories, before.id);
  const job = repositories.jobs.transitionFenced(input.fence, {
    status: resolution.status,
    result: { projectRevision: committedProjectRevision },
    error: resolution.reason,
    ...(resolution.status === "blocked" && resolution.reason ? { blockedReason: resolution.reason } : {}),
    ...(resolution.status === "failed" && resolution.reason ? { failureReason: resolution.reason } : {}),
    updatedAt: occurredAt
  });
  const event = repositories.events.append({
    eventId: stableId("event", job.id, String(input.fence.attempt), `terminal-${resolution.status}`),
    projectId: job.projectId,
    jobId: job.id,
    type: "run.status.changed",
    createdAt: occurredAt,
    payload: {
      projectRevision: committedProjectRevision,
      snapshotChange: committedInput.snapshotChange ?? null,
      data: { jobId: job.id, status: resolution.status, previousStatus: before.status, ...(resolution.reason ? { reason: resolution.reason } : {}) }
    }
  });
  const snapshotEvent = committedInput.snapshotChange
    ? repositories.events.append({
        eventId: terminalSnapshotEventId(job.id, input.fence.attempt, committedInput.snapshotChange.reason),
        projectId: job.projectId,
        jobId: job.id,
        type: "project.snapshot.changed",
        createdAt: occurredAt,
        payload: {
          projectRevision: committedProjectRevision,
          data: { snapshotVersion: committedInput.snapshotChange.snapshotVersion, reason: committedInput.snapshotChange.reason }
        }
      })
    : undefined;
  return {
    job,
    event,
    events: [
      ...toolSettlementEvents,
      ...(stepDisposition ? [stepDisposition.event] : []),
      ...promoted.flatMap((entry) => (entry.event ? [entry.event] : [])),
      event,
      ...(snapshotEvent ? [snapshotEvent] : [])
    ],
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
    if (promotion.engineering) {
      const receipt = repositories.engineering.getPromotion(job.projectId, promotion.engineering.id);
      if (!receipt || receipt.outputLinkId !== link.id || receipt.receiptHash !== promotion.engineering.receiptHash) {
        throw new Error(`Completed engineering promotion retry does not match durable receipt ${promotion.engineering.id}.`);
      }
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
  const storedSnapshotChange = payload?.snapshotChange;
  const snapshotIdentityMatches = input.snapshotChange
    ? snapshotChangeReason(storedSnapshotChange) === input.snapshotChange.reason
    : storedSnapshotChange === undefined || storedSnapshotChange === null;
  if (data?.jobId !== job.id || data?.status !== input.status || data?.reason !== input.reason || !snapshotIdentityMatches) {
    throw new Error(`Completed job terminal retry does not match durable event ${event.eventId}.`);
  }
  const snapshotEvent = input.snapshotChange
    ? (repositories.events.get(terminalSnapshotEventId(job.id, input.fence.attempt, input.snapshotChange.reason)) ??
      repositories.events.get(
        stableId("event", job.id, String(input.fence.attempt), `snapshot-${input.snapshotChange.snapshotVersion}-${input.snapshotChange.reason}`)
      ))
    : undefined;
  if (input.snapshotChange && !snapshotEvent) throw new Error(`Completed job snapshot event is missing for ${job.id}.`);
  if (input.snapshotChange && snapshotEvent) {
    const snapshotPayload =
      snapshotEvent.payload && typeof snapshotEvent.payload === "object" && !Array.isArray(snapshotEvent.payload)
        ? (snapshotEvent.payload as Record<string, unknown>)
        : undefined;
    const snapshotData =
      snapshotPayload?.data && typeof snapshotPayload.data === "object" && !Array.isArray(snapshotPayload.data)
        ? (snapshotPayload.data as Record<string, unknown>)
        : undefined;
    if (snapshotEvent.projectId !== job.projectId || snapshotEvent.jobId !== job.id || snapshotData?.reason !== input.snapshotChange.reason) {
      throw new Error(`Completed job snapshot event does not match terminal input for ${job.id}.`);
    }
  }
  return { job, event, events: [...artifactEvents, event, ...(snapshotEvent ? [snapshotEvent] : [])], links };
}

function snapshotChangeReason(value: unknown): unknown {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>).reason : undefined;
}

function terminalSnapshotEventId(jobId: string, attempt: number, reason: StorageProjectSnapshotChange["reason"]): string {
  return stableId("event", jobId, String(attempt), `snapshot-${reason}`);
}

function assertSnapshotChange(input: StorageTerminalTransitionInput): void {
  if (!input.snapshotChange) return;
  if (!Number.isInteger(input.snapshotChange.snapshotVersion) || input.snapshotChange.snapshotVersion < 0) {
    throw new Error("A terminal snapshot change requires a non-negative integer snapshot version.");
  }
  if (input.snapshotChange.snapshotVersion !== input.projectRevision) {
    throw new Error("A terminal snapshot version must match the committed project revision.");
  }
  if (!(
    input.snapshotChange.reason === "project_updated" ||
    input.snapshotChange.reason === "job_changed" ||
    input.snapshotChange.reason === "resync_required"
  )) {
    throw new Error("A terminal snapshot change has an unsupported reason.");
  }
}

export function interruptExpiredLeases(repositories: StorageV2RepositorySet, now = new Date().toISOString()): StorageExpiredLeaseSweepResult {
  const interrupted = repositories.jobs.markInterruptedExpiredLeases(now);
  const jobs: StorageJob[] = [];
  const events = interrupted.flatMap((interruptedJob) => {
    const projectRevision = repositories.projectRevisions.allocate(interruptedJob.projectId);
    const job = repositories.jobs.recordInterruptedProjectRevision(interruptedJob.id, projectRevision, now);
    jobs.push(job);
    repositories.checkpoints.interruptRunningStepAttempts(job.id, now, "Worker lease expired.");
    const settlement = interruptTerminalToolAttempts(repositories, job, projectRevision, now, "Worker lease expired.", "lease_expired");
    const event = repositories.events.append({
      eventId: stableId("event", job.id, String(job.attempt), String(job.leaseGeneration), "lease-expired"),
      projectId: job.projectId,
      jobId: job.id,
      type: "run.status.changed",
      createdAt: now,
      payload: {
        projectRevision,
        data: { jobId: job.id, status: "interrupted", reason: "Worker lease expired." }
      }
    });
    return [...settlement.events, event];
  });
  return { jobs, events, projectIds: [...new Set(jobs.map((job) => job.projectId))].sort() };
}
function promoteTerminalOutput(
  repositories: StorageV2RepositorySet,
  fence: StorageLeaseFence,
  promotion: StorageOutputPromotion,
  projectRevision: number,
  occurredAt: string
): { link: StorageToolOutputLink; event?: StorageJobEvent } {
  const job = repositories.jobs.assertFence(fence);
  if (promotion.link.jobId !== job.id || promotion.link.projectId !== job.projectId) throw new Error("Promoted output does not belong to the fenced job.");
  if (!promotion.link.promoted) throw new Error("A terminal promotion requires promoted=true.");
  const attempt = repositories.trace.getToolAttempt(promotion.link.attemptId);
  if (!attempt || attempt.jobId !== job.id || attempt.projectId !== job.projectId || attempt.status !== "completed") {
    throw new Error("A promoted output must originate from a completed tool attempt for the fenced job.");
  }
  const link = repositories.trace.recordOutputLink(promotion.link);
  const decision = repositories.trace.getToolDecision(attempt.decisionId);
  assertToolAttemptOutputPromotionAllowed(attempt);
  const requiresEngineeringReceipt = decision?.toolName === "EngineeringProgramTool" || decision?.toolName === "CodexCliTool";
  if (requiresEngineeringReceipt && !promotion.engineering) {
    throw new Error("Engineering output promotion requires a persisted baseline and artifact receipt.");
  }
  if (!requiresEngineeringReceipt && promotion.engineering) {
    throw new Error("A non-engineering tool output cannot attach an engineering promotion receipt.");
  }
  if (promotion.engineering) {
    const engineering = promotion.engineering;
    if (
      !decision ||
      engineering.projectId !== link.projectId ||
      engineering.jobId !== link.jobId ||
      engineering.attemptId !== link.attemptId ||
      engineering.outputLinkId !== link.id ||
      engineering.outputId !== link.outputId ||
      engineering.promotedAt !== link.promotedAt ||
      engineering.tool.name !== decision.toolName ||
      engineering.tool.version !== attempt.descriptorVersion ||
      engineering.tool.receiptHash !== attempt.postconditionReceipt?.receiptHash ||
      engineering.postconditionReceiptHash !== attempt.postconditionReceipt?.receiptHash
    ) {
      throw new Error("Engineering promotion receipt does not match its atomic output and tool origin.");
    }
    repositories.engineering.recordPromotion(engineering);
  }
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
