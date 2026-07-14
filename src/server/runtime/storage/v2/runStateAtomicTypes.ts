import type { StorageTerminalTransitionInput, StorageTerminalTransitionResult } from "./jobAtomicTypes.js";
import type { StorageLeaseFence, StorageStepDispositionInput, StorageStepDispositionResult } from "./types.js";
import type { StorageCommitRunStateRevisionInput, StorageRunOwnership, StorageRunStateRevision } from "./runStateTypes.js";

export interface StorageCanonicalFinalState {
  revision: number;
  stateHash: string;
}

export interface StorageCanonicalStepCommitInput {
  step: StorageStepDispositionInput;
  owner: StorageRunOwnership;
  finalState: StorageCanonicalFinalState;
  exactReplay: boolean;
  revisions: readonly StorageCommitRunStateRevisionInput[];
}

export interface StorageCanonicalStepCommitResult {
  step: StorageStepDispositionResult;
  revisions: StorageRunStateRevision[];
}

export interface StorageCanonicalRevisionPlanInput {
  fence: StorageLeaseFence;
  occurredAt?: string;
  owner: StorageRunOwnership;
  finalState: StorageCanonicalFinalState;
  exactReplay: boolean;
  revisions: readonly StorageCommitRunStateRevisionInput[];
}

export interface StorageCanonicalRevisionPlanResult {
  revisions: StorageRunStateRevision[];
  finalRevision: StorageRunStateRevision;
}

export interface StorageCanonicalBudgetCommitInput extends StorageCanonicalRevisionPlanInput {
  receiptHash: string;
  targetUsage: {
    durationMs: number;
    inputTokens: number;
    outputTokens: number;
    toolCalls: number;
    retries: number;
    estimatedCostMicrousd: number;
    toolOutputBytes: number;
  };
}

export interface StorageCanonicalBudgetPrefix {
  revisionCount: number;
  finalState: StorageCanonicalFinalState;
  receiptHash: string;
  targetUsage: StorageCanonicalBudgetCommitInput["targetUsage"];
}

export interface StorageCanonicalTerminalTransitionInput {
  terminal: StorageTerminalTransitionInput;
  owner: StorageRunOwnership;
  finalState: StorageCanonicalFinalState;
  exactReplay: boolean;
  revisions: readonly StorageCommitRunStateRevisionInput[];
  budgetPrefix: StorageCanonicalBudgetPrefix;
}

export interface StorageCanonicalTerminalTransitionResult {
  terminal: StorageTerminalTransitionResult;
  revisions: StorageRunStateRevision[];
}
