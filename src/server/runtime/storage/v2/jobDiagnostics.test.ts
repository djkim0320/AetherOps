import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { StorageWorkerRuntime } from "../worker/typedRuntime.js";
import { JOB_QUEUE_DIAGNOSTICS_SQL } from "./jobRepository.js";
import { createStorageV2Repositories } from "./repositories.js";
import { migrateStorageV2Schema } from "./schema.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("durable queue diagnostics", () => {
  it("returns bounded per-project depth with exact global window totals", () => {
    const db = migratedDatabase();
    const jobs = createStorageV2Repositories({ appDb: db }).jobs;
    expect(jobs.queueDiagnostics()).toEqual({ projects: [], totalDepth: 0, totalProjects: 0, truncated: false });
    seedJob(db, "job-a-1", "project-a", "queued", "2026-07-14T00:00:00.000Z");
    seedJob(db, "job-a-2", "project-a", "queued", "2026-07-14T00:02:00.000Z");
    seedJob(db, "job-b-1", "project-b", "queued", "2026-07-14T00:03:00.000Z");
    seedJob(db, "job-c-1", "project-c", "queued", "2026-07-14T00:01:00.000Z");
    seedJob(db, "job-z-running", "project-z", "running", "2020-01-01T00:00:00.000Z");

    const result = jobs.queueDiagnostics(2);

    expect(result).toEqual({
      projects: [
        { projectId: "project-a", depth: 2, oldestQueuedAt: "2026-07-14T00:00:00.000Z" },
        { projectId: "project-b", depth: 1, oldestQueuedAt: "2026-07-14T00:03:00.000Z" }
      ],
      totalDepth: 4,
      oldestQueuedAt: "2026-07-14T00:00:00.000Z",
      totalProjects: 3,
      truncated: true
    });
    db.close();
  });

  it("uses the existing durable queue index for its grouped window query", () => {
    const db = migratedDatabase();
    const plan = (db.prepare(`explain query plan ${JOB_QUEUE_DIAGNOSTICS_SQL}`).all(100) as Array<{ detail: string }>).map((row) => row.detail).join(" ");

    expect(plan).toMatch(/(?:SEARCH|SCAN) jobs USING (?:COVERING )?INDEX idx_jobs_(?:ready|project_lane)/);
    db.close();
  });

  it("caps returned projects at 500 without hiding global totals", () => {
    const db = migratedDatabase();
    db.exec("begin immediate");
    for (let index = 0; index < 505; index += 1) {
      const suffix = String(index).padStart(3, "0");
      seedJob(db, `job-${suffix}`, `project-${suffix}`, "queued", "2026-07-14T00:00:00.000Z");
    }
    db.exec("commit");

    const jobs = createStorageV2Repositories({ appDb: db }).jobs;
    const result = jobs.queueDiagnostics(10_000);
    expect(result).toMatchObject({ totalDepth: 505, totalProjects: 505, truncated: true });
    expect(result.projects).toHaveLength(500);
    expect(() => jobs.queueDiagnostics(0)).toThrow(/positive safe integer/i);
    db.close();
  });

  it("dispatches the read-only diagnostic through the typed storage worker", () => {
    const root = mkdtempSync(join(tmpdir(), "aetherops-queue-diagnostics-"));
    roots.push(root);
    const databasePath = join(root, "storage.sqlite");
    const db = migratedDatabase(databasePath);
    seedJob(db, "job-worker", "project-worker", "queued", "2026-07-14T00:00:00.000Z");
    db.close();
    const runtime = new StorageWorkerRuntime({ appDbPath: databasePath, vectorDbPath: databasePath, ontologyDbPath: databasePath });

    try {
      expect(runtime.handle({ name: "job.queueDiagnostics" })).toEqual({
        projects: [{ projectId: "project-worker", depth: 1, oldestQueuedAt: "2026-07-14T00:00:00.000Z" }],
        totalDepth: 1,
        oldestQueuedAt: "2026-07-14T00:00:00.000Z",
        totalProjects: 1,
        truncated: false
      });
    } finally {
      runtime.close();
    }
  });
});

function migratedDatabase(path = ":memory:"): DatabaseSync {
  const db = new DatabaseSync(path);
  migrateStorageV2Schema(db);
  return db;
}

function seedJob(db: DatabaseSync, id: string, projectId: string, status: "queued" | "running", queuedAt: string): void {
  db.prepare(
    `insert into jobs
     (id,project_id,operation,status,priority,attempt,lease_generation,queued_at,created_at,updated_at,payload)
     values (?,?,?, ?,0,0,0,?,?,?,'{}')`
  ).run(id, projectId, "chat_reply", status, queuedAt, queuedAt, queuedAt);
}
