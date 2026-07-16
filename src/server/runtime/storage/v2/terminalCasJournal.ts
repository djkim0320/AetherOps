import { randomUUID } from "node:crypto";
import { closeSync, constants, existsSync, fsyncSync, lstatSync, openSync, opendirSync, readFileSync, realpathSync, renameSync } from "node:fs";
import { basename, join } from "node:path";
import { boundedTerminalFiles, removeTerminalFile, secureTerminalDirectoryTree, writeAll } from "./terminalCasFilesystem.js";

const HASH_PATTERN = /^[a-f0-9]{64}$/;
const CLAIM_PATTERN = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const LOCK_WAIT_MS = 2_000;
const LOCK_RETRY_MS = 10;
const LOCK_SLEEP = new Int32Array(new SharedArrayBuffer(4));

export interface TerminalCasJournalObject {
  casLocator: string;
  casHash: string;
  byteLength: number;
  pendingClaimId?: string;
  pendingClaimOwnerHash?: string;
}

export class TerminalCasJournal {
  constructor(private readonly dataRoot: string) {}

  write(object: TerminalCasJournalObject, claimOwnerHash?: string): boolean {
    const destination = this.pathFor(object);
    this.directory("journal", true);
    if (existsSync(destination)) return this.acceptExisting(destination, object);
    const temporary = `${destination}.${randomUUID()}.partial`;
    const fd = openSync(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
    try {
      const body = object.pendingClaimId
        ? { schemaVersion: 2, ...object, claimOwnerHash: requiredOwnerHash(claimOwnerHash) }
        : { schemaVersion: 1, casLocator: object.casLocator, casHash: object.casHash, byteLength: object.byteLength };
      writeAll(fd, Buffer.from(JSON.stringify(body), "utf8"));
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    try {
      // Claim ids are unique; a destination collision is an immutable identity conflict.
      renameSync(temporary, destination);
      return true;
    } catch (error) {
      removeTerminalFile(temporary);
      if (!existsSync(destination)) throw error;
      return this.acceptExisting(destination, object);
    }
  }

  read(path: string): TerminalCasJournalObject {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 2 || stat.size > 4_096) {
      throw new Error("Canonical terminal CAS journal is not a bounded regular file.");
    }
    let value: unknown;
    try {
      value = JSON.parse(readFileSync(path, "utf8"));
    } catch {
      throw new Error("Canonical terminal CAS journal is malformed.");
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Canonical terminal CAS journal is malformed.");
    const record = value as Record<string, unknown>;
    const pendingClaimId = optionalClaim(record.pendingClaimId);
    const pendingClaimOwnerHash = pendingClaimId ? requiredOwnerHash(record.claimOwnerHash) : undefined;
    const object: TerminalCasJournalObject = {
      casLocator: String(record.casLocator ?? ""),
      casHash: String(record.casHash ?? ""),
      byteLength: Number(record.byteLength),
      ...(pendingClaimId ? { pendingClaimId, pendingClaimOwnerHash } : {})
    };
    const expectedName = pendingClaimId ? `${object.casHash}.${pendingClaimId}.pending` : `${object.casHash}.pending`;
    if (
      record.schemaVersion !== (pendingClaimId ? 2 : 1) ||
      !/^terminal-cas\/sha256\/[a-f0-9]{2}\/[a-f0-9]{64}$/.test(object.casLocator) ||
      !HASH_PATTERN.test(object.casHash) ||
      !object.casLocator.endsWith(`/${object.casHash}`) ||
      !Number.isSafeInteger(object.byteLength) ||
      object.byteLength < 0 ||
      !path.endsWith(expectedName)
    ) {
      throw new Error("Canonical terminal CAS journal identity is malformed.");
    }
    return object;
  }

  removeAuthorized(object: TerminalCasJournalObject, expectedOwnerHash: string): boolean {
    const path = this.verifyAuthorized(object, expectedOwnerHash);
    if (!path) return false;
    removeTerminalFile(path);
    return true;
  }

  verifyAuthorized(object: TerminalCasJournalObject, expectedOwnerHash: string): string | undefined {
    if (!object.pendingClaimId) throw new Error("Canonical terminal CAS abort requires an owner-scoped pending claim.");
    const path = this.pathFor(object);
    if (!existsSync(path)) return undefined;
    const journal = this.read(path);
    if (
      journal.pendingClaimOwnerHash !== requiredOwnerHash(expectedOwnerHash) ||
      journal.casLocator !== object.casLocator ||
      journal.casHash !== object.casHash ||
      journal.byteLength !== object.byteLength
    ) {
      throw new Error("Canonical terminal CAS pending claim ownership verification failed.");
    }
    return path;
  }

  remove(object: TerminalCasJournalObject): boolean {
    const path = this.pathFor(object);
    if (!existsSync(path)) return false;
    removeTerminalFile(path);
    return true;
  }

  hasPending(hash: string): boolean {
    assertHash(hash);
    const directory = this.directory("journal", false);
    if (!directory) return false;
    const handle = opendirSync(directory);
    try {
      for (;;) {
        const entry = handle.readSync();
        if (!entry) return false;
        if (!entry.isFile() || entry.isSymbolicLink()) throw new Error("Canonical terminal CAS journal contains an invalid entry.");
        if (entry.name === `${hash}.pending` || (entry.name.startsWith(`${hash}.`) && entry.name.endsWith(".pending"))) return true;
      }
    } finally {
      handle.closeSync();
    }
  }

  withHashLock<T>(hash: string, work: () => T): T {
    assertHash(hash);
    const directory = this.directory("locks", true)!;
    const path = join(directory, `${hash}.lock`);
    const deadline = Date.now() + LOCK_WAIT_MS;
    let fd: number | undefined;
    while (fd === undefined) {
      try {
        fd = openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
      } catch (error) {
        if (!isAlreadyExists(error) || Date.now() >= deadline) throw new Error("Canonical terminal CAS hash lock is unavailable.", { cause: error });
        Atomics.wait(LOCK_SLEEP, 0, 0, LOCK_RETRY_MS);
      }
    }
    closeSync(fd);
    try {
      return work();
    } finally {
      removeTerminalFile(path);
    }
  }

  recoverInterruptedLocks(maximumEntries = 64): number {
    const directory = this.directory("locks", false);
    if (!directory) return 0;
    const files = boundedTerminalFiles(directory, maximumEntries + 1, realpathSync.native(directory));
    if (files.length > maximumEntries) throw new Error("Canonical terminal CAS has too many interrupted hash locks for bounded recovery.");
    for (const path of files) {
      if (!/^[a-f0-9]{64}\.lock$/.test(basename(path))) throw new Error("Canonical terminal CAS hash lock identity is malformed.");
      removeTerminalFile(path);
    }
    return files.length;
  }

  private pathFor(object: TerminalCasJournalObject): string {
    assertHash(object.casHash);
    const name = object.pendingClaimId ? `${object.casHash}.${requiredClaim(object.pendingClaimId)}.pending` : `${object.casHash}.pending`;
    return join(this.requiredDirectory("journal"), name);
  }

  private acceptExisting(path: string, expected: TerminalCasJournalObject): false {
    if (expected.pendingClaimId) {
      throw new Error("Canonical terminal CAS pending claim identity already exists.");
    }
    const actual = this.read(path);
    if (
      actual.pendingClaimId ||
      actual.casLocator !== expected.casLocator ||
      actual.casHash !== expected.casHash ||
      actual.byteLength !== expected.byteLength
    ) {
      throw new Error("Canonical terminal CAS legacy journal conflicts with its immutable identity.");
    }
    return false;
  }

  private requiredDirectory(name: "journal" | "locks"): string {
    return this.directory(name, true)!;
  }

  private directory(name: "journal" | "locks", create: boolean): string | undefined {
    const path = join(this.dataRoot, "migration", "v2", "terminal-cas", name);
    if (!create && !existsSync(path)) return undefined;
    return secureTerminalDirectoryTree(this.dataRoot, ["migration", "v2", "terminal-cas", name], create);
  }
}

function optionalClaim(value: unknown): string | undefined {
  return value === undefined ? undefined : requiredClaim(value);
}

function requiredClaim(value: unknown): string {
  if (typeof value !== "string" || !CLAIM_PATTERN.test(value)) throw new Error("Canonical terminal CAS pending claim is malformed.");
  return value;
}

function requiredOwnerHash(value: unknown): string {
  if (typeof value !== "string" || !HASH_PATTERN.test(value)) throw new Error("Canonical terminal CAS pending owner is malformed.");
  return value;
}

function assertHash(hash: string): void {
  if (!HASH_PATTERN.test(hash)) throw new Error("Canonical terminal CAS journal hash is malformed.");
}

function isAlreadyExists(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && (error as { code?: unknown }).code === "EEXIST");
}
