import { createHash } from "node:crypto";
import { chmodSync, mkdtempSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Worker } from "node:worker_threads";
import { afterEach, describe, expect, it } from "vitest";
import { TerminalAttestedLeaseStore, type TerminalAttestedLeaseSource } from "./terminalAttestedLeaseStore.js";
import {
  TerminalCasStore,
  type StorageTerminalCasClaimOwner,
  type StorageTerminalCasObject,
  type StorageTerminalCasReferenceSource
} from "./terminalCasStore.js";

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
    expect(store.reconcile([object])).toEqual({
      verifiedReferenced: 1,
      reconciledJournals: 1,
      removedTemporary: 1,
      removedOrphaned: 1,
      complete: true
    });
    expect(existsSync(path)).toBe(true);
    expect(existsSync(temporary)).toBe(false);
    expect(existsSync(orphan)).toBe(false);
  });

  it("keeps the recovery journal and fails startup reconciliation when referenced bytes are corrupt", () => {
    const root = temporaryRoot("reconcile-corruption");
    const store = new TerminalCasStore(root);
    const object = store.materializeBytes(Buffer.from("durable bytes", "utf8"));
    const path = join(root, "migration", "v2", ...object.casLocator.split("/"));
    const journal = join(root, "migration", "v2", "terminal-cas", "journal", `${object.casHash}.pending`);
    if (process.platform !== "win32") chmodSync(path, 0o600);
    writeFileSync(path, "corrupt", "utf8");

    expect(() => store.reconcile([object])).toThrow(/readback|attestation/i);
    expect(existsSync(journal)).toBe(true);
  });

  it("streams more than 2048 unique durable references while leaving bounded cleanup resumable", () => {
    const root = temporaryRoot("large-reference-set");
    const store = new TerminalCasStore(root);
    const objects = Array.from({ length: 2_049 }, (_, index) => writeCasObject(root, `durable-object-${index}`));

    const result = store.reconcile(objects, 32);

    expect(result.verifiedReferenced).toBe(objects.length);
    expect(result.removedOrphaned).toBe(0);
    expect(result.complete).toBe(true);
    expect(() => store.verify(objects.at(-1)!)).not.toThrow();
  });

  it("accepts more than 2048 duplicate durable references without a startup limit failure", () => {
    const root = temporaryRoot("duplicate-reference-set");
    const store = new TerminalCasStore(root);
    const object = store.materializeBytes(Buffer.from("shared durable bytes", "utf8"));

    const result = store.reconcile(
      Array.from({ length: 2_049 }, () => object),
      8
    );

    expect(result.verifiedReferenced).toBe(2_049);
    expect(result.removedOrphaned).toBe(0);
  });

  it("removes bounded orphan batches across repeated reconciliation without blocking startup", () => {
    const root = temporaryRoot("bounded-orphan-cleanup");
    const store = new TerminalCasStore(root);
    const orphans = Array.from({ length: 11 }, (_, index) => writeCasObject(root, `orphan-${index}`));

    const first = store.reconcile([], 3);
    expect(first.complete).toBe(false);
    expect(first.removedOrphaned).toBeGreaterThan(0);

    let result = first;
    for (let attempt = 0; attempt < 8 && !result.complete; attempt += 1) result = store.reconcile([], 3);
    expect(result.complete).toBe(true);
    for (const orphan of orphans) expect(existsSync(join(root, "migration", "v2", ...orphan.casLocator.split("/")))).toBe(false);
  });

  it("finds a trailing orphan after thousands of referenced files while bounding mutations", () => {
    const root = temporaryRoot("referenced-before-orphan");
    const store = new TerminalCasStore(root);
    const referenced = Array.from({ length: 2_049 }, (_, index) => writeCasObject(root, `referenced-${index}`));
    const orphan = writeCasObject(root, "trailing-orphan");

    const result = store.reconcile(referenced, 1);

    expect(result.removedOrphaned).toBe(1);
    expect(result.complete).toBe(true);
    expect(existsSync(join(root, "migration", "v2", ...orphan.casLocator.split("/")))).toBe(false);
    expect(() => store.verify(referenced.at(-1)!)).not.toThrow();
  });

  it("keeps identical concurrent claims isolated when one owner aborts", () => {
    const root = temporaryRoot("concurrent-claims");
    const bytes = Buffer.from("shared uncommitted content", "utf8");
    const ownerA = claimOwner("job-a", "attempt-a", "output-a");
    const ownerB = claimOwner("job-b", "attempt-b", "output-b");
    const claimA = new TerminalCasStore(root).materializeClaimedBytes(bytes, ownerA);
    const claimB = new TerminalCasStore(root).materializeClaimedBytes(bytes, ownerB);

    const aborted = new TerminalCasStore(root).abort([{ object: claimA, owner: ownerA }], referenceSource([]));

    expect(aborted.preservedPending).toBe(1);
    expect(claimA.pendingClaimId).not.toBe(claimB.pendingClaimId);
    expect(() => new TerminalCasStore(root).verify(claimB)).not.toThrow();
    expect(() => new TerminalCasStore(root).finalizeClaims([{ object: claimB, owner: ownerB }])).not.toThrow();
  });

  it("rejects a forged cross-job pending claim owner without deleting the victim", () => {
    const root = temporaryRoot("forged-claim-owner");
    const victim = claimOwner("job-victim", "attempt-victim", "output-victim");
    const attacker = claimOwner("job-attacker", "attempt-attacker", "output-attacker");
    const object = new TerminalCasStore(root).materializeClaimedBytes(Buffer.from("victim bytes", "utf8"), victim);

    expect(() => new TerminalCasStore(root).abort([{ object, owner: attacker }], referenceSource([]))).toThrow(/ownership verification/i);
    expect(() => new TerminalCasStore(root).verify(object)).not.toThrow();
    expect(() => new TerminalCasStore(root).finalizeClaims([{ object, owner: victim }])).not.toThrow();
  });

  it("rejects duplicate pending claim identities whose owners differ before commit work", () => {
    const root = temporaryRoot("duplicate-claim-owner");
    const owner = claimOwner("job-duplicate", "attempt-owner", "output-owner");
    const conflictingOwner = claimOwner("job-duplicate", "attempt-owner", "output-conflict");
    const store = new TerminalCasStore(root);
    const object = store.materializeClaimedBytes(Buffer.from("single owner bytes", "utf8"), owner);
    let workCalls = 0;

    expect(() =>
      store.commitClaims(
        [
          { object, owner },
          { object, owner: conflictingOwner }
        ],
        referenceSource([]),
        () => {
          workCalls += 1;
          return { result: "must-not-commit", disposition: "finalize" };
        }
      )
    ).toThrow(/reused across different objects or owners/i);
    expect(workCalls).toBe(0);
    expect(() => store.finalizeClaims([{ object, owner }])).not.toThrow();
  });

  it("preserves unowned CAS bytes and never enters commit work when the claim journal is missing", () => {
    const root = temporaryRoot("missing-claim-journal");
    const owner = claimOwner("job-owner", "attempt-owner", "output-owner");
    const store = new TerminalCasStore(root);
    const object = store.materializeClaimedBytes(Buffer.from("owner-scoped bytes", "utf8"), owner);
    const journal = join(root, "migration", "v2", "terminal-cas", "journal", `${object.casHash}.${object.pendingClaimId}.pending`);
    rmSync(journal);
    let workCalls = 0;

    let failure: unknown;
    try {
      store.commitClaims([{ object, owner }], referenceSource([]), () => {
        workCalls += 1;
        return { result: "committed", disposition: "finalize" };
      });
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({ stage: "integrity", cause: expect.objectContaining({ message: expect.stringMatching(/durable pending claim journal/i) }) });
    expect(workCalls).toBe(0);
    expect(store.abort([{ object, owner }], referenceSource([]))).toMatchObject({ deferredUnowned: 1, removedObjects: 0 });
    expect(() => store.verify(object)).not.toThrow();
  });

  it("rejects corrupted claimed bytes before entering the durable commit callback", () => {
    const root = temporaryRoot("claimed-precommit-integrity");
    const owner = claimOwner("job-integrity", "attempt-integrity", "output-integrity");
    const store = new TerminalCasStore(root);
    const object = store.materializeClaimedBytes(Buffer.from("trusted before commit", "utf8"), owner);
    const path = join(root, "migration", "v2", ...object.casLocator.split("/"));
    if (process.platform !== "win32") chmodSync(path, 0o600);
    writeFileSync(path, "tampered before commit", "utf8");
    let workCalls = 0;

    expect(() =>
      store.commitClaims([{ object, owner }], referenceSource([]), () => {
        workCalls += 1;
        return { result: "must-not-commit", disposition: "finalize" };
      })
    ).toThrow(/integrity verification failed/i);
    expect(workCalls).toBe(0);
  });

  it("cleans only the journal it created when existing CAS bytes fail claimed or legacy readback", () => {
    for (const mode of ["claimed", "legacy"] as const) {
      const root = temporaryRoot(`publish-readback-${mode}`);
      const bytes = Buffer.from(`expected-${mode}-bytes`, "utf8");
      const casHash = createHash("sha256").update(bytes).digest("hex");
      const destination = join(root, "migration", "v2", "terminal-cas", "sha256", casHash.slice(0, 2), casHash);
      mkdirSync(dirname(destination), { recursive: true });
      writeFileSync(destination, "pre-existing corrupt bytes", "utf8");
      const store = new TerminalCasStore(root);

      expect(() =>
        mode === "claimed"
          ? store.materializeClaimedBytes(bytes, claimOwner("job-readback", "attempt-readback", "output-readback"))
          : store.materializeBytes(bytes)
      ).toThrow(/readback/i);

      const journalRoot = join(root, "migration", "v2", "terminal-cas", "journal");
      expect(readdirSync(journalRoot)).toEqual([]);
      expect(readText(destination)).toBe("pre-existing corrupt bytes");
    }
  });

  it("recovers crashed claims and stale hash locks on restart but rejects an abnormal lock flood", () => {
    const root = temporaryRoot("claim-restart");
    const owner = claimOwner("job-crashed", "attempt-crashed", "output-crashed");
    const object = new TerminalCasStore(root).materializeClaimedBytes(Buffer.from("crashed bytes", "utf8"), owner);
    const locks = join(root, "migration", "v2", "terminal-cas", "locks");
    mkdirSync(locks, { recursive: true });
    writeFileSync(join(locks, `${object.casHash}.lock`), "", "utf8");

    expect(() => new TerminalCasStore(root).reconcile([object])).not.toThrow();
    expect(() => new TerminalCasStore(root).materializeClaimedBytes(Buffer.from("crashed bytes", "utf8"), owner)).not.toThrow();

    for (let index = 0; index < 65; index += 1) {
      writeFileSync(join(locks, `${index.toString(16).padStart(64, "0")}.lock`), "", "utf8");
    }
    expect(() => new TerminalCasStore(root).reconcile([object])).toThrow(/too many interrupted hash locks/i);
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

function readText(path: string): string {
  return Buffer.from(readFileSync(path)).toString("utf8");
}

function temporaryRoot(label: string): string {
  const root = mkdtempSync(join(tmpdir(), `aetherops-terminal-cas-${label}-`));
  roots.push(root);
  return root;
}

function writeCasObject(root: string, content: string): { casLocator: string; casHash: string; byteLength: number } {
  const bytes = Buffer.from(content, "utf8");
  const casHash = createHash("sha256").update(bytes).digest("hex");
  const casLocator = `terminal-cas/sha256/${casHash.slice(0, 2)}/${casHash}`;
  const path = join(root, "migration", "v2", ...casLocator.split("/"));
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, bytes);
  return { casLocator, casHash, byteLength: bytes.byteLength };
}

function claimOwner(jobId: string, attemptId: string, outputId: string): StorageTerminalCasClaimOwner {
  return { projectId: "project-claims", jobId, attemptId, outputKind: "artifact", outputId };
}

function referenceSource(objects: readonly StorageTerminalCasObject[]): StorageTerminalCasReferenceSource {
  return {
    iterate: () => objects.values(),
    find(casLocator) {
      return objects.find((object) => object.casLocator === casLocator);
    }
  };
}
