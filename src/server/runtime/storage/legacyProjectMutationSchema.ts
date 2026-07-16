import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { readLegacyProjectMutationReceipt } from "./legacyProjectMutationStore.js";

export const LEGACY_PROJECT_MUTATION_SCHEMA_VERSION = 1;
export const LEGACY_PROJECT_MUTATION_MIGRATION_NAME = "legacy-project-mutation-receipts-v1";
export const LEGACY_PROJECT_MUTATION_MIGRATION_CHECKSUM = "d25d3de3b7440908969abe2e5fa69273d960ad672279da0bafa8d7bcc7bae9aa";

const RECEIPT_TABLE = "legacy_project_mutation_receipts";
const RECEIPT_INDEX = "idx_legacy_project_mutation_receipts_project";
const RECEIPT_TRIGGERS = ["legacy_project_mutation_receipts_no_update", "legacy_project_mutation_receipts_no_delete"] as const;
const RECEIPT_COLUMNS = [
  "operation_id",
  "method",
  "request_hash",
  "command_hash",
  "project_id",
  "before_hash",
  "snapshot_hash",
  "result_json",
  "result_hash",
  "applied_at",
  "receipt_hash"
] as const;
const OBJECT_SQL_HASHES = new Map([
  [RECEIPT_TABLE, "8e578ebd72a5fa86ddc1d767db8e970b4aac6373dab04e774e67903c0813df0e"],
  [RECEIPT_INDEX, "49bb344cc3c2f24220dfddc1d5c88b2b47009b466b0b04261b8584dd8bd7ebe4"],
  ["legacy_project_mutation_receipts_no_update", "f5f04b97cadaa4cc7e64d26cc36c72d733d4887fab8f69287f6db68e4af6b5c2"],
  ["legacy_project_mutation_receipts_no_delete", "0fd336ac6532d2ee25da5a604721427a2f61ab00d3e768bd7d5b0b86a9f3621b"]
]);

export function migrateLegacyProjectMutationSchema(db: DatabaseSync): void {
  runAtomically(db, () => {
    const inspection = inspectObjects(db);
    if (inspection.conflicts.length) throw new Error(`Legacy project mutation schema is incompatible: ${inspection.conflicts.join("; ")}`);
    const installed = migration(db);
    if (installed) {
      assertMigrationIdentity(installed);
      return;
    }
    installLegacyProjectMutationObjects(db);
  });
  assertLegacyProjectMutationSchemaReady(db);
}

function installLegacyProjectMutationObjects(db: DatabaseSync): void {
  // The offline Migration Coordinator extracts this literal. Keep ledger identity synchronized with the exported constants.
  db.exec(`
    create table if not exists schema_migrations (
      version integer primary key,
      name text not null,
      checksum_sha256 text not null,
      applied_at text not null
    );
    create table if not exists legacy_project_mutation_receipts (
      operation_id text primary key,
      method text not null,
      request_hash text not null,
      command_hash text not null,
      project_id text not null,
      before_hash text,
      snapshot_hash text not null,
      result_json text not null,
      result_hash text not null,
      applied_at text not null,
      receipt_hash text not null
    );
    create index if not exists idx_legacy_project_mutation_receipts_project
      on legacy_project_mutation_receipts(project_id, applied_at, operation_id);
    create trigger if not exists legacy_project_mutation_receipts_no_update
      before update on legacy_project_mutation_receipts begin
        select raise(abort, 'legacy project mutation receipts are immutable');
      end;
    create trigger if not exists legacy_project_mutation_receipts_no_delete
      before delete on legacy_project_mutation_receipts begin
        select raise(abort, 'legacy project mutation receipts are immutable');
      end;
    insert into schema_migrations (version, name, checksum_sha256, applied_at)
      values (1, 'legacy-project-mutation-receipts-v1', 'd25d3de3b7440908969abe2e5fa69273d960ad672279da0bafa8d7bcc7bae9aa', datetime('now'));
  `);
}

export function assertLegacyProjectMutationSchemaReady(db: DatabaseSync): void {
  assertMigrationIdentity(migration(db));
  const inspection = inspectObjects(db);
  if (inspection.errors.length || inspection.conflicts.length) {
    throw new Error(`Legacy project mutation schema is not ready: ${[...inspection.errors, ...inspection.conflicts].join("; ")}`);
  }
}

function inspectObjects(db: DatabaseSync): { errors: string[]; conflicts: string[] } {
  const errors: string[] = [];
  const conflicts: string[] = [];
  const relevantObjects = new Set([RECEIPT_TABLE, RECEIPT_INDEX, ...RECEIPT_TRIGGERS]);
  const present = new Set(
    (db.prepare("select name from sqlite_master where name in (?, ?, ?, ?)").all(...relevantObjects) as Array<{ name?: unknown }>).map((row) =>
      String(row.name)
    )
  );
  const presentCount = [...relevantObjects].filter((name) => present.has(name)).length;
  if (presentCount > 0 && presentCount < relevantObjects.size) conflicts.push("legacy project mutation receipt objects are partially installed");
  if (!present.has(RECEIPT_TABLE)) errors.push(`table is missing: ${RECEIPT_TABLE}`);
  if (!present.has(RECEIPT_INDEX)) errors.push(`index is missing: ${RECEIPT_INDEX}`);
  for (const trigger of RECEIPT_TRIGGERS) if (!present.has(trigger)) errors.push(`trigger is missing: ${trigger}`);
  if (present.has(RECEIPT_TABLE)) assertReceiptColumns(db, conflicts);
  if (present.has(RECEIPT_INDEX)) assertReceiptIndex(db, conflicts);
  for (const trigger of RECEIPT_TRIGGERS) if (present.has(trigger)) assertImmutableTrigger(db, trigger, conflicts);
  for (const name of present) assertObjectSql(db, name, conflicts);
  if (presentCount === relevantObjects.size && conflicts.length === 0) assertReceiptRows(db, conflicts);
  return { errors, conflicts };
}

