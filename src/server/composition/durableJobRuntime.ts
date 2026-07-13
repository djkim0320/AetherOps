import { randomUUID } from "node:crypto";
import type { JobKind, JobStatus } from "../../contracts/api-v2/jobs.js";
import type { SseEvent } from "../../contracts/api-v2/events.js";
import { createStorageWorkerClient, type StorageWorkerClient } from "../runtime/storage/worker/typedRuntime.js";
import type { StorageOperationalDiagnosticSnapshot } from "../runtime/storage/worker/storageRuntimeDiagnostics.js";
import type { StorageExpiredLeaseSweepResult, StorageJobControlResult, StorageOutputPromotion } from "../runtime/storage/v2/jobAtomicTypes.js";
import type {
  StorageCapabilityAudit,
  StorageCheckpoint,
  StorageClaimStartResult,
  StorageJobEvent,
  StorageJobQueueDiagnostics,
  StorageRunnableProjectPage
} from "../runtime/storage/v2/types.js";
import type {
  StorageLlmInvocation,
  StorageNetworkAudit,
  StorageToolAttempt,
  StorageToolDecision,
  StorageToolOutputLink
} from "../runtime/storage/v2/traceTypes.js";
import { durableFailureFrom } from "./durableFailure.js";
import { DurableJobExecutionContext, type DurableTerminalOutcome } from "./durableJobExecutionContext.js";
import { DurableJobExecutor, publicTerminalReason } from "./durableJobExecutor.js";
import { enqueueDurableJob, getDurableJob, getDurableJobDetail, listDurableJobs, recordDurableCapabilityAudits } from "./durableJobStore.js";
import { toDurableJobRecord } from "./durableJobMappers.js";
import { DurableJobTraceRuntime } from "./durableJobTraceRuntime.js";
import type {
  DurableJobControl,
  DurableJobDetail,
  DurableJobHandler,
  DurableJobReceipt,
  DurableJobRecord,
  DurableTracePageRequest,
  EnqueueDurableJob
} from "./durableJobTypes.js";
import { DurableProjectLaneScheduler } from "./durableProjectLaneScheduler.js";
import { resolveDurableRuntimeConfig, runtimeNow, type DurableJobRuntimeOptions, type ResolvedDurableRuntimeConfig } from "./durableRuntimeConfig.js";
import { DurableRuntimeDiagnostics, type DurableOperationalDiagnosticSnapshot, type DurableRuntimeDiagnosticSnapshot } from "./durableRuntimeDiagnostics.js";
import { SseRuntimeDiagnostics } from "./sseRuntimeDiagnostics.js";
import { waitForActiveRuns } from "./durableRuntimeShutdown.js";

type RuntimeState = "new" | "running" | "draining" | "aborting" | "closing_storage" | "closed";

export class DurableJobRuntime {
  private readonly client: StorageWorkerClient;
  private readonly config: ResolvedDurableRuntimeConfig;
  private readonly handlers = new Map<JobKind, DurableJobHandler>();
  private readonly execution = new DurableJobExecutionContext();
  private readonly diagnostics = new DurableRuntimeDiagnostics();
  private readonly sseDiagnostics: SseRuntimeDiagnostics;
  private readonly trace: DurableJobTraceRuntime;
  private readonly executor: DurableJobExecutor;
  private readonly lanes: DurableProjectLaneScheduler;
  private readonly diagnosticCountersSince: string;
  private state: RuntimeState = "new";
  private leaseSweepTimer?: ReturnType<typeof setTimeout>;
  private closePromise?: Promise<void>;

