import { existsSync } from "node:fs";
import { removeTerminalFile } from "./terminalCasFilesystem.js";
import type { TerminalCasJournal } from "./terminalCasJournal.js";
import {
  deduplicateStorageTerminalCasClaims,
  storageTerminalCasClaimOwnerHash,
  TerminalCasFinalizeError,
  type StorageTerminalCasAbortResult,
  type StorageTerminalCasClaim,
  type StorageTerminalCasCommitResult,
  type StorageTerminalCasCommitWork,
  type StorageTerminalCasObject,
  type StorageTerminalCasReferenceSource
} from "./terminalCasTypes.js";

export class TerminalCasClaimCoordinator {
  constructor(
    private readonly journal: TerminalCasJournal,
    private readonly verify: (object: StorageTerminalCasObject) => void,
    private readonly resolveLocator: (object: StorageTerminalCasObject) => string
  ) {}

  finalize(claims: readonly StorageTerminalCasClaim[]): void {
    if (!claims.length) return;
    const entries = deduplicateStorageTerminalCasClaims(claims);
    if (entries.some((claim) => !claim.object.pendingClaimId)) {
      throw new Error("Authorized terminal CAS finalization requires owner-scoped pending claims.");
    }
    const content = new Map(entries.map((claim) => [claim.object.casLocator, claim.object]));
    try {
      for (const object of content.values()) this.verify(object);
    } catch (error) {
      throw new TerminalCasFinalizeError("integrity", error);
    }
    try {
      for (const claim of entries) {
        this.journal.withHashLock(claim.object.casHash, () => this.removeAuthorized(claim, "finalization"));
      }
    } catch (error) {
      throw new TerminalCasFinalizeError("journal", error);
    }
  }

  abort(claims: readonly StorageTerminalCasClaim[], references: StorageTerminalCasReferenceSource): StorageTerminalCasAbortResult {
    const unique = deduplicateStorageTerminalCasClaims(claims);
    const result: StorageTerminalCasAbortResult = {
      removedJournals: 0,
      removedObjects: 0,
      preservedReferenced: 0,
      preservedPending: 0,
      deferredUnowned: 0
    };
    for (const claim of unique) {
      if (!claim.object.pendingClaimId) {
        result.deferredUnowned += 1;
        continue;
      }
      this.journal.withHashLock(claim.object.casHash, () => this.abortLocked(claim, references, result));
    }
    return result;
  }

  commit<T>(
    claims: readonly StorageTerminalCasClaim[],
    references: StorageTerminalCasReferenceSource,
    work: () => StorageTerminalCasCommitWork<T>,
    allowDurableReplay = false
  ): StorageTerminalCasCommitResult<T> {
    const unique = deduplicateStorageTerminalCasClaims(claims);
    const hashes = [...new Set(unique.map((claim) => claim.object.casHash))].sort();
    return this.withHashLocks(hashes, 0, () => {
      this.verifyAuthorizedClaims(unique, references, allowDurableReplay);
      let committed: StorageTerminalCasCommitWork<T>;
      try {
        committed = work();
      } catch (error) {
        try {
          const ignored = emptyAbortResult();
          for (const claim of unique) this.abortLocked(claim, references, ignored);
        } catch (cleanupError) {
          throw new AggregateError([error, cleanupError], "Terminal transaction rolled back and pending CAS claim cleanup failed.", {
            cause: cleanupError
          });
        }
        throw error;
      }
      try {
        if (committed.disposition === "finalize") {
          for (const claim of unique) this.removeAuthorized(claim, "commit", allowDurableReplay);
        } else {
          const ignored = emptyAbortResult();
          for (const claim of unique) this.abortLocked(claim, references, ignored);
        }
        return { result: committed.result };
      } catch (error) {
        return { result: committed.result, postCommitError: new TerminalCasFinalizeError("journal", error) };
      }
    });
  }

  private verifyAuthorizedClaims(claims: readonly StorageTerminalCasClaim[], references: StorageTerminalCasReferenceSource, allowDurableReplay: boolean): void {
    try {
      for (const claim of claims) {
        this.verify(claim.object);
        const journal = this.journal.verifyAuthorized(claim.object, storageTerminalCasClaimOwnerHash(claim.owner));
        const durable = journal ? undefined : references.find(claim.object.casLocator);
        const exactDurableReplay = allowDurableReplay && durable?.casHash === claim.object.casHash && durable.byteLength === claim.object.byteLength;
        if (!journal && !exactDurableReplay) {
          throw new Error("Authorized terminal CAS commit requires its durable pending claim journal.");
        }
      }
    } catch (error) {
      throw new TerminalCasFinalizeError("integrity", error);
    }
  }

  private abortLocked(claim: StorageTerminalCasClaim, references: StorageTerminalCasReferenceSource, result: StorageTerminalCasAbortResult): void {
    const object = claim.object;
    const ownerHash = storageTerminalCasClaimOwnerHash(claim.owner);
    if (!this.journal.verifyAuthorized(object, ownerHash)) {
      result.deferredUnowned += 1;
      return;
    }
    const durable = references.find(object.casLocator);
    if (durable && (durable.casHash !== object.casHash || durable.byteLength !== object.byteLength)) {
      throw new Error("Canonical terminal CAS abort conflicts with its durable database receipt.");
    }
    this.verify(durable ?? object);
    if (this.journal.removeAuthorized(object, ownerHash)) result.removedJournals += 1;
    if (durable) {
      result.preservedReferenced += 1;
      return;
    }
    if (this.journal.hasPending(object.casHash)) {
      result.preservedPending += 1;
      return;
    }
    const path = this.resolveLocator(object);
    if (existsSync(path)) {
      removeTerminalFile(path);
      result.removedObjects += 1;
    }
  }

  private removeAuthorized(claim: StorageTerminalCasClaim, operation: string, allowMissing = false): void {
    if (!this.journal.removeAuthorized(claim.object, storageTerminalCasClaimOwnerHash(claim.owner)) && !allowMissing) {
      throw new Error(`Authorized terminal CAS ${operation} requires its durable pending claim journal.`);
    }
  }

  private withHashLocks<T>(hashes: readonly string[], index: number, work: () => T): T {
    const hash = hashes[index];
    return hash ? this.journal.withHashLock(hash, () => this.withHashLocks(hashes, index + 1, work)) : work();
  }
}

function emptyAbortResult(): StorageTerminalCasAbortResult {
  return { removedJournals: 0, removedObjects: 0, preservedReferenced: 0, preservedPending: 0, deferredUnowned: 0 };
}
