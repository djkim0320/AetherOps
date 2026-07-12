import { randomUUID } from "node:crypto";
import type { JobKind, JobStatus } from "../../contracts/api-v2/jobs.js";
import type { SseEvent } from "../../contracts/api-v2/events.js";
import { createStorageWorkerClient, type StorageWorkerClient } from "../runtime/storage/worker/typedRuntime.js";
import type { StorageCapabilityAudit, StorageCheckpoint, StorageJob, StorageJobEvent, StorageStepAttempt } from "../runtime/storage/v2/types.js";
import type {
  StorageLlmInvocation,
  StorageNetworkAudit,
  StorageToolAttempt,
  StorageToolDecision,
  StorageToolOutputLink
} from "../runtime/storage/v2/traceTypes.js";
import { toDurableJobRecord } from "./durableJobMappers.js";
import { commitCompletedStep, quarantineFailedStep } from "./durableJobCheckpointRuntime.js";
import { durableJobRequestHash } from "./durableJobRequestHash.js";
import { DurableJobTraceRuntime } from "./durableJobTraceRuntime.js";
import { assertDurableResumeSource } from "./durableResumeValidator.js";
import type { DurableJobControl, DurableJobDetail, DurableJobHandler, DurableJobReceipt, DurableJobRecord, EnqueueDurableJob } from "./durableJobTypes.js";

export class DurableJobRuntime {
  private readonly client: StorageWorkerClient;
  private readonly work = new Map<string, (job: DurableJobRecord) => Promise<void>>();
  private readonly handlers = new Map<JobKind, DurableJobHandler>();
  private readonly scheduledProjects = new Set<string>();
  private readonly trace: DurableJobTraceRuntime;
  private readonly activeControllers = new Map<string, AbortController>();
  private readonly requestedControls = new Map<string, DurableJobControl>();
  private closed = false;
  private active = 0;
  private leaseSweep: ReturnType<typeof setInterval> | undefined;

  constructor(
    databasePath: string,
    private readonly concurrency = 4
  ) {
    this.client = createStorageWorkerClient({ appDbPath: databasePath, vectorDbPath: databasePath, ontologyDbPath: databasePath, requireFts5: true });
    this.trace = new DurableJobTraceRuntime(this.client);
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
    if (input.resumeCheckpointId) await assertDurableResumeSource(this.client, input);
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
    const requestHash =
      input.requestHash ??
      durableJobRequestHash({
        projectId: input.projectId,
        kind: input.kind,
        projectRevision: input.projectRevision,
        currentStep: input.currentStep,
        resumesJobId: input.resumesJobId,
        resumeCheckpointId: input.resumeCheckpointId,
        requestedCapabilities: input.requestedCapabilities,
        effectiveCapabilities: input.effectiveCapabilities,
        toolPolicy: input.toolPolicy,
        request: input.payload
      });
    const stored = await this.client.request<StorageJob>({
      name: "job.enqueue",
      job: {
        id,
        projectId: input.projectId,
        operation: input.kind,
        payload,
        idempotencyKey: input.idempotencyKey,
        requestHash,
        requestedCapabilities: input.requestedCapabilities,
        effectiveCapabilities: input.effectiveCapabilities,
        toolPolicy: input.toolPolicy,
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

  async getDetail(jobId: string): Promise<DurableJobDetail | undefined> {
    const job = await this.get(jobId);
    if (!job) return undefined;
    const [llmInvocations, toolDecisions, toolAttempts, codexCliExecutions, networkAudits] = await Promise.all([
      this.client.request<StorageLlmInvocation[]>({ name: "trace.llm.listJob", jobId, limit: 1_000 }),
      this.client.request<StorageToolDecision[]>({ name: "trace.decision.listJob", jobId, limit: 1_000 }),
      this.client.request<StorageToolAttempt[]>({ name: "trace.attempt.listJob", jobId, limit: 1_000 }),
      this.client.request<import("../runtime/storage/v2/traceTypes.js").StorageCodexCliExecution[]>({
        name: "trace.codex.listJob",
        jobId,
        limit: 1_000
      }),
      this.client.request<StorageNetworkAudit[]>({ name: "trace.network.listJob", jobId, limit: 1_000 })
    ]);
    const outputGroups = await Promise.all(
      toolAttempts.map((attempt) => this.client.request<StorageToolOutputLink[]>({ name: "trace.output.listAttempt", attemptId: attempt.id, limit: 1_000 }))
    );
    const hasTrace = Boolean(job.requestHash || llmInvocations.length || toolDecisions.length || toolAttempts.length || networkAudits.length);
    return {
      ...job,
      traceAvailability: hasTrace ? "available" : "legacy_unavailable",
      trace: { llmInvocations, toolDecisions, toolAttempts, codexCliExecutions, outputs: outputGroups.flat(), networkAudits }
    };
  }

  async list(projectId: string, options: { status?: JobStatus; limit?: number } = {}): Promise<{ jobs: DurableJobRecord[] }> {
    const rows = await this.client.request<StorageJob[]>({ name: "job.listProject", projectId, limit: options.limit ?? 50 });
    return { jobs: rows.map(toDurableJobRecord).filter((job) => !options.status || job.status === options.status) };
  }

  async requestPause(jobId: string): Promise<DurableJobRecord> {
    const record = toDurableJobRecord(await this.client.request<StorageJob>({ name: "job.requestPause", jobId }));
    this.interrupt(jobId, "pause");
    return record;
  }

  async requestAbort(jobId: string): Promise<DurableJobRecord> {
    const record = toDurableJobRecord(await this.client.request<StorageJob>({ name: "job.requestCancel", jobId }));
    this.interrupt(jobId, "abort");
    return record;
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
          error: reason,
          ...(status === "blocked" && reason ? { blockedReason: reason } : {}),
          ...(status === "failed" && reason ? { failureReason: reason } : {})
        }
      })
    );
  }

