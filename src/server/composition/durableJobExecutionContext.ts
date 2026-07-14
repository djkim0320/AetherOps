import { AsyncLocalStorage } from "node:async_hooks";
import type { JobStatus } from "../../contracts/api-v2/jobs.js";
import type { StorageLeaseFence } from "../runtime/storage/v2/types.js";
import type { StorageOutputPromotion } from "../runtime/storage/v2/jobAtomicTypes.js";
import type { DurableJobRecord } from "./durableJobTypes.js";
import type { DurableCanonicalTerminalTransition } from "./durableCanonicalTerminalTransition.js";

export type DurableTerminalStatus = Extract<JobStatus, "paused" | "aborted" | "interrupted" | "blocked" | "failed" | "completed">;

export interface DurableTerminalOutcome {
  status: DurableTerminalStatus;
  projectRevision: number;
  reason?: string;
  promotions?: StorageOutputPromotion[];
  canonicalTransition?: DurableCanonicalTerminalTransition;
}

export interface DurableJobExecutionScope {
  job: DurableJobRecord;
  fence: StorageLeaseFence;
  controller: AbortController;
  outcome?: DurableTerminalOutcome;
  canonicalTransition?: DurableCanonicalTerminalTransition;
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
    const resolved = outcome.canonicalTransition || !scope.canonicalTransition ? outcome : { ...outcome, canonicalTransition: scope.canonicalTransition };
    if (scope.outcome && !sameOutcome(scope.outcome, resolved)) throw new Error(`Durable job ${jobId} already has a different terminal outcome.`);
    scope.outcome = resolved;
    return {
      ...scope.job,
      status: outcome.status,
      projectRevision: outcome.projectRevision,
      ...(outcome.status === "blocked" && outcome.reason ? { blockedReason: outcome.reason } : {}),
      ...(outcome.status === "failed" && outcome.reason ? { failureReason: outcome.reason } : {})
    };
  }

  bindCanonicalTransition(jobId: string, transition: DurableCanonicalTerminalTransition): void {
    const scope = this.require(jobId);
    if (scope.canonicalTransition && scope.canonicalTransition !== transition) {
      throw new Error(`Durable job ${jobId} already has a different canonical terminal transition.`);
    }
    scope.canonicalTransition = transition;
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
    left.canonicalTransition === right.canonicalTransition &&
    JSON.stringify(left.promotions ?? []) === JSON.stringify(right.promotions ?? [])
  );
}

function leaseLostError(jobId: string): Error {
  const error = new Error(`Lease was lost for durable job ${jobId}.`);
  error.name = "LeaseLostError";
  return error;
}
