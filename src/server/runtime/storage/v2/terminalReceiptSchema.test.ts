import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { migrateStorageV2Schema } from "./schema.js";
import {
  assertStorageTerminalReceiptV8SchemaReady,
  migrateStorageTerminalReceiptV8Schema,
  STORAGE_TERMINAL_RECEIPT_MIGRATION_CHECKSUM,
  STORAGE_TERMINAL_RECEIPT_MIGRATION_NAME,
  STORAGE_TERMINAL_RECEIPT_SCHEMA_VERSION
} from "./terminalReceiptSchema.js";

describe("storage terminal verifier receipt v8 schema", () => {
  it("is idempotent and preserves its immutable migration identity", () => {
    const db = new DatabaseSync(":memory:");
    try {
      migrateStorageV2Schema(db);
      migrateStorageTerminalReceiptV8Schema(db);
      expect(db.prepare("select name,checksum_sha256 from schema_migrations where version=?").get(STORAGE_TERMINAL_RECEIPT_SCHEMA_VERSION)).toEqual({
        name: STORAGE_TERMINAL_RECEIPT_MIGRATION_NAME,
        checksum_sha256: STORAGE_TERMINAL_RECEIPT_MIGRATION_CHECKSUM
      });
      expect(() => assertStorageTerminalReceiptV8SchemaReady(db)).not.toThrow();
    } finally {
      db.close();
    }
  });

  it("fails closed for a checksum conflict or missing required index", () => {
    const checksumDb = new DatabaseSync(":memory:");
    const indexDb = new DatabaseSync(":memory:");
    try {
      migrateStorageV2Schema(checksumDb);
      checksumDb.prepare("update schema_migrations set checksum_sha256='invalid' where version=?").run(STORAGE_TERMINAL_RECEIPT_SCHEMA_VERSION);
      expect(() => migrateStorageTerminalReceiptV8Schema(checksumDb)).toThrow(/unexpected checksum/i);

      migrateStorageV2Schema(indexDb);
      indexDb.exec("drop index idx_terminal_verifier_receipts_run");
      expect(() => assertStorageTerminalReceiptV8SchemaReady(indexDb)).toThrow(/index is missing/i);
    } finally {
      checksumDb.close();
      indexDb.close();
    }
  });
});
