import { createHash, randomUUID } from "node:crypto";
import { chmodSync, closeSync, constants, existsSync, fstatSync, fsyncSync, openSync, readSync, renameSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import {
  copyExpectedTerminalFile,
  hashTerminalRegularFile,
  removeTerminalFile,
  secureTerminalDirectoryTree,
  TERMINAL_STREAM_CHUNK_BYTES,
  writeAll
} from "./terminalCasFilesystem.js";
import { TerminalCasJournal } from "./terminalCasJournal.js";
import { TerminalCasReconciler } from "./terminalCasReconciliation.js";
import { TerminalCasClaimCoordinator } from "./terminalCasClaimCoordinator.js";
import {
  storageTerminalCasClaimOwnerHash,
  TerminalCasFinalizeError,
  type StorageTerminalCasAbortResult,
  type StorageTerminalCasClaim,
  type StorageTerminalCasClaimOwner,
  type StorageTerminalCasCommitResult,
  type StorageTerminalCasCommitWork,
  type StorageTerminalCasObject,
  type StorageTerminalCasReconciliationResult,
  type StorageTerminalCasReferenceSource
} from "./terminalCasTypes.js";
export * from "./terminalCasTypes.js";

const HASH_PATTERN = /^[a-f0-9]{64}$/;
const LOCATOR_PATTERN = /^terminal-cas\/sha256\/[a-f0-9]{2}\/[a-f0-9]{64}$/;
export const MAX_TERMINAL_ARTIFACT_BYTES = 128 * 1024 * 1024;
export const MAX_TERMINAL_JSON_BYTES = 8 * 1024 * 1024;

/**
 * Content-addressed terminal bytes live below the migration-owned v2 root. Files are written once,
 * fsynced, atomically renamed, and always rehashed before they can become attestation authority.
 */
export class TerminalCasStore {
  private readonly dataRoot?: string;
  private readonly root?: string;
  private readonly journal?: TerminalCasJournal;

  constructor(dataRoot?: string) {
    this.dataRoot = dataRoot ? resolve(dataRoot) : undefined;
    this.root = this.dataRoot ? join(this.dataRoot, "migration", "v2") : undefined;
    this.journal = this.dataRoot ? new TerminalCasJournal(this.dataRoot) : undefined;
  }

  materializeBytes(bytes: Uint8Array, maximumBytes = MAX_TERMINAL_JSON_BYTES): StorageTerminalCasObject {
    return this.materializeBytesInternal(bytes, maximumBytes);
  }

  materializeClaimedBytes(bytes: Uint8Array, claimOwner: StorageTerminalCasClaimOwner, maximumBytes = MAX_TERMINAL_JSON_BYTES): StorageTerminalCasObject {
    return this.materializeBytesInternal(bytes, maximumBytes, claimOwner);
  }

  private materializeBytesInternal(bytes: Uint8Array, maximumBytes: number, claimOwner?: StorageTerminalCasClaimOwner): StorageTerminalCasObject {
    if (bytes.byteLength > maximumBytes) throw new Error("Canonical terminal materialization exceeds the bounded byte limit.");
    const hash = createHash("sha256").update(bytes).digest("hex");
    const temporary = this.openTemporary();
    try {
      writeAll(temporary.fd, bytes);
      fsyncSync(temporary.fd);
    } finally {
      closeSync(temporary.fd);
    }
    return this.publishTemporary(temporary.path, hash, bytes.byteLength, maximumBytes, claimOwner);
  }

  materializeOpenFile(fd: number, maximumBytes = MAX_TERMINAL_ARTIFACT_BYTES): StorageTerminalCasObject {
    return this.materializeOpenFileInternal(fd, maximumBytes);
  }

  materializeClaimedOpenFile(fd: number, claimOwner: StorageTerminalCasClaimOwner, maximumBytes = MAX_TERMINAL_ARTIFACT_BYTES): StorageTerminalCasObject {
    return this.materializeOpenFileInternal(fd, maximumBytes, claimOwner);
  }

  private materializeOpenFileInternal(fd: number, maximumBytes: number, claimOwner?: StorageTerminalCasClaimOwner): StorageTerminalCasObject {
    const before = fstatSync(fd, { bigint: true });
    if (!before.isFile()) throw new Error("Canonical terminal source is not a regular file.");
    const temporary = this.openTemporary();
    const hash = createHash("sha256");
    let offset = 0;
    try {
      const chunk = Buffer.allocUnsafe(TERMINAL_STREAM_CHUNK_BYTES);
      for (;;) {
        const count = readSync(fd, chunk, 0, chunk.byteLength, offset);
        if (!count) break;
        offset += count;
        if (offset > maximumBytes) throw new Error("Canonical terminal materialization exceeds the bounded byte limit.");
        hash.update(chunk.subarray(0, count));
        writeAll(temporary.fd, chunk.subarray(0, count));
      }
      const after = fstatSync(fd, { bigint: true });
      if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeNs !== after.mtimeNs) {
        throw new Error("Canonical terminal source changed during materialization.");
      }
      fsyncSync(temporary.fd);
    } catch (error) {
      closeSync(temporary.fd);
      removeTerminalFile(temporary.path);
      throw error;
    }
    closeSync(temporary.fd);
    return this.publishTemporary(temporary.path, hash.digest("hex"), offset, maximumBytes, claimOwner);
  }

  verify(object: StorageTerminalCasObject, maximumBytes = MAX_TERMINAL_ARTIFACT_BYTES): void {
    let actual: ReturnType<typeof hashTerminalRegularFile>;
    try {
      this.assertLocatorParent(object.casLocator);
      actual = hashTerminalRegularFile(this.resolveLocator(object.casLocator, object.casHash), maximumBytes);
    } catch {
      throw new Error("Canonical terminal CAS readback failed.");
    }
    if (actual.hash !== object.casHash || actual.byteLength !== object.byteLength) {
      throw new Error("Canonical terminal CAS readback does not match its immutable attestation.");
    }
  }

  readVerifiedExcerpt(
    object: StorageTerminalCasObject,
    maximumExcerptBytes = 64 * 1024,
    maximumBytes = MAX_TERMINAL_ARTIFACT_BYTES
  ): { bytes: Uint8Array; complete: boolean } {
    if (!Number.isSafeInteger(maximumExcerptBytes) || maximumExcerptBytes < 1 || maximumExcerptBytes > maximumBytes) {
      throw new Error("Canonical terminal excerpt limit is invalid.");
    }
    this.assertLocatorParent(object.casLocator);
    const path = this.resolveLocator(object.casLocator, object.casHash);
    const noFollow = "O_NOFOLLOW" in constants ? constants.O_NOFOLLOW : 0;
    const fd = openSync(path, constants.O_RDONLY | noFollow);
    const hash = createHash("sha256");
    const excerpts: Buffer[] = [];
    let excerptLength = 0;
    let offset = 0;
    try {
      const before = fstatSync(fd, { bigint: true });
      if (!before.isFile()) throw new Error("Canonical terminal CAS object is not a regular file.");
      const chunk = Buffer.allocUnsafe(TERMINAL_STREAM_CHUNK_BYTES);
      for (;;) {
        const count = readSync(fd, chunk, 0, chunk.byteLength, offset);
        if (!count) break;
        offset += count;
        if (offset > maximumBytes) throw new Error("Canonical terminal CAS object exceeds the bounded byte limit.");
        const value = chunk.subarray(0, count);
        hash.update(value);
        if (excerptLength < maximumExcerptBytes) {
          const selected = value.subarray(0, Math.min(value.byteLength, maximumExcerptBytes - excerptLength));
          excerpts.push(Buffer.from(selected));
          excerptLength += selected.byteLength;
        }
      }
      const after = fstatSync(fd, { bigint: true });
      if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeNs !== after.mtimeNs) {
        throw new Error("Canonical terminal CAS object changed during readback.");
      }
    } finally {
      closeSync(fd);
    }
    if (offset !== object.byteLength || hash.digest("hex") !== object.casHash) {
      throw new Error("Canonical terminal CAS readback does not match its immutable attestation.");
    }
    return { bytes: Buffer.concat(excerpts), complete: offset <= maximumExcerptBytes };
  }

  copyVerifiedToLeaseFile(object: StorageTerminalCasObject, destination: string, maximumBytes = MAX_TERMINAL_ARTIFACT_BYTES): void {
    if (!HASH_PATTERN.test(object.casHash)) throw new Error("Canonical terminal lease identity is malformed.");
    if (!Number.isSafeInteger(object.byteLength) || object.byteLength < 0 || object.byteLength > maximumBytes) {
      throw new Error("Canonical terminal lease object exceeds its bounded byte limit.");
    }
    this.assertLocatorParent(object.casLocator);
    copyExpectedTerminalFile(this.resolveLocator(object.casLocator, object.casHash), destination, object, maximumBytes);
  }

  cleanup(
    references: ReadonlySet<string> | StorageTerminalCasReferenceSource,
    maximumEntries = 512
  ): { removedTemporary: number; removedOrphaned: number; complete: boolean } {
    return this.reconciler().cleanup(references, maximumEntries);
  }

  reconcile(
    references: readonly StorageTerminalCasObject[] | StorageTerminalCasReferenceSource,
    maximumEntries = 2_048
  ): StorageTerminalCasReconciliationResult {
    return this.reconciler().reconcile(references, maximumEntries);
  }

  finalize(objects: readonly StorageTerminalCasObject[]): void {
    if (!objects.length) return;
    if (objects.some((object) => object.pendingClaimId)) throw new Error("Owner-scoped terminal CAS claims require authorized finalization.");
    this.finalizeEntries(objects, (object) => this.requiredJournal().remove(object));
  }

  finalizeClaims(claims: readonly StorageTerminalCasClaim[]): void {
    this.claimCoordinator().finalize(claims);
  }

  private finalizeEntries(objects: readonly StorageTerminalCasObject[], removeJournal: (object: StorageTerminalCasObject) => boolean): void {
    const receipts = new Map(objects.map((object) => [`${object.casLocator}\u0000${object.pendingClaimId ?? "legacy"}`, object]));
    const content = new Map(objects.map((object) => [object.casLocator, object]));
    try {
      for (const object of content.values()) this.verify(object);
    } catch (error) {
      throw new TerminalCasFinalizeError("integrity", error);
    }
    try {
      for (const object of receipts.values()) {
        this.requiredJournal().withHashLock(object.casHash, () => removeJournal(object));
      }
    } catch (error) {
      throw new TerminalCasFinalizeError("journal", error);
    }
  }

  abort(claims: readonly StorageTerminalCasClaim[], references: StorageTerminalCasReferenceSource): StorageTerminalCasAbortResult {
    return this.claimCoordinator().abort(claims, references);
  }

  commitClaims<T>(
    claims: readonly StorageTerminalCasClaim[],
    references: StorageTerminalCasReferenceSource,
    work: () => StorageTerminalCasCommitWork<T>,
    allowDurableReplay = false
  ): StorageTerminalCasCommitResult<T> {
    return this.claimCoordinator().commit(claims, references, work, allowDurableReplay);
  }

  private openTemporary(): { fd: number; path: string } {
    const directory = this.ensureDirectory(["migration", "v2", "terminal-cas", "tmp"], true);
    const path = join(directory, `${randomUUID()}.partial`);
    return { path, fd: openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600) };
  }

  private publishTemporary(
    path: string,
    hash: string,
    byteLength: number,
    maximumBytes: number,
    claimOwner?: StorageTerminalCasClaimOwner
  ): StorageTerminalCasObject {
    if (!HASH_PATTERN.test(hash)) {
      removeTerminalFile(path);
      throw new Error("Canonical terminal materialization produced an invalid hash.");
    }
    const locator = `terminal-cas/sha256/${hash.slice(0, 2)}/${hash}`;
    const destination = this.resolveLocator(locator, hash);
    const pendingClaimId = claimOwner ? randomUUID() : undefined;
    const object: StorageTerminalCasObject = { casLocator: locator, casHash: hash, byteLength, ...(pendingClaimId ? { pendingClaimId } : {}) };
    try {
      this.requiredJournal().withHashLock(hash, () => {
        let created = false;
        this.ensureDirectory(["migration", "v2", "terminal-cas", "sha256", hash.slice(0, 2)], true);
        const ownerHash = claimOwner ? storageTerminalCasClaimOwnerHash(claimOwner) : undefined;
        const journalCreated = this.requiredJournal().write(object, ownerHash);
        try {
          if (existsSync(destination)) {
            removeTerminalFile(path);
          } else {
            try {
              renameSync(path, destination);
              created = true;
            } catch (error) {
              if (!existsSync(destination)) throw error;
              removeTerminalFile(path);
            }
            if (process.platform !== "win32") chmodSync(destination, 0o444);
          }
          this.verify(object, maximumBytes);
        } catch (error) {
          if (ownerHash) {
            try {
              this.requiredJournal().removeAuthorized(object, ownerHash);
              if (created && !this.requiredJournal().hasPending(hash)) removeTerminalFile(destination);
            } catch (cleanupError) {
              throw new AggregateError([error, cleanupError], "Canonical terminal materialization and owner-claim cleanup both failed.", {
                cause: cleanupError
              });
            }
          } else if (journalCreated) {
            try {
              this.requiredJournal().remove(object);
              if (created && !this.requiredJournal().hasPending(hash)) removeTerminalFile(destination);
            } catch (cleanupError) {
              throw new AggregateError([error, cleanupError], "Canonical terminal materialization and legacy journal cleanup both failed.", {
                cause: cleanupError
              });
            }
          }
          throw error;
        }
      });
      return object;
    } catch (error) {
      removeTerminalFile(path);
      throw error;
    }
  }

  private resolveLocator(locator: string, hash: string): string {
    if (!LOCATOR_PATTERN.test(locator) || !HASH_PATTERN.test(hash) || !locator.endsWith(`/${hash}`)) {
      throw new Error("Canonical terminal CAS locator is malformed.");
    }
    const root = this.requiredRoot();
    const path = resolve(root, ...locator.split("/"));
    const scoped = relative(root, path);
    if (!scoped || scoped.startsWith("..") || scoped.split(sep).includes("..")) {
      throw new Error("Canonical terminal CAS locator escapes its storage root.");
    }
    return path;
  }

  private requiredRoot(): string {
    if (!this.root || !this.dataRoot) throw new Error("Canonical terminal CAS is unavailable because the storage data root is not configured.");
    this.ensureDirectory(["migration", "v2"], true);
    return this.root;
  }

  private requiredJournal(): TerminalCasJournal {
    if (!this.journal) throw new Error("Canonical terminal CAS journal is unavailable because the storage data root is not configured.");
    return this.journal;
  }

  private reconciler(): TerminalCasReconciler {
    return new TerminalCasReconciler(this.requiredRoot(), this.requiredJournal(), (object) => this.verify(object));
  }

  private claimCoordinator(): TerminalCasClaimCoordinator {
    return new TerminalCasClaimCoordinator(
      this.requiredJournal(),
      (object) => this.verify(object),
      (object) => this.resolveLocator(object.casLocator, object.casHash)
    );
  }

  private assertLocatorParent(locator: string): void {
    const parts = locator.split("/");
    this.ensureDirectory(["migration", "v2", ...parts.slice(0, -1)], false);
  }

  private ensureDirectory(segments: string[], create: boolean): string {
    if (!this.dataRoot) throw new Error("Canonical terminal CAS is unavailable because the storage data root is not configured.");
    return secureTerminalDirectoryTree(this.dataRoot, segments, create);
  }
}