  constructor(databasePath: string, options: number | DurableJobRuntimeOptions = 4) {
    const resolvedOptions = typeof options === "number" ? { concurrency: options } : options;
    this.config = resolveDurableRuntimeConfig(resolvedOptions);
    this.diagnosticCountersSince = runtimeNow(this.config);
    this.sseDiagnostics = resolvedOptions.sseDiagnostics ?? new SseRuntimeDiagnostics();
    this.client =
      resolvedOptions.storageClient ??
      createStorageWorkerClient({ appDbPath: databasePath, vectorDbPath: databasePath, ontologyDbPath: databasePath, requireFts5: true });
    this.trace = new DurableJobTraceRuntime(this.client, undefined, () => this.execution.current()?.fence);
    this.executor = new DurableJobExecutor({
      client: this.client,
      config: this.config,
      trace: this.trace,
      execution: this.execution,
      handlers: this.handlers,
      diagnostics: this.diagnostics,
      canWrite: () => this.state !== "closing_storage" && this.state !== "closed",
      logFailure: (error, jobId, projectId, diagnosticId) => this.logFailure(error, jobId, projectId, diagnosticId)
    });
    this.lanes = new DurableProjectLaneScheduler({
      concurrency: this.config.concurrency,
      canRun: () => this.state === "running",
      drain: (projectId) => this.drainProject(projectId),
      onFailure: (error, projectId) => this.logFailure(error, undefined, projectId),
      onActiveChanged: (count) => this.diagnostics.setActiveProjects(count)
    });
  }

  async initialize(): Promise<void> {
    if (this.state !== "new") throw new Error("Durable job runtime has already been initialized.");
    const sweep = await this.sweepExpiredLeases();
    const recovered = await this.discoverRunnableProjects();
    this.diagnostics.recordRecoveryProjects(new Set([...sweep.projectIds, ...recovered]).size);
    this.state = "running";
    for (const projectId of [...sweep.projectIds, ...recovered]) this.schedule(projectId);
    this.scheduleLeaseSweep();
  }

  registerHandler(kind: JobKind, handler: DurableJobHandler): void {
    if (this.handlers.has(kind)) throw new Error(`Durable job handler is already registered: ${kind}`);
    this.handlers.set(kind, handler);
  }

  async enqueue(input: EnqueueDurableJob): Promise<DurableJobReceipt> {
    return enqueueDurableJob(
      {
        client: this.client,
        config: this.config,
        assertAccepting: () => this.assertRunning(),
        hasHandler: (kind) => this.handlers.has(kind),
        schedule: (projectId) => this.schedule(projectId),
        publish: (event) => void this.trace.publishStoredEvent(event)
      },
      input
    );
  }

  get(jobId: string): Promise<DurableJobRecord | undefined> {
    return getDurableJob(this.client, jobId);
  }

  getDetail(jobId: string, tracePage?: DurableTracePageRequest): Promise<DurableJobDetail | undefined> {
    return getDurableJobDetail(this.client, jobId, tracePage);
  }

  async list(
    projectId: string,
    options: { status?: JobStatus; limit?: number; cursor?: string } = {}
  ): Promise<{ jobs: DurableJobRecord[]; nextCursor?: string }> {
    return listDurableJobs(this.client, projectId, options);
  }

  async requestPause(jobId: string, projectRevision?: number): Promise<DurableJobRecord> {
    return this.requestControl(jobId, "pause", projectRevision);
  }

  async requestAbort(jobId: string, projectRevision?: number): Promise<DurableJobRecord> {
    return this.requestControl(jobId, "abort", projectRevision);
  }

  finish(jobId: string, projectRevision: number, promotions?: StorageOutputPromotion[]): Promise<DurableJobRecord> {
    return this.settle(jobId, "completed", projectRevision, undefined, promotions);
  }

  async settle(
    jobId: string,
    status: Extract<JobStatus, "paused" | "aborted" | "blocked" | "failed" | "completed">,
    projectRevision: number,
    reason?: string,
    promotions?: StorageOutputPromotion[]
  ): Promise<DurableJobRecord> {
    const outcome: DurableTerminalOutcome = {
      status,
      projectRevision,
      ...(reason ? { reason: publicTerminalReason(status, reason) } : {}),
      ...(promotions?.length ? { promotions } : {})
    };
    return this.execution.settle(jobId, outcome);
  }

  async appendEvent(event: Omit<SseEvent, "id">): Promise<SseEvent> {
    return this.trace.appendEvent(event);
  }

