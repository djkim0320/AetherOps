import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { createStorageWorkerClient, type StorageWorkerClient } from "../runtime/storage/worker/typedRuntime.js";
import type { StorageEnqueueJobResult } from "../runtime/storage/v2/jobAtomicTypes.js";
import { migrateStorageV2Schema } from "../runtime/storage/v2/schema.js";
import { DurableJobTraceRuntime } from "./durableJobTraceRuntime.js";

const roots: string[] = [];
const clients: StorageWorkerClient[] = [];
const traces: DurableJobTraceRuntime[] = [];

afterEach(async () => {
  for (const trace of traces.splice(0)) trace.close();
  await Promise.all(clients.splice(0).map((client) => client.close()));
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("durable project snapshot worker facade", () => {
  it("commits through the real worker, reads the revision, and publishes only the stored event", async () => {
    const fixture = createFixture();
    const published: number[] = [];
    fixture.trace.subscribe((event) => published.push(event.id));
    expect(await fixture.trace.getProjectRevision("project-worker")).toBeUndefined();

    const result = await fixture.trace.commitProjectSnapshot(snapshotInput(fixture.root));

    expect(result).toMatchObject({ projectRevision: 1, exactReplay: false, event: { projectId: "project-worker", projectRevision: 1 } });
    expect(result.event.data).toEqual({ snapshotVersion: 1, reason: "project_updated" });
    expect(published).toEqual([result.event.id]);
    expect(await fixture.trace.getProjectRevision("project-worker")).toBe(1);
    expect(await fixture.trace.eventsAfter("project-worker")).toEqual([result.event]);
  });

  it("exposes the exact enqueue receipt lookup as a typed base worker command", async () => {
    const fixture = createFixture();
    await fixture.trace.commitProjectSnapshot(snapshotInput(fixture.root));
    const enqueued = await fixture.client.request<StorageEnqueueJobResult>({
      name: "job.enqueue",
      job: {
        id: "job-worker-receipt",
        projectId: "project-worker",
        operation: "chat_reply",
        idempotencyKey: "worker-receipt-key",
        requestHash: "worker-receipt-hash",
        expectedProjectRevision: 1,
        payload: { projectRevision: 1 }
      }
    });

    const replay = await fixture.client.request<StorageEnqueueJobResult | undefined>({
      name: "job.lookupEnqueueReceipt",
      projectId: "project-worker",
      idempotencyKey: "worker-receipt-key",
      requestHash: "worker-receipt-hash"
    });
    expect(replay).toEqual(enqueued);
  });
});

function createFixture(): { root: string; client: StorageWorkerClient; trace: DurableJobTraceRuntime } {
  const root = mkdtempSync(join(tmpdir(), "aetherops-project-snapshot-worker-"));
  roots.push(root);
  const databasePath = join(root, "storage.sqlite");
  const db = new DatabaseSync(databasePath);
  migrateStorageV2Schema(db, { requireFts5: true });
  db.close();
  mkdirSync(join(root, "project"));
  const client = createStorageWorkerClient({
    appDbPath: databasePath,
    vectorDbPath: databasePath,
    ontologyDbPath: databasePath,
    requireFts5: true
  });
  clients.push(client);
  const trace = new DurableJobTraceRuntime(client);
  traces.push(trace);
  return { root, client, trace };
}

function snapshotInput(root: string) {
  return {
    project: {
      id: "project-worker",
      projectRoot: join(root, "project"),
      topic: "Worker snapshot",
      status: "active",
      createdAt: "2026-07-16T02:00:00.000Z",
      updatedAt: "2026-07-16T02:00:00.000Z"
    },
    expectedProjectRevision: 0,
    eventId: "snapshot-worker-created",
    snapshotHash: "a".repeat(64),
    occurredAt: "2026-07-16T02:00:00.000Z",
    reason: "project_updated" as const
  };
}
