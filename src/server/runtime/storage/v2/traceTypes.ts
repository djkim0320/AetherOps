import type { StorageJsonObject } from "./types.js";

export type StorageTraceData = StorageJsonObject | unknown[];
export type StorageLlmInvocationStatus = "running" | "completed" | "failed";

export interface StorageLlmInvocationData extends StorageJsonObject {
  provider: string;
  schemaName: string;
  accounting?: {
    version: 1;
    inputUnits: number;
    outputUnits: number;
    unit: "estimated_token";
    estimator: "utf8_bytes_div_4_ceil_v1";
    monetaryCost: { availability: "unavailable"; policy: "unmetered_codex_oauth_v1" };
  };
  validationErrors?: string[];
  contextPackId?: string;
  canonicalHash?: string;
  finalInputHash?: string;
}

export interface StorageLlmInvocation {
  id: string;
  projectId: string;
  jobId: string;
  model: string;
  reasoningEffort: string;
  promptVersion: string;
  schemaVersion: string;
  promptHash: string;
  responseHash?: string;
  latencyMs?: number;
  repairCount: number;
  status: StorageLlmInvocationStatus;
  error?: string;
  startedAt: string;
  completedAt?: string;
  data?: StorageLlmInvocationData;
}

export type StorageToolDecisionPolicyStatus = "accepted" | "rejected";

export interface StorageToolDecision {
  id: string;
  projectId: string;
  jobId: string;
  invocationId?: string;
  toolName: string;
  purpose: string;
  expectedOutcome: string;
  rawSelection: unknown;
  userPinned: boolean;
  policyStatus: StorageToolDecisionPolicyStatus;
  policyReason?: string;
  compiledAction?: unknown;
  createdAt: string;
  data?: StorageTraceData;
}

export type StorageToolAttemptStatus = "queued" | "running" | "completed" | "blocked" | "failed" | "interrupted" | "quarantined";
export type StorageToolAttemptTraceAvailability = "vnext" | "legacy_unavailable";
export type StorageToolSideEffect = "network" | "filesystem" | "process";
export type StorageToolPostconditionDisposition = "applied" | "not_applied";

export interface StorageToolPostconditionReceipt {
  receiptId: string;
  evidenceHash: string;
  receiptHash: string;
  verifier: string;
  verifiedAt: string;
}

export interface StorageToolAttempt {
  id: string;
  projectId: string;
  jobId: string;
  decisionId: string;
  checkpointId?: string;
  ordinal: number;
  status: StorageToolAttemptStatus;
  inputHash: string;
  outputHash?: string;
  traceVersion?: 1;
  traceAvailability?: StorageToolAttemptTraceAvailability;
  descriptorVersion?: string;
  descriptorSideEffects?: StorageToolSideEffect[];
  sideEffectKey?: string;
  idempotencyKey?: string;
  postconditionDisposition?: StorageToolPostconditionDisposition;
  postconditionReceipt?: StorageToolPostconditionReceipt;
  terminalCause?: string;
  dependsOnAttemptIds: string[];
  stagingRef?: string;
  quarantineRef?: string;
  error?: string;
  queuedAt: string;
  startedAt?: string;
  completedAt?: string;
  data?: StorageTraceData;
}

export interface StorageCodexCliExecution {
  id: string;
  projectId: string;
  jobId: string;
  attemptId: string;
  model: string;
  reasoningEffort: string;
  sandboxProfile: string;
  networkPolicy: "disabled";
  durationMs?: number;
  exitCode?: number;
  terminationReason?: string;
  eventCount: number;
  workspaceManifestHash?: string;
  outputManifestHash?: string;
  createdAt: string;
  completedAt?: string;
  data?: StorageTraceData;
}

export type StorageToolOutputKind = "source" | "evidence" | "artifact";

export interface StorageToolOutputLink {
  id: string;
  projectId: string;
  jobId: string;
  attemptId: string;
  outputKind: StorageToolOutputKind;
  outputId: string;
  promoted: boolean;
  createdAt: string;
  promotedAt?: string;
  data?: StorageTraceData;
}

export type StorageNetworkPolicyDecision = "allowed" | "denied";

export interface StorageNetworkAudit {
  id: string;
  projectId: string;
  jobId: string;
  attemptId?: string;
  url: string;
  redirectChain: string[];
  sourcePolicy: unknown;
  policyDecision: StorageNetworkPolicyDecision;
  reason?: string;
  auditedAt: string;
  data?: StorageTraceData;
}

export const STORAGE_TRACE_CATEGORIES = ["llmInvocations", "toolDecisions", "toolAttempts", "codexCliExecutions", "outputs", "networkAudits"] as const;

export type StorageTraceCategory = (typeof STORAGE_TRACE_CATEGORIES)[number];

export interface StorageTraceItemByCategory {
  llmInvocations: StorageLlmInvocation;
  toolDecisions: StorageToolDecision;
  toolAttempts: StorageToolAttempt;
  codexCliExecutions: StorageCodexCliExecution;
  outputs: StorageToolOutputLink;
  networkAudits: StorageNetworkAudit;
}

export type StorageTraceCategoryCounts = Record<StorageTraceCategory, number>;

export interface StorageTraceSummary {
  jobId: string;
  counts: StorageTraceCategoryCounts;
  total: number;
}

export interface StorageTracePage<C extends StorageTraceCategory = StorageTraceCategory> {
  category: C;
  order: "newest_first";
  items: Array<StorageTraceItemByCategory[C]>;
  /** Internal opaque cursor after each item, used for byte-budget page trimming. */
  itemCursors: string[];
  total: number;
  nextCursor?: string;
  truncated: boolean;
}