  saveLlmInvocation(value: StorageLlmInvocation): Promise<StorageLlmInvocation> {
    return this.trace.saveLlmInvocation(value);
  }
  recordToolDecision(value: StorageToolDecision): Promise<StorageToolDecision> {
    return this.trace.recordToolDecision(value);
  }
  recordToolAttemptAndEvent(input: { attempt: StorageToolAttempt; projectRevision: number; toolName: string }): Promise<StorageToolAttempt> {
    return this.trace.recordToolAttemptAndEvent(input);
  }
  recordToolOutput(value: StorageToolOutputLink): Promise<StorageToolOutputLink> {
    return this.trace.recordToolOutput(value);
  }
  saveCodexCliExecution(value: import("../runtime/storage/v2/traceTypes.js").StorageCodexCliExecution) {
    return this.trace.saveCodexCliExecution(value);
  }
  recordNetworkAudit(value: StorageNetworkAudit): Promise<StorageNetworkAudit> {
    return this.trace.recordNetworkAudit(value);
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
    await recordDurableCapabilityAudits(this.client, audits);
  }
  async eventsAfter(projectId: string, lastEventId?: string | number, limit = 200, signal?: AbortSignal): Promise<SseEvent[]> {
    signal?.throwIfAborted();
    const events = await this.trace.eventsAfter(projectId, lastEventId, limit);
    signal?.throwIfAborted();
    return events;
  }
  subscribe(listener: (event: SseEvent) => void): () => void {
    return this.trace.subscribe(listener);
  }
  diagnosticSnapshot(): DurableRuntimeDiagnosticSnapshot {
    return this.diagnostics.snapshot();
  }

  async operationalDiagnostics(queueProjectLimit = 100): Promise<DurableOperationalDiagnosticSnapshot> {
    const sampledAtMs = this.config.clock.now();
    const generatedAt = new Date(sampledAtMs).toISOString();
    const [queue, storage] = await Promise.all([
      this.client.request<StorageJobQueueDiagnostics>({ name: "job.queueDiagnostics", limit: queueProjectLimit }),
      this.client.request<StorageOperationalDiagnosticSnapshot>({ name: "diagnostics.storage" })
    ]);
    return {
      generatedAt,
      countersSince: this.diagnosticCountersSince,
      runtime: this.diagnostics.snapshot(),
      sse: this.sseDiagnostics.snapshot(),
      traceQueries: storage.traceQueries,
      storageTransactions: storage.storageTransactions,
      queue: {
        projects: queue.projects.map((project) => ({
          ...project,
          oldestQueuedAgeMs: queuedAgeMs(project.oldestQueuedAt, sampledAtMs)
        })),
        totalDepth: queue.totalDepth,
        ...(queue.oldestQueuedAt ? { oldestQueuedAt: queue.oldestQueuedAt, oldestQueuedAgeMs: queuedAgeMs(queue.oldestQueuedAt, sampledAtMs) } : {}),
        totalProjects: queue.totalProjects,
        truncated: queue.truncated
      }
    };
  }

  close(): Promise<void> {
    this.closePromise ??= this.performClose();
    return this.closePromise;
  }

  private schedule(projectId: string): void {
    this.lanes.schedule(projectId);
  }

  private async drainProject(projectId: string): Promise<boolean> {
    if (this.state !== "running") return false;
    const now = runtimeNow(this.config);
    const claimed = await this.client.request<StorageClaimStartResult | undefined>({
      name: "job.claimAndStart",
      options: {
        projectId,
        leaseOwner: this.config.workerInstanceId,
        leaseExpiresAt: new Date(this.config.clock.now() + this.config.leaseTtlMs).toISOString(),
        now
      }
    });
    if (!claimed) return false;
    if (this.state !== "running") {
      await this.executor.interruptClaimedBeforeExecution(claimed);
      return true;
    }
    this.trace.publishStoredEvent(claimed.event);
    await this.executor.run(claimed);
    return true;
  }

