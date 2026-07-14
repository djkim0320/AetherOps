import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { StorageWorkerRuntime } from "../worker/typedRuntime.js";
import { createStorageV2Repositories } from "./repositories.js";
import { migrateStorageV2Schema } from "./schema.js";

describe("durable trace pagination", () => {
  it("returns exact per-category counts and stable keyset pages", () => {
    const db = migratedDatabase();
    seedEveryCategory(db, "job-1", 3);
    seedEveryCategory(db, "other-job", 1);
    const trace = createStorageV2Repositories({ appDb: db }).trace;

    expect(trace.summaryJob("job-1")).toEqual({
      jobId: "job-1",
      counts: {
        llmInvocations: 3,
        toolDecisions: 3,
        toolAttempts: 3,
        codexCliExecutions: 3,
        outputs: 3,
        networkAudits: 3
      },
      total: 18
    });

    const first = trace.pageJob("job-1", "toolAttempts", undefined, 2);
    expect(first).toMatchObject({
      category: "toolAttempts",
      order: "newest_first",
      total: 3,
      truncated: true,
      items: [{ id: "job-1-attempt-002" }, { id: "job-1-attempt-001" }]
    });
    expect(first.nextCursor).toEqual(expect.any(String));
    expect(first.nextCursor).not.toContain("job-1-attempt-001");
    const adaptiveContinuation = trace.pageJob("job-1", "toolAttempts", first.itemCursors[0], 2);
    expect(adaptiveContinuation.items.map((item) => item.id)).toEqual(["job-1-attempt-001", "job-1-attempt-000"]);

    const second = trace.pageJob("job-1", "toolAttempts", first.nextCursor, 2);
    expect(second).toMatchObject({
      category: "toolAttempts",
      total: 3,
      truncated: false,
      items: [{ id: "job-1-attempt-000" }]
    });
    expect(second.nextCursor).toBeUndefined();
    db.close();
  });

  it("caps pages at 200 without silently dropping the remainder", () => {
    const db = migratedDatabase();
    seedToolAttempts(db, "large-job", 205);
    const trace = createStorageV2Repositories({ appDb: db }).trace;

    const first = trace.pageJob("large-job", "toolAttempts", undefined, 10_000);
    expect(first.items).toHaveLength(200);
    expect(first).toMatchObject({ total: 205, truncated: true });
    expect(first.nextCursor).toEqual(expect.any(String));

    const second = trace.pageJob("large-job", "toolAttempts", first.nextCursor, 10_000);
    expect(second.items).toHaveLength(5);
    expect(second).toMatchObject({ total: 205, truncated: false });
    expect(new Set([...first.items, ...second.items].map((item) => item.id)).size).toBe(205);
    db.close();
  });

  it("rejects malformed and cross-category cursors", () => {
    const db = migratedDatabase();
    seedEveryCategory(db, "job-1", 2);
    const trace = createStorageV2Repositories({ appDb: db }).trace;
    const page = trace.pageJob("job-1", "llmInvocations", undefined, 1);

    expect(() => trace.pageJob("job-1", "toolDecisions", page.nextCursor, 1)).toThrow(/cursor/i);
    expect(() => trace.pageJob("job-1", "llmInvocations", "not-a-cursor", 1)).toThrow(/cursor/i);
    const cursorPayload = JSON.parse(Buffer.from(page.nextCursor!, "base64url").toString("utf8")) as Record<string, unknown>;
    const forgedCursor = Buffer.from(JSON.stringify({ ...cursorPayload, id: "nonexistent-anchor" }), "utf8").toString("base64url");
    expect(() => trace.pageJob("job-1", "llmInvocations", forgedCursor, 1)).toThrow(/cursor/i);
    db.close();
  });

  it("uses the queued-at keyset index for attempt pages", () => {
    const db = migratedDatabase();
    const details = (
      db
        .prepare(
          `explain query plan select * from tool_attempts
           where job_id=? and (queued_at < ? or (queued_at = ? and id < ?))
           order by queued_at desc, id desc limit ?`
        )
        .all("job-1", "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z", "attempt-1", 201) as Array<{ detail: string }>
    )
      .map((row) => row.detail)
      .join(" ");

    expect(details).toContain("idx_tool_attempts_job_queued");
    expect(details).not.toContain("USE TEMP B-TREE");
    db.close();
  });

  it("dispatches summary and page commands through the storage worker", () => {
    const root = mkdtempSync(join(tmpdir(), "aetherops-trace-page-"));
    const databasePath = join(root, "storage.sqlite");
    const db = migratedDatabase(databasePath);
    seedEveryCategory(db, "job-worker", 2);
    db.close();
    const runtime = new StorageWorkerRuntime({ appDbPath: databasePath, vectorDbPath: databasePath, ontologyDbPath: databasePath });

    try {
      expect(runtime.handle({ name: "trace.summaryJob", jobId: "job-worker" })).toMatchObject({ total: 12 });
      expect(runtime.handle({ name: "trace.pageJob", jobId: "job-worker", category: "outputs", limit: 1 })).toMatchObject({
        category: "outputs",
        total: 2,
        truncated: true,
        items: [{ id: "job-worker-output-001" }]
      });
    } finally {
      runtime.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});

function migratedDatabase(path = ":memory:"): DatabaseSync {
  const db = new DatabaseSync(path);
  migrateStorageV2Schema(db);
  return db;
}

function seedEveryCategory(db: DatabaseSync, jobId: string, count: number): void {
  seedJob(db, jobId);
  seedLlmInvocations(db, jobId, count);
  seedToolDecisions(db, jobId, count);
  seedToolAttempts(db, jobId, count);
  seedCodexExecutions(db, jobId, count);
  seedOutputs(db, jobId, count);
  seedNetworkAudits(db, jobId, count);
}

function seedLlmInvocations(db: DatabaseSync, jobId: string, count: number): void {
  seedJob(db, jobId);
  const insert = db.prepare(
    `insert into llm_invocations
     (id,project_id,job_id,model,reasoning_effort,prompt_version,schema_version,prompt_hash,response_hash,repair_count,status,started_at,completed_at)
     values (?,?,?,?,?,?,?,?,?,0,'completed',?,?)`
  );
  for (let index = 0; index < count; index += 1) {
    const startedAt = time(index);
    insert.run(
      id(jobId, "llm", index),
      "project-1",
      jobId,
      "gpt-5.6-sol",
      "high",
      "planner-v2",
      "2",
      hash(jobId, "prompt", index),
      hash(jobId, "response", index),
      startedAt,
      startedAt
    );
  }
}

function seedToolDecisions(db: DatabaseSync, jobId: string, count: number): void {
  seedJob(db, jobId);
  const insert = db.prepare(
    `insert or ignore into tool_decisions
     (id,project_id,job_id,tool_name,purpose,expected_outcome,raw_selection,user_pinned,policy_status,created_at)
     values (?,?,?,'WebFetchTool','purpose','outcome','{}',0,'accepted',?)`
  );
  for (let index = 0; index < count; index += 1) insert.run(id(jobId, "decision", index), "project-1", jobId, time(index));
}

function seedToolAttempts(db: DatabaseSync, jobId: string, count: number): void {
  seedJob(db, jobId);
  seedToolDecisions(db, jobId, count);
  const insert = db.prepare(
    `insert into tool_attempts
     (id,project_id,job_id,decision_id,ordinal,status,input_hash,depends_on_attempt_ids,queued_at,started_at)
     values (?,?,?,?,?,'running',?,'[]',?,?)`
  );
  const complete = db.prepare(
    `update tool_attempts
     set status='completed',output_hash=?,terminal_cause='completed',completed_at=?
     where id=? and status='running'`
  );
  for (let index = 0; index < count; index += 1) {
    const attemptId = id(jobId, "attempt", index);
    const occurredAt = time(index);
    insert.run(attemptId, "project-1", jobId, id(jobId, "decision", index), index, hash(jobId, "input", index), occurredAt, occurredAt);
    complete.run(hash(jobId, "output", index), occurredAt, attemptId);
  }
}

function seedCodexExecutions(db: DatabaseSync, jobId: string, count: number): void {
  const insert = db.prepare(
    `insert into codex_cli_executions
     (id,project_id,job_id,attempt_id,model,reasoning_effort,sandbox_profile,network_policy,event_count,created_at)
     values (?,?,?,?,?,'high','workspace-v1','disabled',0,?)`
  );
  for (let index = 0; index < count; index += 1) {
    insert.run(id(jobId, "codex", index), "project-1", jobId, id(jobId, "attempt", index), "gpt-5.6-sol", time(index));
  }
}

function seedOutputs(db: DatabaseSync, jobId: string, count: number): void {
  const insert = db.prepare(
    `insert into tool_output_links
     (id,project_id,job_id,attempt_id,output_kind,output_id,promoted,created_at)
     values (?,?,?,?,'artifact',?,0,?)`
  );
  for (let index = 0; index < count; index += 1) {
    insert.run(id(jobId, "output", index), "project-1", jobId, id(jobId, "attempt", index), `artifact-${index}`, time(index));
  }
}

function seedNetworkAudits(db: DatabaseSync, jobId: string, count: number): void {
  const insert = db.prepare(
    `insert into network_audits
     (id,project_id,job_id,url,redirect_chain,source_policy,policy_decision,audited_at)
     values (?,?,?,'https://example.com','[]','{}','allowed',?)`
  );
  for (let index = 0; index < count; index += 1) insert.run(id(jobId, "network", index), "project-1", jobId, time(index));
}

function id(jobId: string, category: string, index: number): string {
  return `${jobId}-${category}-${String(index).padStart(3, "0")}`;
}

function time(index: number): string {
  return `2026-01-01T00:00:${String(Math.floor(index / 2)).padStart(2, "0")}.000Z`;
}

function hash(jobId: string, category: string, index: number): string {
  return createHash("sha256").update(`${jobId}\u0000${category}\u0000${index}`).digest("hex");
}

function seedJob(db: DatabaseSync, jobId: string): void {
  const timestamp = "2026-01-01T00:00:00.000Z";
  db.prepare(
    `insert or ignore into jobs
     (id,project_id,operation,status,priority,attempt,queued_at,completed_at,created_at,updated_at,payload)
     values (?,?,'research_loop','completed',0,0,?,?,?,?,?)`
  ).run(jobId, "project-1", timestamp, timestamp, timestamp, timestamp, "{}");
}
