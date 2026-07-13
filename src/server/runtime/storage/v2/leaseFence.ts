import type { StorageJob, StorageLeaseFence } from "./types.js";

export class LeaseLostError extends Error {
  readonly code = "LEASE_LOST" as const;

  constructor(jobId: string) {
    super(`The durable lease is no longer held for job ${jobId}.`);
    this.name = "LeaseLostError";
  }
}

export class InvalidJobTransitionError extends Error {
  readonly code = "INVALID_JOB_TRANSITION" as const;

  constructor(jobId: string, from: StorageJob["status"], to: StorageJob["status"]) {
    super(`Invalid durable job transition for ${jobId}: ${from} -> ${to}.`);
    this.name = "InvalidJobTransitionError";
  }
}

export function storageLeaseFence(job: StorageJob): StorageLeaseFence {
  if (!job.leaseOwner) throw new LeaseLostError(job.id);
  return {
    jobId: job.id,
    attempt: job.attempt,
    leaseOwner: job.leaseOwner,
    leaseGeneration: job.leaseGeneration
  };
}
