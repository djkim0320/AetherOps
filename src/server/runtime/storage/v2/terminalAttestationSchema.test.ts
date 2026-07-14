import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { migrateStorageV2Schema } from "./schema.js";
import {
  assertStorageTerminalAttestationV9SchemaReady,
  migrateStorageTerminalAttestationV9Schema,
  STORAGE_TERMINAL_ATTESTATION_MIGRATION_CHECKSUM,
  STORAGE_TERMINAL_ATTESTATION_MIGRATION_NAME,
  STORAGE_TERMINAL_ATTESTATION_SCHEMA_VERSION
} from "./terminalAttestationSchema.js";

describe("storage terminal result attestation v9 schema", () => {
  it("is idempotent and preserves its immutable migration identity", () => {
    const db = new DatabaseSync(":memory:");
    try {
      migrateStorageV2Schema(db);
      migrateStorageTerminalAttestationV9Schema(db);
      expect(db.prepare("select name,checksum_sha256 from schema_migrations where version=?").get(STORAGE_TERMINAL_ATTESTATION_SCHEMA_VERSION)).toEqual({
        name: STORAGE_TERMINAL_ATTESTATION_MIGRATION_NAME,
        checksum_sha256: STORAGE_TERMINAL_ATTESTATION_MIGRATION_CHECKSUM
      });
      expect(() => assertStorageTerminalAttestationV9SchemaReady(db)).not.toThrow();
    } finally {
      db.close();
    }
  });

  it("fails closed for a checksum conflict, partial schema, or migration rollback", () => {
    const checksumDb = new DatabaseSync(":memory:");
    const partialDb = new DatabaseSync(":memory:");
    const rollbackDb = new DatabaseSync(":memory:");
    try {
      migrateStorageV2Schema(checksumDb);
      checksumDb.prepare("update schema_migrations set checksum_sha256='invalid' where version=?").run(STORAGE_TERMINAL_ATTESTATION_SCHEMA_VERSION);
      expect(() => migrateStorageTerminalAttestationV9Schema(checksumDb)).toThrow(/unexpected checksum/i);

      migrateStorageV2Schema(partialDb);
      partialDb.exec("drop index idx_terminal_attestations_run");
      expect(() => assertStorageTerminalAttestationV9SchemaReady(partialDb)).toThrow(/schema object is missing/i);

      migrateStorageV2Schema(rollbackDb);
      rollbackDb.exec("drop trigger trg_terminal_attestations_no_delete");
      expect(() => migrateStorageTerminalAttestationV9Schema(rollbackDb)).toThrow(/trigger is missing/i);
      expect(rollbackDb.prepare("pragma integrity_check").all()).toEqual([{ integrity_check: "ok" }]);
    } finally {
      checksumDb.close();
      partialDb.close();
      rollbackDb.close();
    }
  });
});
