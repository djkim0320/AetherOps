import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { migrateStorageV2Schema } from "../v2/schema.js";
import { storageTestProjectRevision, upsertStorageTestProject } from "../v2/storageWorkerTestSupport.js";
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
      upsertStorageTestProject(runtime, root, "project-1", "2026-07-14T00:00:00.000Z");
      runtime.handle({
        name: "job.enqueue",
        job: {
          id: "job-queued",
          projectId: "project-1",
          operation: "chat_reply",
          expectedProjectRevision: storageTestProjectRevision(runtime, "project-1"),
          payload: { projectRevision: 1 }
        }
      });
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
  const timestamp = "2026-07-14T00:00:00.000Z";
  db.prepare(
    `insert into jobs
     (id,project_id,operation,status,priority,attempt,queued_at,completed_at,created_at,updated_at,payload)
     values ('job-trace','project-1','research_loop','completed',0,0,?,?,?,?,?)`
  ).run(timestamp, timestamp, timestamp, timestamp, "{}");
  const decision = db.prepare(
    `insert into tool_decisions
     (id,project_id,job_id,tool_name,purpose,expected_outcome,raw_selection,user_pinned,policy_status,created_at)
     values (?,'project-1','job-trace','TestTool','Measure trace reads.','A persisted trace output.','{}',0,'accepted',?)`
  );
  const attempt = db.prepare(
    `insert into tool_attempts
     (id,project_id,job_id,decision_id,ordinal,status,input_hash,depends_on_attempt_ids,queued_at,started_at)
     values (?,'project-1','job-trace',?,?,'running',?,'[]',?,?)`
  );
  const completeAttempt = db.prepare(
    `update tool_attempts
     set status='completed',output_hash=?,terminal_cause='completed',completed_at=?
     where id=? and status='running'`
  );
  const insert = db.prepare(
    `insert into tool_output_links
     (id,project_id,job_id,attempt_id,output_kind,output_id,promoted,created_at)
     values (?,?,?,?,'artifact',?,0,?)`
  );
  for (let index = 0; index < 2; index += 1) {
    const occurredAt = `2026-07-14T00:00:0${index}.000Z`;
    decision.run(`decision-${index}`, occurredAt);
    const attemptId = `attempt-${index}`;
    attempt.run(attemptId, `decision-${index}`, index, traceHash("input", index), occurredAt, occurredAt);
    completeAttempt.run(traceHash("output", index), occurredAt, attemptId);
    insert.run(`output-${index}`, "project-1", "job-trace", `attempt-${index}`, `artifact-${index}`, occurredAt);
  }
}

function traceHash(kind: string, index: number): string {
  return createHash("sha256").update(`${kind}\u0000${index}`).digest("hex");
}
