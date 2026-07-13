import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { migrateStorageV2Schema } from "../v2/schema.js";
import { StorageWorkerRuntime } from "./typedRuntime.js";

describe("storage runtime diagnostics", () => {
  it("measures actual atomic transactions and trace reads with an injected clock", () => {
    const root = mkdtempSync(join(tmpdir(), "aetherops-storage-metrics-"));
    const databasePath = join(root, "storage.sqlite");
    const db = new DatabaseSync(databasePath);
    migrateStorageV2Schema(db);
    seedOutputs(db);
    db.close();
    const ticks = [100, 105, 200, 203, 300, 307];
    const runtime = new StorageWorkerRuntime(
      { appDbPath: databasePath, vectorDbPath: databasePath, ontologyDbPath: databasePath },
      { now: () => ticks.shift() ?? 999 }
    );

    try {
      runtime.handle({ name: "job.enqueue", job: { id: "job-queued", projectId: "project-1", operation: "chat_reply", payload: { projectRevision: 1 } } });
      runtime.handle({ name: "trace.summaryJob", jobId: "job-trace" });
      runtime.handle({ name: "trace.pageJob", jobId: "job-trace", category: "outputs", limit: 2 });

      expect(runtime.handle({ name: "diagnostics.storage" })).toEqual({
        traceQueries: {
          queryCount: 2,
          totalDurationMs: 10,
          maxDurationMs: 7,
          lastDurationMs: 7,
          totalRows: 3,
          maxRows: 2,
          lastRows: 2
        },
        storageTransactions: {
          transactionCount: 1,
          totalDurationMs: 5,
          maxDurationMs: 5,
          lastDurationMs: 5
        }
      });
      expect(runtime.handle({ name: "diagnostics.storage" })).toEqual(runtime.handle({ name: "diagnostics.storage" }));
      expect(ticks).toEqual([]);
    } finally {
      runtime.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});

function seedOutputs(db: DatabaseSync): void {
  const insert = db.prepare(
    `insert into tool_output_links
     (id,project_id,job_id,attempt_id,output_kind,output_id,promoted,created_at)
     values (?,?,?,?,'artifact',?,0,?)`
  );
  for (let index = 0; index < 2; index += 1) {
    insert.run(`output-${index}`, "project-1", "job-trace", `attempt-${index}`, `artifact-${index}`, `2026-07-14T00:00:0${index}.000Z`);
  }
}
