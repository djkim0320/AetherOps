import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import {
  assertStorageRunStateV5SchemaReady,
  migrateStorageRunStateV5Schema,
  STORAGE_RUN_STATE_MIGRATION_CHECKSUM,
  STORAGE_RUN_STATE_MIGRATION_NAME,
  STORAGE_RUN_STATE_SCHEMA_VERSION
} from "./runStateSchema.js";
import { migrateStorageV2Schema } from "./schema.js";

describe("operational run-state v5 migration", () => {
  it("installs its additive ledger, immutable objects, and foreign keys idempotently", () => {
    const db = new DatabaseSync(":memory:");
    try {
      migrateStorageV2Schema(db);
      const firstSchema = schemaSql(db);
      migrateStorageRunStateV5Schema(db);
      expect(schemaSql(db)).toEqual(firstSchema);
      expect(db.prepare("select name,checksum_sha256 from schema_migrations where version=?").get(STORAGE_RUN_STATE_SCHEMA_VERSION)).toEqual({
        name: STORAGE_RUN_STATE_MIGRATION_NAME,
        checksum_sha256: STORAGE_RUN_STATE_MIGRATION_CHECKSUM
      });
      expect(db.prepare("pragma foreign_key_list(run_state_revisions)").all()).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ table: "jobs" }),
          expect.objectContaining({ table: "task_contracts" }),
          expect.objectContaining({ table: "context_packs" })
        ])
      );
      expect(db.prepare("select name from sqlite_master where type='table'").all()).toEqual(
        expect.arrayContaining([{ name: "task_contracts" }, { name: "context_packs" }, { name: "run_state_revisions" }, { name: "run_job_links" }])
      );
      expect(() => assertStorageRunStateV5SchemaReady(db)).not.toThrow();
    } finally {
      db.close();
    }
  });

  it("fails readiness for checksum drift or missing immutability objects", () => {
    const checksumDb = new DatabaseSync(":memory:");
    const triggerDb = new DatabaseSync(":memory:");
    try {
      migrateStorageV2Schema(checksumDb);
      checksumDb.prepare("update schema_migrations set checksum_sha256='invalid' where version=?").run(STORAGE_RUN_STATE_SCHEMA_VERSION);
      expect(() => assertStorageRunStateV5SchemaReady(checksumDb)).toThrow(/checksum/i);

      migrateStorageV2Schema(triggerDb);
      triggerDb.exec("drop trigger trg_run_state_revisions_no_update");
      expect(() => assertStorageRunStateV5SchemaReady(triggerDb)).toThrow(/trigger/i);
    } finally {
      checksumDb.close();
      triggerDb.close();
    }
  });

  it("binds the checksum to the normalized install SQL", () => {
    const source = readFileSync(new URL("./runStateSchema.ts", import.meta.url), "utf8");
    const anchor = source.indexOf("function installStorageRunStateV5Objects");
    const marker = "db.exec(`";
    const start = source.indexOf(marker, anchor) + marker.length;
    const end = source.indexOf("`);", start);
    const normalized = source
      .slice(start, end)
      .replace(
        /values \(5, 'operational-run-state-v5', '[a-f0-9]{64}', datetime\('now'\)\)/,
        "values (5, 'operational-run-state-v5', '<checksum>', datetime('now'))"
      );
    expect(createHash("sha256").update(normalized).digest("hex")).toBe(STORAGE_RUN_STATE_MIGRATION_CHECKSUM);
  });
});

function schemaSql(db: DatabaseSync): unknown[] {
  return db.prepare("select type,name,tbl_name,sql from sqlite_master where name not like 'sqlite_%' order by type,name").all();
}
