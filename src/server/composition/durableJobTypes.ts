import type { JobKind, JobStatus } from "../../contracts/api-v2/jobs.js";
import type { ResearchProject } from "../../core/shared/types.js";
import type { ResearchLoopStep } from "../../shared/kernel/researchLoop.js";
import type { StorageCapabilityAudit, StorageCapabilitySet, StorageJobToolPolicy } from "../runtime/storage/v2/types.js";
import type {
  StorageCodexCliExecution,
  StorageLlmInvocation,
  StorageNetworkAudit,
  StorageToolAttempt,
  StorageToolDecision,
  StorageToolOutputLink
} from "../runtime/storage/v2/traceTypes.js";
import type { StorageTraceCategory, StorageTraceSummary } from "../runtime/storage/v2/traceTypes.js";
import type { StorageEngineeringResultPromotion } from "../runtime/storage/v2/engineeringBaselineTypes.js";

export const DURABLE_TRACE_PREVIEW_LIMIT = 20;
export const DURABLE_TRACE_MAX_RECORDS = 300;
export const DURABLE_TRACE_MAX_SERIALIZED_BYTES = 2_097_152;

export interface DurableTracePageRequest {
  category: StorageTraceCategory;
  cursor?: string;
  limit?: number;
}

export interface DurableTracePageMetadata {
  order: "newest_first";
  total: number;
  returned: number;
  truncated: boolean;
  nextCursor?: string;
}

export type DurableTracePages = Record<StorageTraceCategory, DurableTracePageMetadata>;
export type DurableTraceContinuationCursors = Record<StorageTraceCategory, string[]>;

export interface DurableTraceBudget {
  maxRecords: 300;
  maxSerializedBytes: 2_097_152;
  returned: number;
  total: number;
  truncated: boolean;
}

export interface DurableJobRecord {
  id: string;
  projectId: string;
  kind: JobKind;
  status: JobStatus;
  projectRevision: number;
  currentStep?: ResearchLoopStep;
  idempotencyKey: string;
  requestHash?: string;
  requestedCapabilities?: StorageCapabilitySet;
  effectiveCapabilities?: StorageCapabilitySet;
  toolPolicy?: StorageJobToolPolicy;
  engineeringBaseline?: DurableEngineeringBaselineBinding | null;
  resumesJobId?: string;
  resumeCheckpointId?: string;
  canonicalInitializationAnchor?: unknown;
  blockedReason?: string;
  failureReason?: string;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  finishedAt?: string;
  leaseExpiresAt?: string;
}

export interface DurableEngineeringBaselineBinding {
  id: string;
  revision: number;
  contentHash: string;
}

export interface DurableJobReceipt {
  jobId: string;
  projectId: string;
  kind: JobKind;
  status: JobStatus;
  queuePosition?: number;
  acceptedAt: string;
  projectRevision: number;
}

export interface DurableJobDetail extends DurableJobRecord {
  traceAvailability: "available" | "legacy_unavailable";
  traceSummary: StorageTraceSummary;
  tracePages: DurableTracePages;
  traceContinuationCursors?: DurableTraceContinuationCursors;
  traceBudget: DurableTraceBudget;
  engineeringPromotions: StorageEngineeringResultPromotion[];
  trace: {
    llmInvocations: StorageLlmInvocation[];
    toolDecisions: StorageToolDecision[];
    toolAttempts: StorageToolAttempt[];
    codexCliExecutions: StorageCodexCliExecution[];
    outputs: StorageToolOutputLink[];
    networkAudits: StorageNetworkAudit[];
  };
}

export interface EnqueueDurableJob {
  /** Client-selected before authorization audits are bound to the immutable enqueue transaction. */
  jobId?: string;
  projectId: string;
  /** Verified legacy snapshot projection persisted atomically with a new job. */
  project?: ResearchProject;
  kind: JobKind;
  projectRevision: number;
  currentStep?: ResearchLoopStep;
  idempotencyKey: string;
  requestHash?: string;
  requestedCapabilities?: StorageCapabilitySet;
  effectiveCapabilities?: StorageCapabilitySet;
  capabilityAudits?: StorageCapabilityAudit[];
  toolPolicy?: StorageJobToolPolicy;
  resumesJobId?: string;
  resumeCheckpointId?: string;
  payload?: unknown;
}

export type DurableJobControl = "pause" | "abort";

export interface DurableJobHandlerContext {
  signal: AbortSignal;
  requestedControl(): DurableJobControl | undefined;
}

export type DurableJobHandler = (job: DurableJobRecord, request: unknown, context: DurableJobHandlerContext) => Promise<void>;
