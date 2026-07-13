import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createV2Database } from "../../src/migration/sqlite.mjs";
import { copyJobs } from "../../src/migration/v2OperationalTables.mjs";
import { STORAGE_JOB_MIGRATION_CHECKSUM, STORAGE_JOB_SCHEMA_VERSION } from "../../src/server/runtime/storage/v2/jobSchema.js";

describe("operational job migration", () => {
  it("creates migration targets with the v4 fencing ledger and active-project guard", () => {
    const root = mkdtempSync(join(tmpdir(), "aetherops-migration-job-v4-"));
    const db = createV2Database(join(root, "storage.sqlite"), { schemaVersion: 2 });
    try {
      expect(db.prepare("select checksum_sha256 from schema_migrations where version=?").get(STORAGE_JOB_SCHEMA_VERSION)).toEqual({
        checksum_sha256: STORAGE_JOB_MIGRATION_CHECKSUM
      });
      expect(db.prepare("pragma index_list(jobs)").all()).toContainEqual(expect.objectContaining({ name: "idx_jobs_one_active_project", unique: 1 }));
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("preserves the complete fenced job contract without dropping policy or reasons", () => {
    const source = new DatabaseSync(":memory:");
    const target = new DatabaseSync(":memory:");
    createJobsTable(source);
    createJobsTable(target);
    source
      .prepare(
        `insert into jobs (
          id,project_id,operation,status,priority,attempt,lease_generation,idempotency_key,request_hash,
          requested_capabilities,effective_capabilities,tool_policy,blocked_reason,failure_reason,requested_by,
          lease_owner,lease_expires_at,queued_at,started_at,completed_at,created_at,updated_at,payload,result,error
        ) values (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
      )
      .run(
        "job-1",
        "project-1",
        "research_loop",
        "blocked",
        3,
        2,
        7,
        "idem-1",
        "request-hash",
        JSON.stringify({ agent: true, engineering: false, search: true }),
        JSON.stringify({ agent: true, engineering: false, search: false }),
        JSON.stringify({ allowCodexCli: false, sourceAccess: { mode: "offline" } }),
        "capability_revoked",
        null,
        "user",
        "worker-1",
        "2026-07-14T00:01:00.000Z",
        "2026-07-14T00:00:00.000Z",
        "2026-07-14T00:00:01.000Z",
        "2026-07-14T00:00:02.000Z",
        "2026-07-14T00:00:00.000Z",
        "2026-07-14T00:00:02.000Z",
        JSON.stringify({ projectRevision: 4, currentStep: "EXECUTE_TOOLS" }),
        JSON.stringify({ projectRevision: 4 }),
        "capability_revoked"
      );

    copyJobs(source, target);

    expect(target.prepare("select * from jobs where id='job-1'").get()).toMatchObject({
      lease_generation: 7,
      request_hash: "request-hash",
      requested_capabilities: JSON.stringify({ agent: true, engineering: false, search: true }),
      effective_capabilities: JSON.stringify({ agent: true, engineering: false, search: false }),
      tool_policy: JSON.stringify({ allowCodexCli: false, sourceAccess: { mode: "offline" } }),
      blocked_reason: "capability_revoked",
      failure_reason: null
    });
    source.close();
    target.close();
  });

  it("preserves IDs while interrupting every pre-migration active job in a conflicting project", () => {
    const source = new DatabaseSync(":memory:");
    const root = mkdtempSync(join(tmpdir(), "aetherops-migration-active-jobs-"));
    const target = createV2Database(join(root, "storage.sqlite"), { schemaVersion: 2 });
    createJobsTable(source);
    try {
      insertActiveJob(source, "job-running", "running", "worker-a");
      insertActiveJob(source, "job-pausing", "pause_requested", "worker-b");
      insertActiveJob(source, "job-cancelling", "cancel_requested", "worker-c");

      copyJobs(source, target);

      expect(target.prepare("select id,status,lease_owner,lease_expires_at,error from jobs order by id").all()).toEqual([
        {
          id: "job-cancelling",
          status: "interrupted",
          lease_owner: null,
          lease_expires_at: null,
          error: "migration_active_job_interrupted"
        },
        {
          id: "job-pausing",
          status: "interrupted",
          lease_owner: null,
          lease_expires_at: null,
          error: "migration_active_job_interrupted"
        },
        {
          id: "job-running",
          status: "interrupted",
          lease_owner: null,
          lease_expires_at: null,
          error: "migration_active_job_interrupted"
        }
      ]);
      expect(target.prepare("select count(*) as count from jobs").get()).toEqual({ count: 3 });
    } finally {
      source.close();
      target.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});

function createJobsTable(db: DatabaseSync): void {
  db.exec(`create table jobs (
    id text primary key, project_id text not null, operation text not null, status text not null,
    priority integer not null, attempt integer not null, lease_generation integer not null default 0,
    idempotency_key text, request_hash text, requested_capabilities text, effective_capabilities text,
    tool_policy text, blocked_reason text, failure_reason text, requested_by text, lease_owner text,
    lease_expires_at text, queued_at text not null, started_at text, completed_at text, created_at text not null,
    updated_at text not null, payload text not null, result text, error text
  )`);
}

function insertActiveJob(db: DatabaseSync, id: string, status: "running" | "pause_requested" | "cancel_requested", leaseOwner: string): void {
  db.prepare(
    `insert into jobs (
      id,project_id,operation,status,priority,attempt,lease_generation,lease_owner,lease_expires_at,
      queued_at,started_at,created_at,updated_at,payload
    ) values (?,?,?,?,0,1,1,?,?,?,?,?,?,?)`
  ).run(
    id,
    "project-conflict",
    "research_loop",
    status,
    leaseOwner,
    "2026-07-14T01:00:00.000Z",
    "2026-07-14T00:00:00.000Z",
    "2026-07-14T00:00:01.000Z",
    "2026-07-14T00:00:00.000Z",
    "2026-07-14T00:05:00.000Z",
    "{}"
  );
}
