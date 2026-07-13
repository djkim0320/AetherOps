import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { migrateStorageV2Schema } from "./schema.js";

describe("durable job migration compatibility", () => {
  it("does not interrupt active work when an already-installed migration is checked again", () => {
    const db = new DatabaseSync(":memory:");
    migrateStorageV2Schema(db);
    db.prepare(
      `insert into jobs
       (id,project_id,operation,status,priority,attempt,lease_generation,lease_owner,lease_expires_at,queued_at,created_at,updated_at,payload)
       values ('job-active','project-active','chat_reply','running',0,1,1,'worker-current','2026-07-14T01:00:00.000Z',
       '2026-07-14T00:00:00.000Z','2026-07-14T00:00:00.000Z','2026-07-14T00:01:00.000Z','{}')`
    ).run();

    migrateStorageV2Schema(db);

    expect(db.prepare("select status,lease_owner from jobs where id='job-active'").get()).toEqual({ status: "running", lease_owner: "worker-current" });
    db.close();
  });

  it("interrupts stale active rows before reinstalling the one-active-project guard", () => {
    const db = new DatabaseSync(":memory:");
    migrateStorageV2Schema(db);
    db.exec("drop index idx_jobs_one_active_project; delete from schema_migrations where version=4");
    const insert = db.prepare(
      `insert into jobs
       (id,project_id,operation,status,priority,attempt,lease_generation,lease_owner,lease_expires_at,queued_at,created_at,updated_at,payload)
       values (?,?, 'chat_reply', ?,0,1,1,?,?,?, ?,?,'{}')`
    );
    insert.run(
      "job-a",
      "project-duplicate",
      "running",
      "worker-a",
      "2026-07-14T01:00:00.000Z",
      "2026-07-14T00:00:00.000Z",
      "2026-07-14T00:00:00.000Z",
      "2026-07-14T00:01:00.000Z"
    );
    insert.run(
      "job-b",
      "project-duplicate",
      "pause_requested",
      "worker-b",
      "2026-07-14T01:00:00.000Z",
      "2026-07-14T00:00:01.000Z",
      "2026-07-14T00:00:01.000Z",
      "2026-07-14T00:01:01.000Z"
    );

    migrateStorageV2Schema(db);

    expect(db.prepare("select id,status,lease_owner,lease_expires_at,error from jobs order by id").all()).toEqual([
      { id: "job-a", status: "interrupted", lease_owner: null, lease_expires_at: null, error: "migration_active_job_interrupted" },
      { id: "job-b", status: "interrupted", lease_owner: null, lease_expires_at: null, error: "migration_active_job_interrupted" }
    ]);
    expect(db.prepare("pragma index_list(jobs)").all()).toContainEqual(expect.objectContaining({ name: "idx_jobs_one_active_project", unique: 1 }));
    db.close();
  });
});
