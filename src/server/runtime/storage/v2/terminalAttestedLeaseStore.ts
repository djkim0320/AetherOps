import { createHash, randomUUID, type Hash } from "node:crypto";
import { chmodSync, closeSync, existsSync, readSync, renameSync } from "node:fs";
import { join, resolve } from "node:path";
import type { StorageRunOwnership } from "./runStateTypes.js";
import { storageCanonicalHasher } from "./runStatePayloadValidator.js";
import { MAX_TERMINAL_ARTIFACT_BYTES, type StorageTerminalCasObject, TerminalCasStore } from "./terminalCasStore.js";
import {
  assertTerminalReadHandleUnchanged,
  openTerminalReadHandle,
  removeBoundedTerminalTree,
  secureTerminalDirectoryTree,
  type TerminalReadHandle
} from "./terminalCasFilesystem.js";
import {
  MAX_TERMINAL_ATTESTED_LEASE_READ_BYTES,
  type StorageTerminalAttestedLease,
  type StorageTerminalAttestedLeaseChunk,
  type StorageTerminalAttestedLeaseReadInput,
  type StorageTerminalAttestedLeaseReleaseInput,
  type StorageTerminalAttestedLeaseReleaseResult
} from "./terminalAttestedReadbackTypes.js";

const HASH_PATTERN = /^[a-f0-9]{64}$/;
const LEASE_ID_PATTERN = /^terminal_lease_[a-f0-9]{32}$/;
const DEFAULT_LEASE_TTL_MS = 5 * 60_000;
const DEFAULT_MAXIMUM_ACTIVE_LEASES = 128;
const DEFAULT_STARTUP_CLEANUP_ENTRIES = 4_096;
const LEASE_REMOVE_ENTRIES = 16;

export interface TerminalAttestedLeaseSource extends StorageTerminalCasObject {
  attestationId: string;
  subjectKind: "artifact" | "evidence";
  subjectId: string;
  contentHash: string;
}

export interface TerminalAttestedLeaseStoreOptions {
  clock?: () => number;
  leaseTtlMs?: number;
  maximumActiveLeases?: number;
  startupCleanupEntries?: number;
}

interface LeaseEntry extends StorageTerminalAttestedLease {
  owner: StorageRunOwnership;
  directory: string;
  payloadPath: string;
  expiresAtMs: number;
  readFd: number;
  readStat: TerminalReadHandle["stat"];
  readHash: Hash;
  nextOffset: number;
  readCompleted: boolean;
}

export class TerminalAttestedLeaseStore {
  private readonly dataRoot?: string;
  private readonly clock: () => number;
  private readonly leaseTtlMs: number;
  private readonly maximumActiveLeases: number;
  private readonly leases = new Map<string, LeaseEntry>();

  constructor(
    dataRoot: string | undefined,
    private readonly cas: TerminalCasStore,
    options: TerminalAttestedLeaseStoreOptions = {}
  ) {
    this.dataRoot = dataRoot ? resolve(dataRoot) : undefined;
    this.clock = options.clock ?? Date.now;
    this.leaseTtlMs = positiveInteger(options.leaseTtlMs ?? DEFAULT_LEASE_TTL_MS, "TTL");
    this.maximumActiveLeases = positiveInteger(options.maximumActiveLeases ?? DEFAULT_MAXIMUM_ACTIVE_LEASES, "active-lease limit");
    const cleanupEntries = positiveInteger(options.startupCleanupEntries ?? DEFAULT_STARTUP_CLEANUP_ENTRIES, "cleanup limit");
    this.cleanupPriorWorkerLeases(cleanupEntries);
  }

  create(owner: StorageRunOwnership, source: TerminalAttestedLeaseSource): StorageTerminalAttestedLease {
    this.cleanupExpired();
    if (this.leases.size >= this.maximumActiveLeases) throw new Error("Canonical terminal lease capacity is exhausted.");
    assertSource(source);
    const now = finiteClock(this.clock());
    const leaseId = `terminal_lease_${randomUUID().replaceAll("-", "")}`;
    const ownershipHash = storageCanonicalHasher.sha256Canonical({ owner, attestationId: source.attestationId });
    const directory = this.ensureLeaseDirectory(ownershipHash, leaseId);
    const partialPath = join(directory, "payload.partial");
    const payloadPath = join(directory, "payload");
    let handle: TerminalReadHandle | undefined;
    try {
      this.cas.copyVerifiedToLeaseFile(source, partialPath, MAX_TERMINAL_ARTIFACT_BYTES);
      renameSync(partialPath, payloadPath);
      if (process.platform !== "win32") chmodSync(payloadPath, 0o400);
      handle = openTerminalReadHandle(payloadPath, source, MAX_TERMINAL_ARTIFACT_BYTES);
    } catch {
      if (handle) closeSync(handle.fd);
      this.removeDirectory(directory);
      throw new Error("Canonical terminal lease materialization failed.");
    }
    if (!handle) throw new Error("Canonical terminal lease read handle is unavailable.");
    const expiresAtMs = now + this.leaseTtlMs;
    const entry: LeaseEntry = {
      leaseId,
      attestationId: source.attestationId,
      subjectKind: source.subjectKind,
      subjectId: source.subjectId,
      contentHash: source.contentHash,
      byteLength: source.byteLength,
      expiresAt: new Date(expiresAtMs).toISOString(),
      expiresAtMs,
      owner: { ...owner },
      directory,
      payloadPath,
      readFd: handle.fd,
      readStat: handle.stat,
      readHash: createHash("sha256"),
      nextOffset: 0,
      readCompleted: false
    };
    this.leases.set(leaseId, entry);
    return publicLease(entry);
  }

