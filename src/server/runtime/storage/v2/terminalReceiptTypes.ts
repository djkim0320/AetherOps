import type { StorageCompletedStepInput, StorageLeaseFence } from "./types.js";
import type { StorageRunOwnership } from "./runStateTypes.js";
import type { StorageTerminalResultAttestation } from "./terminalAttestationTypes.js";

export const CANONICAL_TRACEABILITY_CRITERION = "Every promoted result is traceable to verified evidence and a terminal completion receipt.";
export const CANONICAL_POLICY_CRITERION = "Execution remains within the immutable capability and source-access policy.";

export const STORAGE_TERMINAL_RECEIPT_KINDS = ["checkpoint", "policy", "artifact", "evidence", "acceptance"] as const;
export type StorageTerminalReceiptKind = (typeof STORAGE_TERMINAL_RECEIPT_KINDS)[number];

export interface StorageTerminalResourceCandidate {
  outputKind: "artifact" | "evidence";
  outputId: string;
  outputLinkId: string;
  attemptId: string;
  contentHash: string;
  validationResultId?: string;
  validationResultHash?: string;
}

export type StorageTerminalCriterionCandidate =
  | { criterionId: string; verificationKind: "traceability" }
  | { criterionId: string; verificationKind: "policy" }
  | {
      criterionId: string;
      verificationKind: "validation";
      validationResultId: string;
      validationResultHash: string;
      sourceEvidenceIds: string[];
    };

export interface StorageCanonicalTerminalVerifyInput {
  fence: StorageLeaseFence;
  owner: StorageRunOwnership;
  checkpointId: string;
  completedStep: StorageCompletedStepInput;
  resources: StorageTerminalResourceCandidate[];
  criteria: StorageTerminalCriterionCandidate[];
  verifiedAt: string;
}

export interface StorageCanonicalTerminalVerifierReceipt {
  id: string;
  projectId: string;
  runId: string;
  jobId: string;
  requestHash: string;
  receiptKind: StorageTerminalReceiptKind;
  criterionId: string;
  subjectKind: string;
  subjectId: string;
  subjectHash: string;
  outputHash: string;
  sourceReceiptIds: string[];
  verifierVersion: "storage-worker-terminal-verifier-v1";
  verifiedAt: string;
  receiptHash: string;
}

export interface StorageCanonicalTerminalVerifyResult {
  requestHash: string;
  receipts: StorageCanonicalTerminalVerifierReceipt[];
  attestationBatchHash: string;
  attestations: StorageTerminalResultAttestation[];
  exactReplay: boolean;
}
