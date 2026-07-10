import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import type { JobKind, JobStatus } from "../../contracts/api-v2/jobs.js";
import type { SseEvent } from "../../contracts/api-v2/events.js";
import { createStorageWorkerClient, type StorageWorkerClient } from "../runtime/storage/worker/typedRuntime.js";
import type { StorageCapabilityAudit, StorageJob, StorageJobEvent, StorageStepAttempt } from "../runtime/storage/v2/types.js";
import { eventFromStorage, toDurableJobRecord } from "./durableJobMappers.js";
import type { DurableJobHandler, DurableJobReceipt, DurableJobRecord, EnqueueDurableJob } from "./durableJobTypes.js";

export class DurableJobRuntime {
  private readonly client: StorageWorkerClient;
  private readonly work = new Map<string, (job: DurableJobRecord) => Promise<void>>();
  private readonly handlers = new Map<JobKind, DurableJobHandler>();
  private readonly scheduledProjects = new Set<string>();
  private readonly emitter = new EventEmitter();
  private closed = false;
  private active = 0;
  private leaseSweep: ReturnType<typeof setInterval> | undefined;

  constructor(
    databasePath: string,
    private readonly concurrency = 4
  ) {
    this.client = createStorageWorkerClient({ appDbPath: databasePath, vectorDbPath: databasePath, ontologyDbPath: databasePath, requireFts5: true });
    this.emitter.setMaxListeners(0);
  }

  async initialize(): Promise<void> {
    await this.client.request({ name: "job.markInterruptedExpiredLeases", now: new Date().toISOString() });
    const queued = await this.client.request<StorageJob[]>({ name: "job.listQueued", limit: 1_000 });
    for (const job of queued) this.schedule(job.projectId);
    this.leaseSweep = setInterval(() => void this.sweepExpiredLeases(), 15_000);
    this.leaseSweep.unref();
  }

  registerHandler(kind: JobKind, handler: DurableJobHandler): void {
    if (this.handlers.has(kind)) throw new Error(`Durable job handler is already registered: ${kind}`);
    this.handlers.set(kind, handler);
  }

  async enqueue(input: EnqueueDurableJob, onRun?: (job: DurableJobRecord) => Promise<void>): Promise<DurableJobReceipt> {
    this.assertOpen();
    if (input.resumeCheckpointId) await this.assertResumeSource(input);
    const id = randomUUID();
    const acceptedAt = new Date().toISOString();
    const payload = {
      kind: input.kind,
      projectRevision: input.projectRevision,
      currentStep: input.currentStep,
      resumesJobId: input.resumesJobId,
      resumeCheckpointId: input.resumeCheckpointId,
      request: input.payload
    };
    const stored = await this.client.request<StorageJob>({
      name: "job.enqueue",
      job: {
        id,
        projectId: input.projectId,
        operation: input.kind,
        payload,
        idempotencyKey: input.idempotencyKey,
        createdAt: acceptedAt,
        queuedAt: acceptedAt
      }
    });
    const record = toDurableJobRecord(stored);
    if (stored.id === id && onRun) this.work.set(record.id, onRun);
    const projectJobs = await this.client.request<StorageJob[]>({ name: "job.listProject", projectId: input.projectId, limit: 200 });
    const queuePosition = projectJobs.filter((job) => job.status === "queued" && job.queuedAt <= stored.queuedAt).length - 1;
    this.schedule(input.projectId);
    return {
      jobId: record.id,
      projectId: record.projectId,
      kind: record.kind,
      status: "queued",
      queuePosition: Math.max(0, queuePosition),
      acceptedAt: record.createdAt,
      projectRevision: record.projectRevision
    };
  }

  async get(jobId: string): Promise<DurableJobRecord | undefined> {
    const job = await this.client.request<StorageJob | undefined>({ name: "job.get", jobId });
    return job ? toDurableJobRecord(job) : undefined;
  }

