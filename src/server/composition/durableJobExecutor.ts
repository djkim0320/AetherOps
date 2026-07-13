import type { JobKind, JobStatus } from "../../contracts/api-v2/jobs.js";
import type { StorageWorkerClient } from "../runtime/storage/worker/typedRuntime.js";
import type { StorageTerminalTransitionResult } from "../runtime/storage/v2/jobAtomicTypes.js";
import type { StorageClaimStartResult, StorageJob, StorageJobEvent, StorageStepDispositionResult } from "../runtime/storage/v2/types.js";
import { durableFailureFrom } from "./durableFailure.js";
import { DurableJobExecutionContext, type DurableJobExecutionScope, type DurableTerminalOutcome } from "./durableJobExecutionContext.js";
import { toDurableJobRecord } from "./durableJobMappers.js";
import { DurableJobTraceRuntime } from "./durableJobTraceRuntime.js";
import type { DurableJobControl, DurableJobHandler } from "./durableJobTypes.js";
import { startDurableLeaseRenewal } from "./durableLeaseRenewal.js";
import { runtimeNow, type ResolvedDurableRuntimeConfig } from "./durableRuntimeConfig.js";
import { DurableRuntimeDiagnostics } from "./durableRuntimeDiagnostics.js";

interface DurableJobExecutorDependencies {
  client: StorageWorkerClient;
  config: ResolvedDurableRuntimeConfig;
  trace: DurableJobTraceRuntime;
  execution: DurableJobExecutionContext;
  handlers: Map<JobKind, DurableJobHandler>;
  diagnostics: DurableRuntimeDiagnostics;
  canWrite(): boolean;
  logFailure(error: unknown, jobId?: string, projectId?: string, diagnosticId?: string): void;
}

export class DurableJobExecutor {
  private readonly scopes = new Map<string, DurableJobExecutionScope>();
  private readonly controllers = new Map<string, AbortController>();
  private readonly requestedControls = new Map<string, DurableJobControl>();

  constructor(private readonly dependencies: DurableJobExecutorDependencies) {}

  activeCount(): number {
    return this.scopes.size;
  }

  interrupt(jobId: string, control: DurableJobControl): void {
    this.requestedControls.set(jobId, control);
    this.controllers.get(jobId)?.abort(new Error(`Durable job ${control} requested.`));
  }

  interruptAll(): void {
    for (const [jobId] of this.controllers) this.interrupt(jobId, "abort");
  }

  async run(claimed: StorageClaimStartResult): Promise<void> {
    const job = toDurableJobRecord(claimed.job);
    const controller = new AbortController();
    const scope: DurableJobExecutionScope = { job, fence: claimed.fence, controller };
    this.scopes.set(job.id, scope);
    this.controllers.set(job.id, controller);
    this.dependencies.diagnostics.setActiveJobs(this.scopes.size);
    const renewal = startDurableLeaseRenewal({
      intervalMs: this.dependencies.config.leaseRenewalMs,
      timer: this.dependencies.config.timer,
      renew: () => this.renewLease(scope),
      onFailure: (error) => this.handleLeaseLoss(scope, error, "renewal")
    });
    let renewalStopFailure: unknown;
    try {
      await this.dependencies.execution.run(scope, async () => {
        const handler = this.dependencies.handlers.get(job.kind);
        if (!handler) throw new Error(`No durable handler is registered for ${job.kind}.`);
        await handler(job, requestPayload(claimed.job), {
          signal: controller.signal,
          requestedControl: () => this.requestedControls.get(job.id)
        });
        this.applyRequestedControl(scope);
        if (!scope.outcome) throw new Error(`Durable handler ${job.kind} returned without a terminal outcome.`);
        await this.persistOutcome(scope, scope.outcome);
      });
    } catch (error) {
      await this.handleExecutionFailure(scope, error);
    } finally {
      try {
        await renewal.stop();
      } catch (error) {
        renewalStopFailure = error;
      }
      this.controllers.delete(job.id);
      this.scopes.delete(job.id);
      this.requestedControls.delete(job.id);
      this.dependencies.diagnostics.setActiveJobs(this.scopes.size);
    }
    if (renewalStopFailure !== undefined) throw renewalStopFailure;
  }

