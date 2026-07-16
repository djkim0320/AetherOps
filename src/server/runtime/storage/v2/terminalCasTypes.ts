import { createHash } from "node:crypto";

export interface StorageTerminalCasObject {
  casLocator: string;
  casHash: string;
  byteLength: number;
  pendingClaimId?: string;
}

export interface StorageTerminalCasClaimOwner {
  projectId: string;
  jobId: string;
  attemptId: string;
  outputKind: "artifact" | "evidence";
  outputId: string;
}

export interface StorageTerminalCasClaim {
  object: StorageTerminalCasObject;
  owner: StorageTerminalCasClaimOwner;
}

export function deduplicateStorageTerminalCasClaims(claims: readonly StorageTerminalCasClaim[]): StorageTerminalCasClaim[] {
  const selected = new Map<string, StorageTerminalCasClaim>();
  for (const claim of claims) {
    const claimId = claim.object.pendingClaimId;
    const key = claimId ? `claim:${claimId}` : `legacy:${claim.object.casLocator}\u0000${storageTerminalCasClaimOwnerHash(claim.owner)}`;
    const previous = selected.get(key);
    if (previous && !sameStorageTerminalCasClaim(previous, claim)) {
      throw new Error("Canonical terminal CAS pending claim identity is reused across different objects or owners.");
    }
    selected.set(key, claim);
  }
  return [...selected.values()];
}

export interface StorageTerminalCasReferenceSource {
  iterate(): Iterable<StorageTerminalCasObject>;
  find(casLocator: string): StorageTerminalCasObject | undefined;
}

export interface StorageTerminalCasReconciliationResult {
  verifiedReferenced: number;
  reconciledJournals: number;
  removedTemporary: number;
  removedOrphaned: number;
  complete: boolean;
}

export interface StorageTerminalCasAbortResult {
  removedJournals: number;
  removedObjects: number;
  preservedReferenced: number;
  preservedPending: number;
  deferredUnowned: number;
}

export class TerminalCasFinalizeError extends Error {
  readonly name = "TerminalCasFinalizeError";

  constructor(
    readonly stage: "integrity" | "journal",
    cause: unknown
  ) {
    super(
      stage === "integrity" ? "Canonical terminal CAS integrity verification failed." : "Canonical terminal CAS pending journal removal failed after commit.",
      { cause }
    );
  }
}

export interface StorageTerminalCasCommitWork<T> {
  result: T;
  disposition: "finalize" | "abort";
}

export interface StorageTerminalCasCommitResult<T> {
  result: T;
  postCommitError?: TerminalCasFinalizeError;
}

export function storageTerminalCasClaimOwnerHash(value: StorageTerminalCasClaimOwner): string {
  const fields = [value.projectId, value.jobId, value.attemptId, value.outputKind, value.outputId];
  if (fields.some((field) => typeof field !== "string" || !field || field.length > 2_048 || field.includes("\u0000"))) {
    throw new Error("Canonical terminal CAS pending owner is invalid.");
  }
  if (value.outputKind !== "artifact" && value.outputKind !== "evidence") throw new Error("Canonical terminal CAS pending output kind is invalid.");
  return createHash("sha256").update(fields.join("\u0000")).digest("hex");
}

function sameStorageTerminalCasClaim(left: StorageTerminalCasClaim, right: StorageTerminalCasClaim): boolean {
  return (
    left.object.pendingClaimId === right.object.pendingClaimId &&
    left.object.casLocator === right.object.casLocator &&
    left.object.casHash === right.object.casHash &&
    left.object.byteLength === right.object.byteLength &&
    storageTerminalCasClaimOwnerHash(left.owner) === storageTerminalCasClaimOwnerHash(right.owner)
  );
}