  async list(projectId: string, options: { status?: JobStatus; limit?: number } = {}): Promise<{ jobs: DurableJobRecord[] }> {
    const rows = await this.client.request<StorageJob[]>({ name: "job.listProject", projectId, limit: options.limit ?? 50 });
    return { jobs: rows.map(toDurableJobRecord).filter((job) => !options.status || job.status === options.status) };
  }

  async requestPause(jobId: string): Promise<DurableJobRecord> {
    return toDurableJobRecord(await this.client.request<StorageJob>({ name: "job.requestPause", jobId }));
  }

  async requestAbort(jobId: string): Promise<DurableJobRecord> {
    return toDurableJobRecord(await this.client.request<StorageJob>({ name: "job.requestCancel", jobId }));
  }

  async finish(jobId: string, projectRevision: number): Promise<DurableJobRecord> {
    return this.settle(jobId, "completed", projectRevision);
  }

  async settle(
    jobId: string,
    status: Extract<JobStatus, "paused" | "aborted" | "blocked" | "failed" | "completed">,
    projectRevision: number,
    reason?: string
  ): Promise<DurableJobRecord> {
    return toDurableJobRecord(
      await this.client.request<StorageJob>({
        name: "job.updateStatus",
        jobId,
        patch: {
          status,
          result: { projectRevision },
          error: reason
        }
      })
    );
  }

  async fail(jobId: string, reason: string): Promise<DurableJobRecord> {
    return toDurableJobRecord(await this.client.request<StorageJob>({ name: "job.updateStatus", jobId, patch: { status: "failed", error: reason } }));
  }

  async appendEvent(event: Omit<SseEvent, "id">): Promise<SseEvent> {
    const stored = await this.client.request<StorageJobEvent>({
      name: "event.append",
      event: {
        projectId: event.projectId,
        type: event.type,
        createdAt: event.occurredAt,
        payload: { projectRevision: event.projectRevision, data: event.data }
      }
    });
    const committed = eventFromStorage(stored);
    this.emitter.emit("event", committed);
    return committed;
  }

  async recordCapabilityAudits(audits: StorageCapabilityAudit[]): Promise<void> {
    for (const audit of audits) await this.client.request({ name: "capability.record", audit });
  }

  async eventsAfter(projectId: string, lastEventId?: string | number, limit = 200): Promise<SseEvent[]> {
    const rows = await this.client.request<StorageJobEvent[]>({ name: "event.after", projectId, lastEventId, limit });
    return rows.map(eventFromStorage);
  }

