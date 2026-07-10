import type { JobKind, JobStatus } from "../../contracts/api-v2/jobs.js";
import type { ResearchLoopStep } from "../../shared/kernel/researchLoop.js";

export interface DurableJobRecord {
  id: string;
  projectId: string;
  kind: JobKind;
  status: JobStatus;
  projectRevision: number;
  currentStep?: ResearchLoopStep;
  idempotencyKey: string;
  resumesJobId?: string;
  resumeCheckpointId?: string;
  blockedReason?: string;
  failureReason?: string;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  finishedAt?: string;
}

export interface DurableJobReceipt {
  jobId: string;
  projectId: string;
  kind: JobKind;
  status: "queued";
  queuePosition: number;
  acceptedAt: string;
  projectRevision: number;
}

export interface EnqueueDurableJob {
  projectId: string;
  kind: JobKind;
  projectRevision: number;
  currentStep?: ResearchLoopStep;
  idempotencyKey: string;
  resumesJobId?: string;
  resumeCheckpointId?: string;
  payload?: unknown;
}

export type DurableJobHandler = (job: DurableJobRecord, request: unknown) => Promise<void>;
