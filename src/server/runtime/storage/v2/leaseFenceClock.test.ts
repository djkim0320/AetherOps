import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { StorageWorkerRuntime } from "../worker/typedRuntime.js";
import { migrateStorageV2Schema } from "./schema.js";
import type { StorageClaimStartResult, StorageExpiredLeaseSweepResult } from "./types.js";

const PROJECT_ID = "project-lease-clock";
const START_MS = Date.parse("2026-07-14T00:00:00.000Z");
const START = new Date(START_MS).toISOString();
const roots: string[] = [];
const runtimes: StorageWorkerRuntime[] = [];

afterEach(() => {
  for (const runtime of runtimes.splice(0)) runtime.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("Storage Worker lease clock", () => {
  it("rejects expired canonical writes and renewal even when the caller supplies a pre-expiry timestamp", () => {
    const clock = { now: START_MS };
    const runtime = createRuntime(clock);
    const claimed = enqueueAndClaim(runtime, "job-expired");
    clock.now = START_MS + 2_000;

    expectLeaseLost(() =>
      runtime.handle({
        name: "canonical.commitPlan",
        input: {
          fence: claimed.fence,
          occurredAt: START,
          owner: { projectId: PROJECT_ID, runId: "run-expired", jobId: claimed.job.id },
          finalState: { revision: 0, stateHash: "a".repeat(64) },
          exactReplay: true,
          revisions: []
        }
      })
    );
    expectLeaseLost(() =>
      runtime.handle({
        name: "job.renewLease",
        fence: claimed.fence,
        leaseExpiresAt: new Date(START_MS + 5_000).toISOString(),
        now: new Date(START_MS + 500).toISOString()
      })
    );
  });

  it("uses caller time only for audit fields when sweeping expired leases", () => {
    const clock = { now: START_MS };
    const runtime = createRuntime(clock);
    const claimed = enqueueAndClaim(runtime, "job-sweep");

    const early = runtime.handle({
      name: "job.markInterruptedExpiredLeases",
      now: new Date(START_MS + 10_000).toISOString()
    }) as StorageExpiredLeaseSweepResult;
    expect(early.jobs).toEqual([]);
    expect(runtime.handle({ name: "job.get", jobId: claimed.job.id })).toMatchObject({ status: "running" });

    clock.now = START_MS + 2_000;
    const expired = runtime.handle({
      name: "job.markInterruptedExpiredLeases",
      now: new Date(START_MS + 500).toISOString()
    }) as StorageExpiredLeaseSweepResult;
    expect(expired.jobs).toHaveLength(1);
    expect(expired.jobs[0]).toMatchObject({ id: claimed.job.id, status: "interrupted" });
  });
});

function createRuntime(clock: { now: number }): StorageWorkerRuntime {
  const root = mkdtempSync(join(tmpdir(), "aetherops-lease-clock-"));
  roots.push(root);
  const path = join(root, "storage.sqlite");
  prepareDatabase(path);
  const runtime = new StorageWorkerRuntime({ appDbPath: path, vectorDbPath: path, ontologyDbPath: path, requireFts5: true }, { leaseClock: () => clock.now });
  runtimes.push(runtime);
  return runtime;
}

function enqueueAndClaim(runtime: StorageWorkerRuntime, jobId: string): StorageClaimStartResult {
  runtime.handle({
    name: "job.enqueue",
    job: { id: jobId, projectId: PROJECT_ID, operation: "research_loop", createdAt: START, queuedAt: START, payload: { projectRevision: 1 } }
  });
  const claimed = runtime.handle({
    name: "job.claimAndStart",
    options: {
      projectId: PROJECT_ID,
      leaseOwner: "worker-lease-clock",
      leaseExpiresAt: new Date(START_MS + 1_000).toISOString(),
      now: START
    }
  }) as StorageClaimStartResult | undefined;
  if (!claimed) throw new Error(`Expected lease-clock job claim: ${jobId}`);
  return claimed;
}

function expectLeaseLost(work: () => unknown): void {
  try {
    work();
    throw new Error("Expected the Storage Worker to reject an expired lease.");
  } catch (error) {
    expect(error).toMatchObject({ name: "LeaseLostError", code: "LEASE_LOST" });
  }
}

function prepareDatabase(path: string): void {
  const db = new DatabaseSync(path);
  try {
    migrateStorageV2Schema(db);
    db.prepare(
      `insert into projects_v2 (id,short_id,project_root,topic,status,created_at,updated_at,data)
       values (?,?,?,?,?,?,?,?)`
    ).run(
      PROJECT_ID,
      "leaseclock",
      "lease-clock-root",
      "lease clock",
      "active",
      START,
      START,
      JSON.stringify({
        id: PROJECT_ID,
        projectRoot: "lease-clock-root",
        topic: "lease clock",
        status: "active",
        createdAt: START,
        updatedAt: START
      })
    );
  } finally {
    db.close();
  }
}
