import type { StorageRunOwnership } from "./runStateTypes.js";

export interface StorageTerminalAttestedReadbackInput {
  owner: StorageRunOwnership;
  attestationId: string;
}

export const MAX_TERMINAL_ATTESTED_LEASE_READ_BYTES = 1024 * 1024;

export interface StorageTerminalAttestedLease {
  leaseId: string;
  attestationId: string;
  subjectKind: "artifact" | "evidence";
  subjectId: string;
  contentHash: string;
  byteLength: number;
  expiresAt: string;
}

export interface StorageTerminalAttestedLeaseReadInput {
  owner: StorageRunOwnership;
  leaseId: string;
  offset: number;
  maximumBytes: number;
}

export interface StorageTerminalAttestedLeaseChunk {
  leaseId: string;
  offset: number;
  bytes: Uint8Array;
  nextOffset: number;
  done: boolean;
  integrityVerified: boolean;
  contentHash: string;
  byteLength: number;
}

export interface StorageTerminalAttestedLeaseReleaseInput {
  owner: StorageRunOwnership;
  leaseId: string;
}

export interface StorageTerminalAttestedLeaseReleaseResult {
  leaseId: string;
  released: true;
}
