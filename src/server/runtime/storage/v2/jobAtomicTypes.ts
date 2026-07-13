import type { StorageToolOutputLink } from "./traceTypes.js";
import type {
  StorageCompletedStepInput,
  StorageJob,
  StorageJobEvent,
  StorageLeaseFence,
  StorageSettledJobStatus,
  StorageStepDispositionResult
} from "./types.js";

export interface StorageEnqueueJobResult {
  job: StorageJob;
  event?: StorageJobEvent;
}

export interface StorageOutputPromotion {
  link: StorageToolOutputLink;
  artifact?: { name: string; kind: string };
}

export interface StorageTerminalTransitionInput {
  fence: StorageLeaseFence;
  status: StorageSettledJobStatus;
  projectRevision: number;
  reason?: string;
  occurredAt?: string;
  promotions?: StorageOutputPromotion[];
  completedStep?: StorageCompletedStepInput;
}

export interface StorageTerminalTransitionResult {
  job: StorageJob;
  event: StorageJobEvent;
  events: StorageJobEvent[];
  links: StorageToolOutputLink[];
  stepDisposition?: StorageStepDispositionResult;
}

export interface StorageJobControlInput {
  jobId: string;
  control: "pause" | "cancel";
  projectRevision: number;
  occurredAt?: string;
}

export interface StorageJobControlResult {
  job: StorageJob;
  event: StorageJobEvent;
}

export interface StorageExpiredLeaseSweepResult {
  jobs: StorageJob[];
  events: StorageJobEvent[];
  projectIds: string[];
}
