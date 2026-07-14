import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { createV2Database } from "../../src/migration/sqlite.mjs";
import {
  assertStorageRunStateV5SchemaReady,
  STORAGE_RUN_STATE_MIGRATION_CHECKSUM,
  STORAGE_RUN_STATE_SCHEMA_VERSION
} from "../../src/server/runtime/storage/v2/runStateSchema.js";
import { migrateStorageV2Schema } from "../../src/server/runtime/storage/v2/schema.js";

describe("Migration Coordinator run-state v5 installation", () => {
  it("creates the same ready additive schema as the runtime migration and changes nothing on reapply", () => {
    const root = mkdtempSync(join(tmpdir(), "aetherops-migration-run-state-v5-"));
    const path = join(root, "storage.sqlite");
    const created = createV2Database(path, { schemaVersion: 2 });
    try {
      assertStorageRunStateV5SchemaReady(created);
      expect(created.prepare("select checksum_sha256 from schema_migrations where version=?").get(STORAGE_RUN_STATE_SCHEMA_VERSION)).toEqual({
        checksum_sha256: STORAGE_RUN_STATE_MIGRATION_CHECKSUM
      });
      expect(created.prepare("pragma foreign_key_check").all()).toEqual([]);
      const before = schemaSnapshot(created);
      migrateStorageV2Schema(created);
      expect(schemaSnapshot(created)).toEqual(before);
    } finally {
      created.close();
    }

    const readback = new DatabaseSync(path, { readOnly: true });
    try {
      assertStorageRunStateV5SchemaReady(readback);
      expect(readback.prepare("select count(*) count from run_state_revisions").get()).toEqual({ count: 0 });
    } finally {
      readback.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});

function schemaSnapshot(db: DatabaseSync): unknown[] {
  return db.prepare("select type,name,tbl_name,sql from sqlite_master where name not like 'sqlite_%' order by type,name").all();
}
