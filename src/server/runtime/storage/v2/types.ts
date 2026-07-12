import type {
  GlobalMemoryItem,
  NormalizedResearchRecord,
  OntologyConstraint,
  OntologyEntity,
  OntologyRelation,
  ResearchChunk,
  ResearchProject
} from "../../../../core/shared/types.js";

export type StorageJsonObject = Record<string, unknown>;

export interface StorageV2DatabasePaths {
  appDbPath: string;
  vectorDbPath?: string;
  ontologyDbPath?: string;
}

export interface StorageV2OpenOptions extends StorageV2DatabasePaths {
  requireFts5?: boolean;
}

export type StorageJobStatus =
  "queued" | "running" | "pause_requested" | "paused" | "cancel_requested" | "aborted" | "interrupted" | "blocked" | "failed" | "completed";

export const STORAGE_JOB_STATUSES = [
  "queued",
  "running",
  "pause_requested",
  "paused",
  "cancel_requested",
  "aborted",
  "interrupted",
  "blocked",
  "failed",
  "completed"
] as const satisfies readonly StorageJobStatus[];

export type StorageJobOperation = "research" | "chat" | "engineering" | (string & {});

export interface StorageCapabilitySet {
  agent: boolean;
  engineering: boolean;
  search: boolean;
}

export type StorageSourceAccessPolicy = { mode: "offline" } | { mode: "allowlist"; urls: string[] } | { mode: "discovery"; allowedDomains: string[] };

export interface StorageJobToolPolicy {
  allowCodexCli: boolean;
  sourceAccess: StorageSourceAccessPolicy;
}

export interface StorageJobInput {
  id: string;
  projectId: string;
  operation: StorageJobOperation;
  payload?: unknown;
  priority?: number;
  idempotencyKey?: string;
  requestHash?: string;
  requestedCapabilities?: StorageCapabilitySet;
  effectiveCapabilities?: StorageCapabilitySet;
  toolPolicy?: StorageJobToolPolicy;
  requestedBy?: string;
  createdAt?: string;
  queuedAt?: string;
}

export interface StorageJob {
  id: string;
  projectId: string;
  operation: string;
  status: StorageJobStatus;
  priority: number;
  attempt: number;
  payload: unknown;
  result?: unknown;
  error?: string;
  blockedReason?: string;
  failureReason?: string;
  idempotencyKey?: string;
  requestHash?: string;
  requestedCapabilities?: StorageCapabilitySet;
  effectiveCapabilities?: StorageCapabilitySet;
  toolPolicy?: StorageJobToolPolicy;
  requestedBy?: string;
  leaseOwner?: string;
  leaseExpiresAt?: string;
  queuedAt: string;
  startedAt?: string;
  completedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface StorageJobClaimOptions {
  projectId?: string;
  leaseOwner: string;
  leaseExpiresAt?: string;
  now?: string;
}

export interface StorageJobStatusPatch {
  status: StorageJobStatus;
  result?: unknown;
  error?: string;
  blockedReason?: string;
  failureReason?: string;
  leaseOwner?: string;
  leaseExpiresAt?: string;
  startedAt?: string;
  completedAt?: string;
  updatedAt?: string;
}

export interface StorageJobEventInput {
  eventId?: string;
  projectId: string;
  jobId?: string;
  type: string;
  payload?: unknown;
  createdAt?: string;
}

export interface StorageJobEvent {
  sequence: number;
  eventId: string;
  projectId: string;
  jobId?: string;
  type: string;
  payload: unknown;
  createdAt: string;
}

export type StorageCheckpointStatus = "pending" | "committed" | "quarantined" | "failed";

export interface StorageCheckpoint {
  id: string;
  projectId: string;
  jobId: string;
  attemptId?: string;
  step: string;
  checkpointKey: string;
  status: StorageCheckpointStatus;
  data?: unknown;
  outputRef?: string;
  error?: string;
  createdAt: string;
  committedAt?: string;
}

export type StorageStepAttemptStatus = "running" | "completed" | "failed" | "interrupted" | "quarantined";

export interface StorageStepAttempt {
  id: string;
  projectId: string;
  jobId: string;
  step: string;
  attemptIndex: number;
  status: StorageStepAttemptStatus;
  workerId?: string;
  checkpointId?: string;
  quarantineRef?: string;
  inputHash?: string;
  outputHash?: string;
  data?: unknown;
  error?: string;
  startedAt: string;
  completedAt?: string;
}

export type StorageCapabilityOperation = "agent" | "engineering" | "search";

export interface StorageCapabilityAudit {
  id: string;
  projectId: string;
  jobId?: string;
  operation: StorageCapabilityOperation;
  capability: string;
  appAllowed: boolean;
  projectAllowed: boolean;
  operationAllowed: boolean;
  allowed: boolean;
  reason?: string;
  data?: unknown;
  auditedAt: string;
}

export type StorageOntologyMode = "rule_based" | "llm" | "hybrid";
export type StorageOntologyRunStatus = "running" | "completed" | "failed";

export interface StorageOntologyRun {
  id: string;
  projectId: string;
  jobId?: string;
  mode: StorageOntologyMode;
  status: StorageOntologyRunStatus;
  entityCount: number;
  relationCount: number;
  constraintCount: number;
  data?: unknown;
  error?: string;
  startedAt: string;
  completedAt?: string;
}

export interface StorageEmbeddingInput {
  id: string;
  projectId: string;
  ownerTable: string;
  ownerId: string;
  vector: Float32Array | readonly number[];
  provider?: string;
  model?: string;
  scope?: string;
  createdAt?: string;
  updatedAt?: string;
  data?: unknown;
}

export interface StorageEmbedding {
  id: string;
  projectId: string;
  ownerTable: string;
  ownerId: string;
  vector: Float32Array;
  dimensions: number;
  provider?: string;
  model?: string;
  scope?: string;
  createdAt: string;
  updatedAt: string;
  data?: unknown;
}

export interface StorageSearchOptions {
  projectId?: string;
  limit?: number;
  includeGlobal?: boolean;
}

export interface StorageSearchResult<T> {
  item: T;
  score: number;
}

export type StorageProjectPayload = ResearchProject | StorageJsonObject;
export type StorageRecordPayload = NormalizedResearchRecord;
export type StorageMemoryPayload = GlobalMemoryItem | ResearchChunk;
export type StorageOntologyEntityPayload = OntologyEntity;
export type StorageOntologyRelationPayload = OntologyRelation;
export type StorageOntologyConstraintPayload = OntologyConstraint;
