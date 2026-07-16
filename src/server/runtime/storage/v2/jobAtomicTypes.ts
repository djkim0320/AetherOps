import type { StorageToolAttempt, StorageToolOutputLink } from "./traceTypes.js";
import type { StorageEngineeringResultPromotion } from "./engineeringBaselineTypes.js";
import type { StorageTerminalCasObject } from "./terminalCasStore.js";
import type {
  StorageCompletedStepInput,
  StorageCapabilityAudit,
  StorageJob,
  StorageJobEvent,
  StorageLeaseFence,
  StorageSettledJobStatus,
  StorageStepDispositionResult
} from "./types.js";

export interface StorageEnqueueJobResult {
  job: StorageJob;
  event?: StorageJobEvent;
  capabilityAudits: StorageCapabilityAudit[];
}

export interface StorageOutputPromotion {
  link: StorageToolOutputLink;
  artifact?: { name: string; kind: string };
  engineering?: StorageEngineeringResultPromotion;
  pendingCasObject?: StorageTerminalCasObject;
}

export interface StorageTerminalQuarantinedStepInput {
  step: string;
  checkpointData?: unknown;
  outputRef?: string;
  outputHash?: string;
  quarantineRef?: string;
  error: string;
}

export interface StorageTerminalTransitionInput {
  fence: StorageLeaseFence;
  status: StorageSettledJobStatus;
  projectRevision: number;
  reason?: string;
  occurredAt?: string;
  promotions?: StorageOutputPromotion[];
  completedStep?: StorageCompletedStepInput;
  quarantinedStep?: StorageTerminalQuarantinedStepInput;
  snapshotChange?: StorageProjectSnapshotChange;
}

export interface StorageProjectSnapshotChange {
  snapshotVersion: number;
  reason: "project_updated" | "job_changed" | "resync_required";
}

export interface StoragePostCommitReconciliationWarning {
  code: "ENGINEERING_CAS_FINALIZE_DEFERRED" | "ENGINEERING_CAS_INTEGRITY_RECONCILIATION_REQUIRED" | "ENGINEERING_CAS_ABORT_DEFERRED";
  operation: "engineering_cas_finalize" | "engineering_cas_integrity" | "engineering_cas_abort";
  severity: "warning" | "error";
  message: string;
  affectedObjectCount: number;
}

export interface StorageTerminalTransitionResult {
  job: StorageJob;
  event: StorageJobEvent;
  events: StorageJobEvent[];
  links: StorageToolOutputLink[];
  stepDisposition?: StorageStepDispositionResult;
  postCommitWarnings?: StoragePostCommitReconciliationWarning[];
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

export interface StorageToolPostconditionVerifyInput {
  fence: StorageLeaseFence;
  attemptId: string;
  projectRevision: number;
  verifiedAt: string;
}

export interface StorageToolPostconditionVerifyResult {
  attempt: StorageToolAttempt;
  event?: StorageJobEvent;
}