  read(input: StorageTerminalAttestedLeaseReadInput): StorageTerminalAttestedLeaseChunk {
    const entry = this.requireLease(input.owner, input.leaseId);
    if (!Number.isSafeInteger(input.offset) || input.offset < 0 || input.offset > entry.byteLength) {
      throw new Error("Canonical terminal lease read offset is invalid.");
    }
    if (entry.readCompleted || input.offset !== entry.nextOffset) {
      throw new Error("Canonical terminal lease requires a single sequential read.");
    }
    if (!Number.isSafeInteger(input.maximumBytes) || input.maximumBytes < 1 || input.maximumBytes > MAX_TERMINAL_ATTESTED_LEASE_READ_BYTES) {
      throw new Error("Canonical terminal lease read exceeds its bounded chunk limit.");
    }
    const requested = Math.min(input.maximumBytes, entry.byteLength - input.offset);
    const bytes = Buffer.alloc(requested);
    try {
      const count = readSync(entry.readFd, bytes, 0, bytes.byteLength, input.offset);
      if (count !== bytes.byteLength) throw new Error("Canonical terminal lease ended before its attested size.");
      entry.readHash.update(bytes);
      entry.nextOffset += count;
      assertTerminalReadHandleUnchanged(entry.readFd, entry.readStat);
      if (entry.nextOffset === entry.byteLength) {
        if (readSync(entry.readFd, Buffer.allocUnsafe(1), 0, 1, entry.nextOffset) !== 0) {
          throw new Error("Canonical terminal lease exceeds its attested size.");
        }
        if (entry.readHash.digest("hex") !== entry.contentHash) {
          throw new Error("Canonical terminal lease hash does not match its immutable attestation.");
        }
        entry.readCompleted = true;
      }
    } catch {
      this.destroy(entry);
      throw new Error("Canonical terminal lease immutable readback failed.");
    }
    return {
      leaseId: entry.leaseId,
      offset: input.offset,
      bytes,
      nextOffset: entry.nextOffset,
      done: entry.readCompleted,
      integrityVerified: entry.readCompleted,
      contentHash: entry.contentHash,
      byteLength: entry.byteLength
    };
  }

  release(input: StorageTerminalAttestedLeaseReleaseInput): StorageTerminalAttestedLeaseReleaseResult {
    const entry = this.requireLease(input.owner, input.leaseId);
    this.destroy(entry);
    return { leaseId: entry.leaseId, released: true };
  }

  close(): void {
    for (const entry of [...this.leases.values()]) this.destroy(entry);
  }

  private requireLease(owner: StorageRunOwnership, leaseId: string): LeaseEntry {
    this.cleanupExpired();
    if (!LEASE_ID_PATTERN.test(leaseId)) throw new Error("Canonical terminal lease identity is malformed.");
    const entry = this.leases.get(leaseId);
    if (!entry || !sameOwner(entry.owner, owner)) throw new Error("Canonical terminal lease is unavailable for this owner.");
    return entry;
  }

  private cleanupExpired(): void {
    const now = finiteClock(this.clock());
    for (const entry of [...this.leases.values()]) if (entry.expiresAtMs <= now) this.destroy(entry);
  }

  private cleanupPriorWorkerLeases(maximumEntries: number): void {
    if (!this.dataRoot) return;
    const root = join(this.dataRoot, "staging", "terminal-attested-leases");
    if (!existsSync(root)) return;
    secureTerminalDirectoryTree(this.dataRoot, ["staging", "terminal-attested-leases"], false);
    removeBoundedTerminalTree(root, this.dataRoot, maximumEntries);
  }

  private ensureLeaseDirectory(ownershipHash: string, leaseId: string): string {
    if (!this.dataRoot || !HASH_PATTERN.test(ownershipHash) || !LEASE_ID_PATTERN.test(leaseId)) {
      throw new Error("Canonical terminal lease storage is unavailable or malformed.");
    }
    return secureTerminalDirectoryTree(this.dataRoot, ["staging", "terminal-attested-leases", ownershipHash.slice(0, 2), ownershipHash, leaseId], true);
  }

  private destroy(entry: LeaseEntry): void {
    this.leases.delete(entry.leaseId);
    closeSync(entry.readFd);
    this.removeDirectory(entry.directory);
  }

  private removeDirectory(directory: string): void {
    if (!this.dataRoot || !existsSync(directory)) return;
    removeBoundedTerminalTree(directory, this.dataRoot, LEASE_REMOVE_ENTRIES);
  }
}

function assertSource(source: TerminalAttestedLeaseSource): void {
  if (
    !HASH_PATTERN.test(source.contentHash) ||
    source.contentHash !== source.casHash ||
    !Number.isSafeInteger(source.byteLength) ||
    source.byteLength < 0 ||
    source.byteLength > MAX_TERMINAL_ARTIFACT_BYTES
  ) {
    throw new Error("Canonical terminal lease source is malformed.");
  }
}

function publicLease(entry: LeaseEntry): StorageTerminalAttestedLease {
  const { leaseId, attestationId, subjectKind, subjectId, contentHash, byteLength, expiresAt } = entry;
  return { leaseId, attestationId, subjectKind, subjectId, contentHash, byteLength, expiresAt };
}

function sameOwner(left: StorageRunOwnership, right: StorageRunOwnership): boolean {
  return left.projectId === right.projectId && left.runId === right.runId && left.jobId === right.jobId;
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`Canonical terminal lease ${label} is invalid.`);
  return value;
}

function finiteClock(value: number): number {
  if (!Number.isFinite(value) || value < 0) throw new Error("Canonical terminal lease clock is invalid.");
  return value;
}