  async fail(jobId: string, reason: string): Promise<DurableJobRecord> {
    return toDurableJobRecord(await this.client.request<StorageJob>({ name: "job.updateStatus", jobId, patch: { status: "failed", error: reason } }));
  }

  async appendEvent(event: Omit<SseEvent, "id">): Promise<SseEvent> {
    return this.trace.appendEvent(event);
  }

  async saveLlmInvocation(invocation: StorageLlmInvocation): Promise<StorageLlmInvocation> {
    return this.trace.saveLlmInvocation(invocation);
  }

  async recordToolDecision(decision: StorageToolDecision): Promise<StorageToolDecision> {
    return this.trace.recordToolDecision(decision);
  }

  async recordToolAttemptAndEvent(input: { attempt: StorageToolAttempt; projectRevision: number; toolName: string }): Promise<StorageToolAttempt> {
    return this.trace.recordToolAttemptAndEvent(input);
  }

  async recordToolOutput(link: StorageToolOutputLink): Promise<StorageToolOutputLink> {
    return this.trace.recordToolOutput(link);
  }

  async saveCodexCliExecution(
    execution: import("../runtime/storage/v2/traceTypes.js").StorageCodexCliExecution
  ): Promise<import("../runtime/storage/v2/traceTypes.js").StorageCodexCliExecution> {
    return this.trace.saveCodexCliExecution(execution);
  }

  async recordPromotedArtifactAndEvent(input: {
    link: StorageToolOutputLink;
    projectRevision: number;
    artifact: { name: string; kind: string };
  }): Promise<StorageToolOutputLink> {
    return this.trace.recordPromotedArtifactAndEvent(input);
  }

  async recordNetworkAudit(audit: StorageNetworkAudit): Promise<StorageNetworkAudit> {
    return this.trace.recordNetworkAudit(audit);
  }

  commitCheckpoint(input: { projectId: string; jobId: string; step: string; projectRevision: number }): Promise<StorageCheckpoint> {
    return this.trace.commitCheckpoint(input);
  }

  latestCommittedCheckpoint(jobId: string): Promise<StorageCheckpoint | undefined> {
    return this.client.request({ name: "checkpoint.latestCommittedForJob", jobId });
  }

  getCheckpoint(checkpointId: string): Promise<StorageCheckpoint | undefined> {
    return this.client.request({ name: "checkpoint.get", checkpointId });
  }

  async recordCapabilityAudits(audits: StorageCapabilityAudit[]): Promise<void> {
    for (const audit of audits) await this.client.request({ name: "capability.record", audit });
  }

  async eventsAfter(projectId: string, lastEventId?: string | number, limit = 200): Promise<SseEvent[]> {
    return this.trace.eventsAfter(projectId, lastEventId, limit);
  }

  subscribe(listener: (event: SseEvent) => void): () => void {
    return this.trace.subscribe(listener);
  }

  private publishStoredEvent(stored: StorageJobEvent): SseEvent {
    return this.trace.publishStoredEvent(stored);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.leaseSweep) clearInterval(this.leaseSweep);
    this.trace.close();
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
    const controller = new AbortController();
    this.activeControllers.set(stored.id, controller);
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
      else
        await registered?.(record, payload.request, {
          signal: controller.signal,
          requestedControl: () => this.requestedControls.get(stored.id)
        });
      const requestedControl = this.requestedControls.get(stored.id);
      const afterRun = await this.get(stored.id);
      if (requestedControl && afterRun && ["running", "pause_requested", "cancel_requested"].includes(afterRun.status)) {
        await this.settle(stored.id, requestedControl === "pause" ? "paused" : "aborted", afterRun.projectRevision, `${requestedControl} requested by user`);
      }
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
        const requestedControl = this.requestedControls.get(stored.id);
        const failed = requestedControl
          ? await this.settle(stored.id, requestedControl === "pause" ? "paused" : "aborted", toDurableJobRecord(stored).projectRevision, reason)
          : await this.fail(stored.id, reason);
        await this.appendEvent({
          projectId,
          projectRevision: failed.projectRevision,
          occurredAt: new Date().toISOString(),
          type: "run.status.changed",
          data: { jobId: failed.id, status: failed.status, previousStatus: "running", reason }
        });
      }
    } finally {
      clearInterval(renew);
      this.activeControllers.delete(stored.id);
      this.requestedControls.delete(stored.id);
      if (!this.closed) this.schedule(projectId);
    }
  }
  private assertOpen(): void {
    if (this.closed) throw new Error("Durable job runtime is closed.");
  }

  private interrupt(jobId: string, control: DurableJobControl): void {
    this.requestedControls.set(jobId, control);
    this.activeControllers.get(jobId)?.abort(new Error(`Durable job ${control} requested.`));
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
    await commitCompletedStep(
      { client: this.client, get: (jobId) => this.get(jobId), publish: (event) => void this.publishStoredEvent(event) },
      job,
      step,
      attemptId,
      workerId
    );
  }

  private async quarantineFailedStep(job: StorageJob, step: string, attemptId: string, workerId: string, error: string): Promise<void> {
    await quarantineFailedStep(this.client, job, step, attemptId, workerId, error);
  }
}