function assertReceiptRows(db: DatabaseSync, conflicts: string[]): void {
  const receiptIds = db.prepare(`select operation_id from ${RECEIPT_TABLE} order by operation_id`).all() as Array<{ operation_id?: unknown }>;
  for (const row of receiptIds) {
    try {
      readLegacyProjectMutationReceipt(db, String(row.operation_id));
    } catch {
      conflicts.push(`legacy project mutation receipt hash verification failed: ${String(row.operation_id)}`);
    }
  }
}

function assertReceiptColumns(db: DatabaseSync, conflicts: string[]): void {
  const columns = db.prepare(`pragma table_info(${RECEIPT_TABLE})`).all() as Array<{
    name?: unknown;
    type?: unknown;
    notnull?: unknown;
    pk?: unknown;
  }>;
  if (columns.map((column) => String(column.name)).join("\u0000") !== RECEIPT_COLUMNS.join("\u0000")) {
    conflicts.push("legacy project mutation receipt columns differ from the migration contract");
    return;
  }
  for (const column of columns) {
    const name = String(column.name);
    const nullable = name === "before_hash";
    if (String(column.type).toLowerCase() !== "text" || Number(column.notnull) !== (nullable || name === "operation_id" ? 0 : 1)) {
      conflicts.push(`legacy project mutation receipt column definition is invalid: ${name}`);
    }
  }
  if (Number(columns[0]?.pk) !== 1) conflicts.push("legacy project mutation receipt primary key is invalid");
}

function assertReceiptIndex(db: DatabaseSync, conflicts: string[]): void {
  const columns = (db.prepare(`pragma index_info(${RECEIPT_INDEX})`).all() as Array<{ name?: unknown }>).map((row) => String(row.name));
  if (columns.join("\u0000") !== "project_id\u0000applied_at\u0000operation_id") {
    conflicts.push("legacy project mutation receipt index definition is invalid");
  }
}

function assertImmutableTrigger(db: DatabaseSync, name: string, conflicts: string[]): void {
  const row = db.prepare("select sql from sqlite_master where type='trigger' and name=?").get(name) as { sql?: unknown } | undefined;
  const sql = normalizeSql(row?.sql);
  const operation = name.endsWith("no_update") ? "update" : "delete";
  if (!sql.includes(`before ${operation} on ${RECEIPT_TABLE}`) || !sql.includes("raise(abort, 'legacy project mutation receipts are immutable')")) {
    conflicts.push(`legacy project mutation receipt trigger definition is invalid: ${name}`);
  }
}

function assertObjectSql(db: DatabaseSync, name: string, conflicts: string[]): void {
  const row = db.prepare("select sql from sqlite_master where name=?").get(name) as { sql?: unknown } | undefined;
  const hash = createHash("sha256").update(normalizeSql(row?.sql)).digest("hex");
  if (hash !== OBJECT_SQL_HASHES.get(name)) conflicts.push(`legacy project mutation schema object definition is invalid: ${name}`);
}

function migration(db: DatabaseSync): { name?: unknown; checksum_sha256?: unknown } | undefined {
  if (!tableExists(db, "schema_migrations")) return undefined;
  const ledgerColumns = (db.prepare("pragma table_info(schema_migrations)").all() as Array<{ name?: unknown }>).map((row) => String(row.name));
  if (ledgerColumns.join("\u0000") !== "version\u0000name\u0000checksum_sha256\u0000applied_at") {
    throw new Error("Legacy schema migration ledger has an incompatible definition.");
  }
  return db.prepare("select name,checksum_sha256 from schema_migrations where version=?").get(LEGACY_PROJECT_MUTATION_SCHEMA_VERSION) as
    { name?: unknown; checksum_sha256?: unknown } | undefined;
}

function assertMigrationIdentity(value: { name?: unknown; checksum_sha256?: unknown } | undefined): void {
  if (value?.name !== LEGACY_PROJECT_MUTATION_MIGRATION_NAME || value.checksum_sha256 !== LEGACY_PROJECT_MUTATION_MIGRATION_CHECKSUM) {
    throw new Error("Legacy project mutation migration ledger is missing or has an unexpected checksum.");
  }
}

function normalizeSql(value: unknown): string {
  return String(value ?? "")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();
}

function tableExists(db: DatabaseSync, name: string): boolean {
  return Boolean(db.prepare("select 1 from sqlite_master where type='table' and name=?").get(name));
}

function runAtomically<T>(db: DatabaseSync, work: () => T): T {
  if (db.isTransaction) return work();
  db.exec("begin immediate");
  try {
    const result = work();
    db.exec("commit");
    return result;
  } catch (error) {
    if (db.isTransaction) db.exec("rollback");
    throw error;
  }
}
