import type { JobKind, JobStatus } from "../../contracts/api-v2/jobs.js";
import type { SseEvent } from "../../contracts/api-v2/events.js";
import { createStorageWorkerClient, type StorageWorkerClient } from "../runtime/storage/worker/typedRuntime.js";
import type { StorageJobControlResult, StorageOutputPromotion } from "../runtime/storage/v2/jobAtomicTypes.js";
import type {
  StorageCapabilityAudit,
  StorageCheckpoint,
  StorageClaimStartResult,
  StorageJobEvent,
  StorageProjectPayload
} from "../runtime/storage/v2/types.js";
import type {
  StorageLlmInvocation,
  StorageNetworkAudit,
  StorageToolAttempt,
  StorageToolDecision,
  StorageToolOutputLink
} from "../runtime/storage/v2/traceTypes.js";
import type * as CS from "../runtime/storage/v2/runStateTypes.js";
import type { StorageCanonicalTerminalVerifyInput, StorageCanonicalTerminalVerifyResult } from "../runtime/storage/v2/terminalReceiptTypes.js";
import { fencedCanonicalStorageWrite, fencedCanonicalTaskContractWrite } from "./durableCanonicalStorageWrite.js";
import { commitDurableCanonicalRevisionPlan } from "./durableCanonicalRevisionCommit.js";
import { commitDurableCanonicalCheckpoint, type DurableCanonicalCheckpointCommitInput } from "./durableCanonicalCheckpointCommit.js";
import { commitDurableCanonicalBudget } from "./durableCanonicalBudgetCommit.js";
import type { DurableCanonicalTerminalTransition } from "./durableCanonicalTerminalTransition.js";
import type { CanonicalRevisionPlan } from "./canonicalRunTypes.js";
import type { RunStateRevision } from "../../core/orchestration/runStateCapsule.js";
import { DurableJobExecutionContext, type DurableTerminalOutcome } from "./durableJobExecutionContext.js";
import { DurableJobExecutor, publicTerminalReason } from "./durableJobExecutor.js";
import {
  enqueueDurableJob,
  findIdempotentDurableReceipt,
  getDurableJob,
  getDurableJobDetail,
  latestDurableProjectExecution,
  listDurableJobs,
  recordDurableCapabilityAudits,
  syncDurableProject
} from "./durableJobStore.js";
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
import {
  collectDurableOperationalDiagnostics,
  DurableRuntimeDiagnostics,
  type DurableOperationalDiagnosticSnapshot,
  type DurableRuntimeDiagnosticSnapshot
} from "./durableRuntimeDiagnostics.js";
import { SseRuntimeDiagnostics } from "./sseRuntimeDiagnostics.js";
import { waitForActiveRuns } from "./durableRuntimeShutdown.js";
import { logDurableRuntimeFailure } from "./durableRuntimeFailureLogger.js";
import { discoverDurableRunnableProjects, sweepDurableExpiredLeases } from "./durableJobRecovery.js";
import { DurableTerminalAttestedLeaseRuntime } from "./durableTerminalAttestedLeaseRuntime.js";
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
  readonly terminalOutputs: DurableTerminalAttestedLeaseRuntime;
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
      createStorageWorkerClient({
        appDbPath: databasePath,
        vectorDbPath: databasePath,
        ontologyDbPath: databasePath,
        requireFts5: true,
        ...(resolvedOptions.dataRoot ? { dataRoot: resolvedOptions.dataRoot } : {})
      });
    this.trace = new DurableJobTraceRuntime(this.client, undefined, () => this.execution.current()?.fence, resolvedOptions.dataRoot);
    this.terminalOutputs = new DurableTerminalAttestedLeaseRuntime(this.client);
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
    const recovered = await discoverDurableRunnableProjects(this.client);
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
  findIdempotentReceipt(projectId: string, idempotencyKey: string, requestHash: string): Promise<DurableJobReceipt | undefined> {
    return findIdempotentDurableReceipt(this.client, projectId, idempotencyKey, requestHash);
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
  latestProjectExecution(projectId: string, kind: JobKind): Promise<{ job?: DurableJobRecord; checkpoint?: StorageCheckpoint }> {
    return latestDurableProjectExecution(this.client, projectId, kind);
  }
  async requestPause(jobId: string, projectRevision?: number): Promise<DurableJobRecord> {
    return this.requestControl(jobId, "pause", projectRevision);
  }
  async requestAbort(jobId: string, projectRevision?: number): Promise<DurableJobRecord> {
    return this.requestControl(jobId, "abort", projectRevision);
  }
  finish(
    jobId: string,
    projectRevision: number,
    promotions?: StorageOutputPromotion[],
    canonicalTransition?: DurableCanonicalTerminalTransition
  ): Promise<DurableJobRecord> {
    return this.settle(jobId, "completed", projectRevision, undefined, promotions, canonicalTransition);
  }
  bindCanonicalTransition(jobId: string, transition: DurableCanonicalTerminalTransition): void {
    this.execution.bindCanonicalTransition(jobId, transition);
  }
  async settle(
    jobId: string,
    status: Extract<JobStatus, "paused" | "aborted" | "blocked" | "failed" | "completed">,
    projectRevision: number,
    reason?: string,
    promotions?: StorageOutputPromotion[],
    canonicalTransition?: DurableCanonicalTerminalTransition
  ): Promise<DurableJobRecord> {
    const outcome: DurableTerminalOutcome = {
      status,
      projectRevision,
      ...(reason ? { reason: publicTerminalReason(status, reason) } : {}),
      ...(promotions?.length ? { promotions } : {}),
      ...(canonicalTransition ? { canonicalTransition } : {})
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
  verifyToolPostcondition(input: { jobId: string; attemptId: string; projectRevision: number; verifiedAt: string }): Promise<StorageToolAttempt> {
    return this.trace.verifyToolPostcondition(input);
  }
  verifyCanonicalTerminal(input: Omit<StorageCanonicalTerminalVerifyInput, "fence">): Promise<StorageCanonicalTerminalVerifyResult> {
    const active = this.execution.require(input.owner.jobId);
    return this.client.request({ name: "canonical.verifyTerminal", input: { ...input, fence: active.fence } });
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
  saveCanonicalTaskContract(owner: CS.StorageRunOwnership, contract: CS.StorageTaskContractInput): Promise<CS.StorageTaskContract> {
    const active = this.execution.require(owner.jobId);
    return fencedCanonicalTaskContractWrite(this.client, active.fence, active.job.projectId, owner, contract);
  }
  getCanonicalTaskContract(projectId: string, contractId: string): Promise<CS.StorageTaskContract | undefined> {
    return this.client.request({ name: "taskContract.get", projectId, contractId });
  }
  latestCanonicalRunState(owner: CS.StorageRunOwnership): Promise<CS.StorageRunStateRevision | undefined> {
    return this.client.request({ name: "runState.latest", owner });
  }
  commitCanonicalRunState(input: CS.StorageCommitRunStateRevisionInput): Promise<CS.StorageRunStateRevision> {
    const active = this.execution.require(input.revision.jobId);
    return fencedCanonicalStorageWrite(this.client, active.fence, input.revision.jobId, { name: "runState.commit", input });
  }
  commitCanonicalRevisionPlan(owner: CS.StorageRunOwnership, preparePlan: () => Promise<CanonicalRevisionPlan>): Promise<RunStateRevision> {
    return commitDurableCanonicalRevisionPlan(this.client, () => this.execution.require(owner.jobId), owner, preparePlan);
  }
  async commitCanonicalBudget(owner: CS.StorageRunOwnership, preparePlan: (recordedAt: string) => Promise<CanonicalRevisionPlan>): Promise<void> {
    await commitDurableCanonicalBudget(this.client, () => this.execution.require(owner.jobId), owner, preparePlan, runtimeNow(this.config));
  }
  async commitCanonicalCheckpoint(input: DurableCanonicalCheckpointCommitInput): Promise<StorageCheckpoint> {
    const requireActive = () => this.execution.require(input.owner.jobId);
    requireActive();
    const completedStep = await this.trace.completedStep(input.owner.jobId, input.step);
    requireActive();
    const result = await commitDurableCanonicalCheckpoint(this.client, requireActive, input, runtimeNow(this.config), completedStep);
    this.trace.publishStoredEvent(result.step.event);
    return result.step.checkpoint;
  }
  saveCanonicalContextPack(input: CS.StorageSaveContextPackInput): Promise<CS.StorageContextPack> {
    const active = this.execution.require(input.contextPack.jobId);
    return fencedCanonicalStorageWrite(this.client, active.fence, input.contextPack.jobId, { name: "contextPack.save", input });
  }
  getCanonicalResumeContextPack(owner: CS.StorageRunOwnership, predecessorJobId: string, contextPackId: string): Promise<CS.StorageContextPack | undefined> {
    return this.client.request({ name: "contextPack.getResumeBound", owner, predecessorJobId, contextPackId });
  }
  listCanonicalToolAttempts(jobId: string, limit = 1_000): Promise<StorageToolAttempt[]> {
    return this.client.request({ name: "trace.attempt.listJob", jobId, limit });
  }
  listCanonicalLlmInvocations(jobId: string, limit = 1_000): Promise<StorageLlmInvocation[]> {
    return this.client.request({ name: "trace.llm.listJob", jobId, limit });
  }
  async recordCapabilityAudits(audits: StorageCapabilityAudit[], project?: StorageProjectPayload): Promise<void> {
    await recordDurableCapabilityAudits(this.client, audits, project);
  }
  async syncProject(project: StorageProjectPayload): Promise<void> {
    await syncDurableProject(this.client, project);
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
    return collectDurableOperationalDiagnostics({
      client: this.client,
      countersSince: this.diagnosticCountersSince,
      runtime: this.diagnostics.snapshot(),
      sse: this.sseDiagnostics.snapshot(),
      sampledAtMs,
      queueProjectLimit
    });
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
  private sweepExpiredLeases() {
    return sweepDurableExpiredLeases(this.client, runtimeNow(this.config), (events) => this.publishEvents(events));
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
    logDurableRuntimeFailure(error, { jobId, projectId, diagnosticId });
  }
}
