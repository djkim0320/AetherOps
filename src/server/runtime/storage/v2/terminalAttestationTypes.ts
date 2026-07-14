export type StorageTerminalAttestationKind = "artifact" | "evidence" | "validation_result";

export interface StorageTerminalResultAttestation {
  id: string;
  schemaVersion: 1;
  projectId: string;
  runId: string;
  jobId: string;
  batchHash: string;
  subjectKind: StorageTerminalAttestationKind;
  subjectId: string;
  contentHash: string;
  casLocator: string;
  casHash: string;
  byteLength: number;
  attemptId?: string;
  outputLinkId?: string;
  validationAttestationId?: string;
  provenanceAttestationIds: string[];
  supportingEvidenceIds: string[];
  contradictingEvidenceIds: string[];
  sourceEvidenceIdsHash: string;
  supportedClaimHashes: string[];
  attestedAt: string;
  attestationHash: string;
}

export interface StorageTerminalAttestationBatch {
  batchHash: string;
  attestations: StorageTerminalResultAttestation[];
  exactReplay: boolean;
}
