import { createHash, randomUUID } from "node:crypto";
import { chmodSync, closeSync, constants, existsSync, fstatSync, fsyncSync, openSync, readSync, realpathSync, renameSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import {
  boundedTerminalFiles,
  copyExpectedTerminalFile,
  hashTerminalRegularFile,
  removeTerminalFile,
  secureTerminalDirectoryTree,
  TERMINAL_STREAM_CHUNK_BYTES,
  writeAll
} from "./terminalCasFilesystem.js";

const HASH_PATTERN = /^[a-f0-9]{64}$/;
const LOCATOR_PATTERN = /^terminal-cas\/sha256\/[a-f0-9]{2}\/[a-f0-9]{64}$/;
export const MAX_TERMINAL_ARTIFACT_BYTES = 128 * 1024 * 1024;
export const MAX_TERMINAL_JSON_BYTES = 8 * 1024 * 1024;

export interface StorageTerminalCasObject {
  casLocator: string;
  casHash: string;
  byteLength: number;
}

/**
 * Content-addressed terminal bytes live below the migration-owned v2 root. Files are written once,
 * fsynced, atomically renamed, and always rehashed before they can become attestation authority.
 */
export class TerminalCasStore {
  private readonly dataRoot?: string;
  private readonly root?: string;

  constructor(dataRoot?: string) {
    this.dataRoot = dataRoot ? resolve(dataRoot) : undefined;
    this.root = this.dataRoot ? join(this.dataRoot, "migration", "v2") : undefined;
  }

  materializeBytes(bytes: Uint8Array, maximumBytes = MAX_TERMINAL_JSON_BYTES): StorageTerminalCasObject {
    if (bytes.byteLength > maximumBytes) throw new Error("Canonical terminal materialization exceeds the bounded byte limit.");
    const hash = createHash("sha256").update(bytes).digest("hex");
    const temporary = this.openTemporary();
    try {
      writeAll(temporary.fd, bytes);
      fsyncSync(temporary.fd);
    } finally {
      closeSync(temporary.fd);
    }
    return this.publishTemporary(temporary.path, hash, bytes.byteLength, maximumBytes);
  }

  materializeOpenFile(fd: number, maximumBytes = MAX_TERMINAL_ARTIFACT_BYTES): StorageTerminalCasObject {
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
    return this.publishTemporary(temporary.path, hash.digest("hex"), offset, maximumBytes);
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

  copyVerifiedToLeaseFile(object: StorageTerminalCasObject, destination: string, maximumBytes = MAX_TERMINAL_ARTIFACT_BYTES): void {
    if (!HASH_PATTERN.test(object.casHash)) throw new Error("Canonical terminal lease identity is malformed.");
    if (!Number.isSafeInteger(object.byteLength) || object.byteLength < 0 || object.byteLength > maximumBytes) {
      throw new Error("Canonical terminal lease object exceeds its bounded byte limit.");
    }
    this.assertLocatorParent(object.casLocator);
    copyExpectedTerminalFile(this.resolveLocator(object.casLocator, object.casHash), destination, object, maximumBytes);
  }

  cleanup(referencedLocators: ReadonlySet<string>, maximumEntries = 512): { removedTemporary: number; removedOrphaned: number; complete: boolean } {
    const root = this.requiredRoot();
    const base = join(root, "terminal-cas");
    if (!existsSync(base)) return { removedTemporary: 0, removedOrphaned: 0, complete: true };
    this.ensureDirectory(["migration", "v2", "terminal-cas"], false);
    const entries = boundedTerminalFiles(base, maximumEntries + 1, realpathSync.native(base));
    if (entries.length > maximumEntries) return { removedTemporary: 0, removedOrphaned: 0, complete: false };
    let removedTemporary = 0;
    let removedOrphaned = 0;
    for (const path of entries) {
      const locator = relative(root, path).split(sep).join("/");
      if (locator.startsWith("terminal-cas/tmp/") || locator.startsWith("terminal-cas/journal/")) {
        removeTerminalFile(path);
        removedTemporary += 1;
      } else if (LOCATOR_PATTERN.test(locator) && !referencedLocators.has(locator)) {
        removeTerminalFile(path);
        removedOrphaned += 1;
      }
    }
    return { removedTemporary, removedOrphaned, complete: true };
  }

  finalize(objects: readonly StorageTerminalCasObject[]): void {
    if (!objects.length) return;
    const journalDirectory = join(this.requiredRoot(), "terminal-cas", "journal");
    if (!existsSync(journalDirectory)) return;
    this.ensureDirectory(["migration", "v2", "terminal-cas", "journal"], false);
    for (const hash of new Set(objects.map((object) => object.casHash))) removeTerminalFile(this.journalPath(hash));
  }

  private openTemporary(): { fd: number; path: string } {
    const directory = this.ensureDirectory(["migration", "v2", "terminal-cas", "tmp"], true);
    const path = join(directory, `${randomUUID()}.partial`);
    return { path, fd: openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600) };
  }

  private publishTemporary(path: string, hash: string, byteLength: number, maximumBytes: number): StorageTerminalCasObject {
    if (!HASH_PATTERN.test(hash)) {
      removeTerminalFile(path);
      throw new Error("Canonical terminal materialization produced an invalid hash.");
    }
    const locator = `terminal-cas/sha256/${hash.slice(0, 2)}/${hash}`;
    const destination = this.resolveLocator(locator, hash);
    try {
      this.ensureDirectory(["migration", "v2", "terminal-cas", "sha256", hash.slice(0, 2)], true);
      this.writeJournal({ casLocator: locator, casHash: hash, byteLength });
      if (existsSync(destination)) {
        removeTerminalFile(path);
      } else {
        try {
          renameSync(path, destination);
        } catch (error) {
          if (!existsSync(destination)) throw error;
          removeTerminalFile(path);
        }
        if (process.platform !== "win32") chmodSync(destination, 0o444);
      }
      const object = { casLocator: locator, casHash: hash, byteLength };
      this.verify(object, maximumBytes);
      return object;
    } catch (error) {
      removeTerminalFile(path);
      throw error;
    }
  }

  private writeJournal(object: StorageTerminalCasObject): void {
    const destination = this.journalPath(object.casHash);
    this.ensureDirectory(["migration", "v2", "terminal-cas", "journal"], true);
    if (existsSync(destination)) return;
    const temporary = `${destination}.${randomUUID()}.partial`;
    const fd = openSync(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
    try {
      writeAll(fd, Buffer.from(JSON.stringify({ schemaVersion: 1, ...object }), "utf8"));
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    try {
      renameSync(temporary, destination);
    } catch (error) {
      if (!existsSync(destination)) {
        removeTerminalFile(temporary);
        throw error;
      }
      removeTerminalFile(temporary);
    }
  }

  private journalPath(hash: string): string {
    if (!HASH_PATTERN.test(hash)) throw new Error("Canonical terminal CAS journal hash is malformed.");
    return join(this.requiredRoot(), "terminal-cas", "journal", `${hash}.pending`);
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

  private assertLocatorParent(locator: string): void {
    const parts = locator.split("/");
    this.ensureDirectory(["migration", "v2", ...parts.slice(0, -1)], false);
  }

  private ensureDirectory(segments: string[], create: boolean): string {
    if (!this.dataRoot) throw new Error("Canonical terminal CAS is unavailable because the storage data root is not configured.");
    return secureTerminalDirectoryTree(this.dataRoot, segments, create);
  }
}