  async revokeLingeringLeases(): Promise<void> {
    for (const scope of this.scopes.values()) {
      const leaseWasAlreadyLost = Boolean(scope.leaseLost);
      scope.leaseLost = true;
      scope.controller.abort(new Error("Durable runtime shutdown grace expired."));
      try {
        const result = await this.dependencies.client.request<StorageTerminalTransitionResult>({
          name: "job.transitionTerminal",
          input: {
            fence: scope.fence,
            status: "interrupted",
            projectRevision: scope.job.projectRevision,
            reason: "서버 종료로 작업이 중단되었습니다.",
            occurredAt: runtimeNow(this.dependencies.config)
          }
        });
        this.publishEvents(result.events);
      } catch (error) {
        if (isLeaseLost(error)) {
          this.dependencies.diagnostics.recordStaleWriteRejection();
          if (!leaseWasAlreadyLost) this.dependencies.diagnostics.recordLeaseLost();
        } else this.dependencies.logFailure(error, scope.job.id, scope.job.projectId);
      }
    }
  }

  async interruptClaimedBeforeExecution(claimed: StorageClaimStartResult): Promise<void> {
    try {
      const result = await this.dependencies.client.request<StorageTerminalTransitionResult>({
        name: "job.transitionTerminal",
        input: {
          fence: claimed.fence,
          status: "interrupted",
          projectRevision: toDurableJobRecord(claimed.job).projectRevision,
          reason: "서버 종료로 작업이 시작되기 전에 중단되었습니다.",
          occurredAt: runtimeNow(this.dependencies.config)
        }
      });
      this.publishEvents(result.events);
    } catch (error) {
      if (isLeaseLost(error)) {
        this.dependencies.diagnostics.recordStaleWriteRejection();
        this.dependencies.diagnostics.recordLeaseLost();
      } else this.dependencies.logFailure(error, claimed.job.id, claimed.job.projectId);
    }
  }

  private async persistOutcome(scope: DurableJobExecutionScope, outcome: DurableTerminalOutcome): Promise<void> {
    if (scope.leaseLost) throw leaseLostError(scope.job.id);
    const completedStep =
      scope.job.currentStep && outcome.status === "completed" ? await this.dependencies.trace.completedStep(scope.job.id, scope.job.currentStep) : undefined;
    if (scope.job.currentStep) {
      if (outcome.status !== "completed") {
        await this.quarantineStep(scope, outcome.projectRevision, outcome.reason ?? terminalMessage(outcome.status));
      }
    }
    const result = await this.dependencies.client.request<StorageTerminalTransitionResult>({
      name: "job.transitionTerminal",
      input: {
        fence: scope.fence,
        status: outcome.status,
        projectRevision: outcome.projectRevision,
        reason: outcome.reason,
        occurredAt: runtimeNow(this.dependencies.config),
        promotions: outcome.promotions,
        completedStep
      }
    });
    this.publishEvents(result.events);
  }

  private async handleExecutionFailure(scope: DurableJobExecutionScope, error: unknown): Promise<void> {
    if (scope.leaseLost || isLeaseLost(error)) {
      this.handleLeaseLoss(scope, error);
      return;
    }
    if (!this.dependencies.canWrite()) return;
    const control = this.requestedControls.get(scope.job.id);
    const failure = durableFailureFrom(error);
    this.dependencies.logFailure(error, scope.job.id, scope.job.projectId, failure.internalDiagnosticId);
    const outcome: DurableTerminalOutcome = control
      ? { status: control === "pause" ? "paused" : "aborted", projectRevision: scope.job.projectRevision, reason: terminalMessage(control) }
      : { status: "failed", projectRevision: scope.job.projectRevision, reason: failure.publicMessage };
    try {
      await this.persistOutcome(scope, outcome);
    } catch (settleError) {
      if (isLeaseLost(settleError)) this.handleLeaseLoss(scope, settleError);
      else this.dependencies.logFailure(settleError, scope.job.id, scope.job.projectId);
    }
  }

