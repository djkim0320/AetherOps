import { AsyncLocalStorage } from "node:async_hooks";
import type { JobStatus } from "../../contracts/api-v2/jobs.js";
import type { StorageLeaseFence } from "../runtime/storage/v2/types.js";
import type { StorageOutputPromotion } from "../runtime/storage/v2/jobAtomicTypes.js";
import type { DurableJobRecord } from "./durableJobTypes.js";

export type DurableTerminalStatus = Extract<JobStatus, "paused" | "aborted" | "interrupted" | "blocked" | "failed" | "completed">;

export interface DurableTerminalOutcome {
  status: DurableTerminalStatus;
  projectRevision: number;
  reason?: string;
  promotions?: StorageOutputPromotion[];
}

export interface DurableJobExecutionScope {
  job: DurableJobRecord;
  fence: StorageLeaseFence;
  controller: AbortController;
  outcome?: DurableTerminalOutcome;
  leaseLost?: boolean;
}

export class DurableJobExecutionContext {
  private readonly storage = new AsyncLocalStorage<DurableJobExecutionScope>();

  run<T>(scope: DurableJobExecutionScope, callback: () => Promise<T>): Promise<T> {
    return this.storage.run(scope, callback);
  }

  current(jobId?: string): DurableJobExecutionScope | undefined {
    const scope = this.storage.getStore();
    return !jobId || scope?.job.id === jobId ? scope : undefined;
  }

  require(jobId: string): DurableJobExecutionScope {
    const scope = this.current(jobId);
    if (!scope) throw new Error(`Durable write for ${jobId} is outside its leased execution context.`);
    if (scope.leaseLost) throw leaseLostError(jobId);
    return scope;
  }

  settle(jobId: string, outcome: DurableTerminalOutcome): DurableJobRecord {
    const scope = this.require(jobId);
    if (scope.outcome && !sameOutcome(scope.outcome, outcome)) throw new Error(`Durable job ${jobId} already has a different terminal outcome.`);
    scope.outcome = outcome;
    return {
      ...scope.job,
      status: outcome.status,
      projectRevision: outcome.projectRevision,
      ...(outcome.status === "blocked" && outcome.reason ? { blockedReason: outcome.reason } : {}),
      ...(outcome.status === "failed" && outcome.reason ? { failureReason: outcome.reason } : {})
    };
  }

  markLeaseLost(jobId: string, reason: unknown): void {
    const scope = this.current(jobId);
    if (!scope || scope.leaseLost) return;
    scope.leaseLost = true;
    scope.controller.abort(reason);
  }
}

function sameOutcome(left: DurableTerminalOutcome, right: DurableTerminalOutcome): boolean {
  return (
    left.status === right.status &&
    left.projectRevision === right.projectRevision &&
    left.reason === right.reason &&
    JSON.stringify(left.promotions ?? []) === JSON.stringify(right.promotions ?? [])
  );
}

function leaseLostError(jobId: string): Error {
  const error = new Error(`Lease was lost for durable job ${jobId}.`);
  error.name = "LeaseLostError";
  return error;
}
