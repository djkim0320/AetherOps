import { createHash } from "node:crypto";
import { chmodSync, mkdtempSync, closeSync, existsSync, mkdirSync, openSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Worker } from "node:worker_threads";
import { afterEach, describe, expect, it } from "vitest";
import { TerminalAttestedLeaseStore, type TerminalAttestedLeaseSource } from "./terminalAttestedLeaseStore.js";
import { TerminalCasStore } from "./terminalCasStore.js";

const roots: string[] = [];
const OWNER = { projectId: "project-lease", runId: "run-lease", jobId: "job-lease" } as const;

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("terminal content-addressed storage", () => {
  it("serves bounded verified lease chunks and removes the lease on release", () => {
    const root = temporaryRoot("owned-readback");
    const store = new TerminalCasStore(root);
    const leases = new TerminalAttestedLeaseStore(root, store);
    const source = leaseSource(store, "attested consumer bytes");
    const lease = leases.create(OWNER, source);
    expect(lease).not.toHaveProperty("materializedPath");
    const first = leases.read({ owner: OWNER, leaseId: lease.leaseId, offset: 0, maximumBytes: 8 });
    expect(first.integrityVerified).toBe(false);
    expect(() => leases.read({ owner: OWNER, leaseId: lease.leaseId, offset: 0, maximumBytes: 8 })).toThrow(/sequential/i);
    const second = leases.read({ owner: OWNER, leaseId: lease.leaseId, offset: first.nextOffset, maximumBytes: 1024 });
    expect(Buffer.concat([Buffer.from(first.bytes), Buffer.from(second.bytes)]).toString("utf8")).toBe("attested consumer bytes");
    expect(second.done).toBe(true);
    expect(second.integrityVerified).toBe(true);
    expect(leases.release({ owner: OWNER, leaseId: lease.leaseId })).toEqual({ leaseId: lease.leaseId, released: true });
    expect(() => leases.read({ owner: OWNER, leaseId: lease.leaseId, offset: 0, maximumBytes: 1 })).toThrow(/unavailable/i);
  });

  it("invalidates and removes a lease whose destination bytes were altered", () => {
    const root = temporaryRoot("lease-tamper");
    const store = new TerminalCasStore(root);
    const leases = new TerminalAttestedLeaseStore(root, store);
    const lease = leases.create(OWNER, leaseSource(store, "immutable lease bytes"));
    const payload = findNamedFile(join(root, "staging", "terminal-attested-leases"), "payload");
    if (process.platform !== "win32") chmodSync(payload, 0o600);
    writeFileSync(payload, "altered lease bytes", "utf8");
    expect(() => leases.read({ owner: OWNER, leaseId: lease.leaseId, offset: 0, maximumBytes: 1024 })).toThrow(/immutable readback/i);
    expect(existsSync(payload)).toBe(false);
  });

  it("cleans expired active leases and bounded prior-worker partial state", () => {
    const root = temporaryRoot("lease-cleanup");
    const store = new TerminalCasStore(root);
    let now = 100;
    const leases = new TerminalAttestedLeaseStore(root, store, { clock: () => now, leaseTtlMs: 10 });
    const expired = leases.create(OWNER, leaseSource(store, "expired lease"));
    now = 111;
    const active = leases.create(OWNER, leaseSource(store, "active lease"));
    expect(() => leases.read({ owner: OWNER, leaseId: expired.leaseId, offset: 0, maximumBytes: 10 })).toThrow(/unavailable/i);
    expect(leases.read({ owner: OWNER, leaseId: active.leaseId, offset: 0, maximumBytes: 1024 }).done).toBe(true);

    const staleRoot = join(root, "staging", "terminal-attested-leases");
    leases.close();
    const partial = join(staleRoot, "aa", "a".repeat(64), "terminal_lease_" + "b".repeat(32), "payload.partial");
    const priorPayload = join(staleRoot, "cc", "c".repeat(64), "terminal_lease_" + "d".repeat(32), "payload");
    mkdirSync(dirname(partial), { recursive: true });
    mkdirSync(dirname(priorPayload), { recursive: true });
    writeFileSync(partial, "interrupted", "utf8");
    writeFileSync(priorPayload, "expired prior-worker lease", "utf8");
    new TerminalAttestedLeaseStore(root, store);
    expect(existsSync(staleRoot)).toBe(false);
  });

  it("rejects a lease-root junction without deleting or writing external files", () => {
    const root = temporaryRoot("lease-junction");
    const external = temporaryRoot("lease-junction-external");
    const leaseRoot = join(root, "staging", "terminal-attested-leases");
    mkdirSync(dirname(leaseRoot), { recursive: true });
    directoryLink(external, leaseRoot);
    expect(() => new TerminalAttestedLeaseStore(root, new TerminalCasStore(root))).toThrow(/regular directory|escapes/i);
    expect(readdirSync(external)).toEqual([]);
  });

  it("publishes bounded content atomically, verifies it, and cleans partial or orphaned objects", () => {
    const root = temporaryRoot("lifecycle");
    const store = new TerminalCasStore(root);
    const object = store.materializeBytes(Buffer.from("canonical terminal bytes", "utf8"));
    const path = join(root, "migration", "v2", ...object.casLocator.split("/"));
    expect(existsSync(path)).toBe(true);
    expect(() => store.verify(object)).not.toThrow();
    expect(() => store.materializeBytes(Buffer.alloc(17), 16)).toThrow(/bounded byte limit/i);

    const temporary = join(root, "migration", "v2", "terminal-cas", "tmp", "interrupted.partial");
    const orphanHash = "f".repeat(64);
    const orphan = join(root, "migration", "v2", "terminal-cas", "sha256", "ff", orphanHash);
    mkdirSync(dirname(temporary), { recursive: true });
    mkdirSync(dirname(orphan), { recursive: true });
    writeFileSync(temporary, "partial", "utf8");
    writeFileSync(orphan, "orphan", "utf8");
    expect(store.cleanup(new Set([object.casLocator]))).toEqual({ removedTemporary: 2, removedOrphaned: 1, complete: true });
    expect(existsSync(path)).toBe(true);
    expect(existsSync(temporary)).toBe(false);
    expect(existsSync(orphan)).toBe(false);
  });

  it("fails closed when an actual source file mutates during bounded streaming materialization", async () => {
    const root = temporaryRoot("concurrent-mutation");
    const source = join(root, "source.bin");
    writeFileSync(source, Buffer.alloc(64 * 1024 * 1024, 0x5a));
    const stop = new SharedArrayBuffer(4);
    const mutator = new Worker(
      `
        const { parentPort, workerData } = require('node:worker_threads');
        const fs = require('node:fs');
        const signal = new Int32Array(workerData.stop);
        const fd = fs.openSync(workerData.path, 'r+');
        let value = 0;
        fs.writeSync(fd, Buffer.from([value++]), 0, 1, 0);
        fs.fsyncSync(fd);
        parentPort.postMessage('ready');
        while (Atomics.load(signal, 0) === 0) {
          fs.writeSync(fd, Buffer.from([value++ & 255]), 0, 1, 0);
          fs.fsyncSync(fd);
        }
        fs.closeSync(fd);
      `,
      { eval: true, workerData: { path: source, stop } }
    );
    await new Promise<void>((resolve, reject) => {
      mutator.once("message", () => resolve());
      mutator.once("error", reject);
    });
    const fd = openSync(source, "r");
    try {
      expect(() => new TerminalCasStore(root).materializeOpenFile(fd)).toThrow(/changed during materialization/i);
    } finally {
      closeSync(fd);
      Atomics.store(new Int32Array(stop), 0, 1);
      Atomics.notify(new Int32Array(stop), 0);
      await mutator.terminate();
    }
  });

  it("rejects a content-hash parent junction before any bytes reach the external directory", () => {
    const root = temporaryRoot("hash-junction");
    const external = temporaryRoot("hash-junction-external");
    const bytes = Buffer.from("junction-confined terminal bytes", "utf8");
    const hash = createHash("sha256").update(bytes).digest("hex");
    const prefix = join(root, "migration", "v2", "terminal-cas", "sha256", hash.slice(0, 2));
    mkdirSync(dirname(prefix), { recursive: true });
    directoryLink(external, prefix);

    expect(() => new TerminalCasStore(root).materializeBytes(bytes)).toThrow(/regular directory|escapes/i);
    expect(readdirSync(external)).toEqual([]);
  });

  it("rejects temporary and journal directory junctions without writing outside the data root", () => {
    const temporaryRootPath = temporaryRoot("temporary-junction");
    const temporaryExternal = temporaryRoot("temporary-junction-external");
    const temporary = join(temporaryRootPath, "migration", "v2", "terminal-cas", "tmp");
    mkdirSync(dirname(temporary), { recursive: true });
    directoryLink(temporaryExternal, temporary);
    expect(() => new TerminalCasStore(temporaryRootPath).materializeBytes(Buffer.from("temporary", "utf8"))).toThrow(/regular directory|escapes/i);
    expect(readdirSync(temporaryExternal)).toEqual([]);

    const journalRoot = temporaryRoot("journal-junction");
    const journalExternal = temporaryRoot("journal-junction-external");
    const journal = join(journalRoot, "migration", "v2", "terminal-cas", "journal");
    mkdirSync(dirname(journal), { recursive: true });
    directoryLink(journalExternal, journal);
    expect(() => new TerminalCasStore(journalRoot).materializeBytes(Buffer.from("journal", "utf8"))).toThrow(/regular directory|escapes/i);
    expect(readdirSync(journalExternal)).toEqual([]);
  });
});

function directoryLink(target: string, path: string): void {
  symlinkSync(target, path, process.platform === "win32" ? "junction" : "dir");
}

function leaseSource(store: TerminalCasStore, content: string): TerminalAttestedLeaseSource {
  const object = store.materializeBytes(Buffer.from(content, "utf8"));
  return {
    ...object,
    attestationId: `attestation-${createHash("sha256").update(content).digest("hex")}`,
    subjectKind: "artifact",
    subjectId: `artifact-${createHash("sha256").update(content).digest("hex")}`,
    contentHash: object.casHash
  };
}

function findNamedFile(root: string, name: string): string {
  const pending = [root];
  while (pending.length) {
    const directory = pending.pop()!;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) pending.push(path);
      else if (entry.isFile() && entry.name === name) return path;
    }
  }
  throw new Error(`Missing test file: ${name}`);
}

function temporaryRoot(label: string): string {
  const root = mkdtempSync(join(tmpdir(), `aetherops-terminal-cas-${label}-`));
  roots.push(root);
  return root;
}