  private async quarantineStep(scope: DurableJobExecutionScope, projectRevision: number, error: string): Promise<void> {
    const result = await this.dependencies.client.request<StorageStepDispositionResult>({
      name: "job.quarantineStep",
      input: {
        fence: scope.fence,
        step: scope.job.currentStep as string,
        projectRevision,
        error,
        occurredAt: runtimeNow(this.dependencies.config)
      }
    });
    this.dependencies.trace.publishStoredEvent(result.event);
  }

  private async renewLease(scope: DurableJobExecutionScope): Promise<void> {
    const job = await this.dependencies.client.request<StorageJob>({
      name: "job.renewLease",
      fence: scope.fence,
      leaseExpiresAt: new Date(this.dependencies.config.clock.now() + this.dependencies.config.leaseTtlMs).toISOString(),
      now: runtimeNow(this.dependencies.config)
    });
    this.dependencies.diagnostics.recordRenewal(true);
    if (job.status === "pause_requested") this.interrupt(job.id, "pause");
    if (job.status === "cancel_requested") this.interrupt(job.id, "abort");
  }

  private handleLeaseLoss(scope: DurableJobExecutionScope, error: unknown, source: "renewal" | "write" = "write"): void {
    if (!scope.leaseLost) {
      if (source === "renewal") this.dependencies.diagnostics.recordRenewal(false);
      else this.dependencies.diagnostics.recordStaleWriteRejection();
      this.dependencies.diagnostics.recordLeaseLost();
    }
    scope.leaseLost = true;
    scope.controller.abort(error);
    this.dependencies.logFailure(error, scope.job.id, scope.job.projectId);
  }

  private applyRequestedControl(scope: DurableJobExecutionScope): void {
    const control = this.requestedControls.get(scope.job.id);
    if (!control || scope.outcome) return;
    scope.outcome = {
      status: control === "pause" ? "paused" : "aborted",
      projectRevision: scope.job.projectRevision,
      reason: terminalMessage(control)
    };
  }

  private publishEvents(events: StorageJobEvent[]): void {
    const seen = new Set<number>();
    for (const event of events) {
      if (seen.has(event.sequence)) continue;
      seen.add(event.sequence);
      this.dependencies.trace.publishStoredEvent(event);
    }
  }
}

export function publicTerminalReason(status: JobStatus, untrustedReason: string): string {
  void untrustedReason;
  if (status === "blocked") return terminalMessage("blocked");
  if (status === "paused") return terminalMessage("paused");
  if (status === "aborted") return terminalMessage("aborted");
  if (status === "interrupted") return terminalMessage("interrupted");
  return terminalMessage("failed");
}

function requestPayload(job: StorageJob): unknown {
  const payload = job.payload && typeof job.payload === "object" ? (job.payload as Record<string, unknown>) : {};
  return payload.request;
}

function terminalMessage(status: JobStatus | DurableJobControl): string {
  if (status === "pause" || status === "paused") return "사용자 요청으로 작업을 일시정지했습니다.";
  if (status === "abort" || status === "aborted") return "사용자 요청으로 작업을 중단했습니다.";
  if (status === "blocked") return "작업 실행에 필요한 기능이 준비되지 않았습니다.";
  if (status === "interrupted") return "작업 실행이 중단되었습니다.";
  return "작업 실행 중 내부 오류가 발생했습니다.";
}

function isLeaseLost(error: unknown): boolean {
  return error instanceof Error && error.name === "LeaseLostError";
}

function leaseLostError(jobId: string): Error {
  const error = new Error(`Lease was lost for durable job ${jobId}.`);
  error.name = "LeaseLostError";
  return error;
}