  private async requestControl(jobId: string, control: DurableJobControl, projectRevision?: number): Promise<DurableJobRecord> {
    const current = await this.get(jobId);
    if (!current) throw new Error(`Durable job not found: ${jobId}`);
    const result = await this.client.request<StorageJobControlResult>({
      name: "job.requestControl",
      input: {
        jobId,
        control: control === "abort" ? "cancel" : "pause",
        projectRevision: projectRevision ?? current.projectRevision,
        occurredAt: runtimeNow(this.config)
      }
    });
    this.trace.publishStoredEvent(result.event);
    if (["pause_requested", "cancel_requested"].includes(result.job.status)) this.executor.interrupt(jobId, control);
    else this.schedule(result.job.projectId);
    return toDurableJobRecord(result.job);
  }

  private async discoverRunnableProjects(): Promise<string[]> {
    const projectIds: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.client.request<StorageRunnableProjectPage>({ name: "job.listRunnableProjects", cursor, limit: 250 });
      projectIds.push(...page.projectIds);
      if (page.nextCursor && page.nextCursor === cursor) throw new Error("Runnable project recovery cursor made no progress.");
      cursor = page.nextCursor;
    } while (cursor);
    return projectIds;
  }

  private async sweepExpiredLeases(): Promise<StorageExpiredLeaseSweepResult> {
    const result = await this.client.request<StorageExpiredLeaseSweepResult>({ name: "job.markInterruptedExpiredLeases", now: runtimeNow(this.config) });
    this.publishEvents(result.events);
    return result;
  }

  private scheduleLeaseSweep(): void {
    if (this.state !== "running") return;
    this.leaseSweepTimer = this.config.timer.setTimeout(() => {
      this.leaseSweepTimer = undefined;
      void this.sweepExpiredLeases()
        .then((result) => result.projectIds.forEach((projectId) => this.schedule(projectId)))
        .catch((error) => this.logFailure(error))
        .finally(() => this.scheduleLeaseSweep());
    }, this.config.leaseSweepMs);
    this.leaseSweepTimer.unref?.();
  }

  private async performClose(): Promise<void> {
    if (this.state === "closed") return;
    this.state = "draining";
    this.lanes.clearScheduled();
    if (this.leaseSweepTimer) this.config.timer.clearTimeout(this.leaseSweepTimer);
    const drained = await waitForActiveRuns(this.lanes.activePromises(), this.config.shutdownGraceMs, this.config.timer);
    if (!drained) {
      this.state = "aborting";
      this.executor.interruptAll();
      const aborted = await waitForActiveRuns(this.lanes.activePromises(), this.config.shutdownGraceMs, this.config.timer);
      if (!aborted) await this.executor.revokeLingeringLeases();
    }
    this.state = "closing_storage";
    this.trace.close();
    try {
      await this.client.close();
    } finally {
      this.state = "closed";
    }
  }

  private publishEvents(events: StorageJobEvent[]): void {
    const seen = new Set<number>();
    for (const event of events)
      if (!seen.has(event.sequence)) {
        seen.add(event.sequence);
        this.trace.publishStoredEvent(event);
      }
  }

  private assertRunning(): void {
    if (this.state !== "running") throw new Error(`Durable job runtime is not accepting work (${this.state}).`);
  }

  private logFailure(error: unknown, jobId?: string, projectId?: string, diagnosticId?: string): void {
    const failure = durableFailureFrom(error, { diagnosticId: () => diagnosticId ?? `job-${randomUUID()}` });
    console.error(
      JSON.stringify({
        level: "error",
        operation: "durable_job_runtime",
        diagnosticId: failure.internalDiagnosticId,
        errorCode: isLeaseLost(error) ? "LEASE_LOST" : failure.code,
        ...(jobId ? { jobId } : {}),
        ...(projectId ? { projectId } : {})
      })
    );
  }
}

function isLeaseLost(error: unknown): boolean {
  return error instanceof Error && error.name === "LeaseLostError";
}

function queuedAgeMs(queuedAt: string, sampledAtMs: number): number {
  const queuedAtMs = Date.parse(queuedAt);
  if (!Number.isFinite(queuedAtMs)) throw new Error("Durable queue diagnostics returned an invalid queued timestamp.");
  return Math.max(0, Math.floor(sampledAtMs - queuedAtMs));
}
