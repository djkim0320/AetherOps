import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertLegacyProjectMutationSchemaReady,
  LEGACY_PROJECT_MUTATION_MIGRATION_CHECKSUM,
  LEGACY_PROJECT_MUTATION_MIGRATION_NAME,
  LEGACY_PROJECT_MUTATION_SCHEMA_VERSION,
  migrateLegacyProjectMutationSchema
} from "./legacyProjectMutationSchema.js";
import { SqliteResearchStore } from "./sqliteStore.js";
import { createLegacyStorageWorker } from "./worker/legacyStorageClient.js";

const roots: string[] = [];
const rootsByLabel = new Map<string, string>();

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  rootsByLabel.clear();
});

describe("legacy project mutation schema", () => {
  it("installs a checksummed migration once and verifies the immutable objects", () => {
    const path = databasePath("install");
    const db = new DatabaseSync(path);
    try {
      migrateLegacyProjectMutationSchema(db);
      assertLegacyProjectMutationSchemaReady(db);
      expect(db.prepare("select version,name,checksum_sha256 from schema_migrations").all()).toEqual([
        {
          version: LEGACY_PROJECT_MUTATION_SCHEMA_VERSION,
          name: LEGACY_PROJECT_MUTATION_MIGRATION_NAME,
          checksum_sha256: LEGACY_PROJECT_MUTATION_MIGRATION_CHECKSUM
        }
      ]);
      const firstAppliedAt = db.prepare("select applied_at from schema_migrations where version=?").get(LEGACY_PROJECT_MUTATION_SCHEMA_VERSION);
      migrateLegacyProjectMutationSchema(db);
      expect(db.prepare("select applied_at from schema_migrations where version=?").get(LEGACY_PROJECT_MUTATION_SCHEMA_VERSION)).toEqual(firstAppliedAt);
    } finally {
      db.close();
    }
  });

  it("fails closed on partial objects, same-name trigger drift, and checksum tampering", () => {
    const partial = new DatabaseSync(databasePath("partial"));
    partial.exec("create table legacy_project_mutation_receipts(operation_id text primary key)");
    expect(() => migrateLegacyProjectMutationSchema(partial)).toThrow(/partially installed|columns differ/i);
    expect(partial.prepare("select name from sqlite_master where name='schema_migrations'").get()).toBeUndefined();
    partial.close();

    const triggerDrift = new DatabaseSync(databasePath("trigger-drift"));
    migrateLegacyProjectMutationSchema(triggerDrift);
    triggerDrift.exec(`
      drop trigger legacy_project_mutation_receipts_no_update;
      create trigger legacy_project_mutation_receipts_no_update before update on legacy_project_mutation_receipts begin select 1; end;
    `);
    expect(() => assertLegacyProjectMutationSchemaReady(triggerDrift)).toThrow(/trigger definition/i);
    expect(() => migrateLegacyProjectMutationSchema(triggerDrift)).toThrow(/trigger definition/i);
    triggerDrift.close();

    const checksum = new DatabaseSync(databasePath("checksum"));
    migrateLegacyProjectMutationSchema(checksum);
    checksum.prepare("update schema_migrations set checksum_sha256='invalid' where version=?").run(LEGACY_PROJECT_MUTATION_SCHEMA_VERSION);
    expect(() => assertLegacyProjectMutationSchemaReady(checksum)).toThrow(/unexpected checksum/i);
    expect(() => migrateLegacyProjectMutationSchema(checksum)).toThrow(/unexpected checksum/i);
    checksum.close();

    const receiptHash = new DatabaseSync(databasePath("receipt-hash"));
    migrateLegacyProjectMutationSchema(receiptHash);
    receiptHash
      .prepare(
        `insert into legacy_project_mutation_receipts
          (operation_id,method,request_hash,command_hash,project_id,before_hash,snapshot_hash,result_json,result_hash,applied_at,receipt_hash)
         values ('tampered','project.create',?,?,?,null,?,'{}',?,'2026-07-16T00:00:00.000Z',?)`
      )
      .run("a".repeat(64), "b".repeat(64), "project", "c".repeat(64), "d".repeat(64), "e".repeat(64));
    expect(() => assertLegacyProjectMutationSchemaReady(receiptHash)).toThrow(/receipt hash verification failed/i);
    receiptHash.close();
  });

  it("does not create receipt objects from SqliteResearchStore and rejects an unmigrated worker before serving requests", async () => {
    const path = databasePath("assert-only");
    const store = new SqliteResearchStore(path);
    await expect(store.getProjectMutationReceipt("not-present")).rejects.toThrow(/migration ledger is missing/i);
    store.close();
    const inspection = new DatabaseSync(path, { readOnly: true });
    expect(inspection.prepare("select name from sqlite_master where name='legacy_project_mutation_receipts'").get()).toBeUndefined();
    inspection.close();

    const worker = createLegacyStorageWorker(path, join(rootFor("assert-only"), "settings.json"));
    await expect(worker.ready).rejects.toThrow(/legacy storage worker|migration ledger/i);
    await expect(worker.projectMutations.getReceipt("not-present")).rejects.toThrow();
    await worker.close();
  });
});

function databasePath(label: string): string {
  return join(rootFor(label), "legacy-research.sqlite");
}

function rootFor(label: string): string {
  const existing = rootsByLabel.get(label);
  if (existing) return existing;
  const root = mkdtempSync(join(tmpdir(), `aetherops-legacy-schema-${label}-`));
  roots.push(root);
  rootsByLabel.set(label, root);
  return root;
}