  subscribe(listener: (event: SseEvent) => void): () => void {
    this.emitter.on("event", listener);
    return () => this.emitter.off("event", listener);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.leaseSweep) clearInterval(this.leaseSweep);
    this.emitter.removeAllListeners();
    await this.client.close();
  }

  private schedule(projectId: string): void {
    this.scheduledProjects.add(projectId);
    queueMicrotask(() => void this.pump());
  }
  private async pump(): Promise<void> {
    while (!this.closed && this.active < this.concurrency && this.scheduledProjects.size) {
      const projectId = this.scheduledProjects.values().next().value as string;
      this.scheduledProjects.delete(projectId);
      this.active += 1;
      void this.drainProject(projectId).finally(() => {
        this.active -= 1;
        void this.pump();
      });
    }
  }
  private async drainProject(projectId: string): Promise<void> {
    const leaseOwner = `server-${process.pid}`;
    const leaseExpiresAt = new Date(Date.now() + 60_000).toISOString();
    const stored = await this.client.request<StorageJob | undefined>({ name: "job.claimNext", options: { projectId, leaseOwner, leaseExpiresAt } });
    if (!stored) return;
    const payload = (stored.payload && typeof stored.payload === "object" ? stored.payload : {}) as Record<string, unknown>;
    const step = payload.currentStep as string | undefined;
    const attemptId = `${stored.id}:${stored.attempt}`;
    if (step)
      await this.recordAttempt({
        id: attemptId,
        projectId,
        jobId: stored.id,
        step,
        attemptIndex: stored.attempt,
        status: "running",
        workerId: leaseOwner,
        startedAt: new Date().toISOString()
      });
    const callback = this.work.get(stored.id);
    const registered = this.handlers.get(stored.operation as JobKind);
    if (!callback && !registered) {
      await this.fail(stored.id, `No durable handler is registered for ${stored.operation}.`);
      return;
    }
    this.work.delete(stored.id);
    const renew = setInterval(() => void this.renewLease(stored.id, leaseOwner), 20_000);
    renew.unref();
    try {
      const record = toDurableJobRecord(stored);
      await this.appendEvent({
        projectId,
        projectRevision: record.projectRevision,
        occurredAt: new Date().toISOString(),
        type: "run.status.changed",
        data: { jobId: record.id, status: "running", previousStatus: "queued" }
      });
      if (callback) await callback(record);
      else await registered?.(record, payload.request);
      if (step) await this.commitCompletedStep(stored, step, attemptId, leaseOwner);
      const settled = await this.get(stored.id);
      if (settled && settled.status !== "running") {
        await this.appendEvent({
          projectId,
          projectRevision: settled.projectRevision,
          occurredAt: new Date().toISOString(),
          type: "run.status.changed",
          data: { jobId: settled.id, status: settled.status, previousStatus: "running", reason: settled.failureReason }
        });
      }
    } catch (error) {
      if (!this.closed) {
        const reason = error instanceof Error ? error.message : String(error);
        if (step) await this.quarantineFailedStep(stored, step, attemptId, leaseOwner, reason);
        const failed = await this.fail(stored.id, reason);
        await this.appendEvent({
          projectId,
          projectRevision: failed.projectRevision,
          occurredAt: new Date().toISOString(),
          type: "run.status.changed",
          data: { jobId: failed.id, status: "failed", previousStatus: "running", reason }
        });
      }
    } finally {
      clearInterval(renew);
      if (!this.closed) this.schedule(projectId);
    }
  }
  private async assertResumeSource(input: EnqueueDurableJob): Promise<void> {
    const checkpoint = await this.client.request<{ status: string; jobId: string } | undefined>({
      name: "checkpoint.get",
      checkpointId: input.resumeCheckpointId as string
    });
    const source = input.resumesJobId ? await this.client.request<StorageJob | undefined>({ name: "job.get", jobId: input.resumesJobId }) : undefined;
    if (
      !checkpoint ||
      checkpoint.status !== "committed" ||
      checkpoint.jobId !== source?.id ||
      !["paused", "interrupted", "blocked", "failed"].includes(source.status)
    ) {
      throw new Error("Resume requires a committed checkpoint from a paused, interrupted, blocked, or failed source job.");
    }
  }
  private assertOpen(): void {
    if (this.closed) throw new Error("Durable job runtime is closed.");
  }

  private async renewLease(jobId: string, leaseOwner: string): Promise<void> {
    if (this.closed) return;
    await this.client.request({ name: "job.renewLease", jobId, leaseOwner, leaseExpiresAt: new Date(Date.now() + 60_000).toISOString() });
  }

  private async sweepExpiredLeases(): Promise<void> {
    if (this.closed) return;
    await this.client.request({ name: "job.markInterruptedExpiredLeases", now: new Date().toISOString() });
  }

  private async recordAttempt(attempt: StorageStepAttempt): Promise<void> {
    await this.client.request({ name: "checkpoint.recordStepAttempt", attempt });
  }

  private async commitCompletedStep(job: StorageJob, step: string, attemptId: string, workerId: string): Promise<void> {
    const settled = await this.get(job.id);
    if (!settled || !["completed", "paused", "blocked"].includes(settled.status)) return;
    const now = new Date().toISOString();
    const checkpointId = randomUUID();
    await this.client.request({
      name: "checkpoint.save",
      checkpoint: {
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
      }
    });
    await this.recordAttempt({
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
    });
  }

  private async quarantineFailedStep(job: StorageJob, step: string, attemptId: string, workerId: string, error: string): Promise<void> {
    const now = new Date().toISOString();
    const checkpointId = randomUUID();
    await this.client.request({
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
    await this.recordAttempt({
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
    });
  }
}
