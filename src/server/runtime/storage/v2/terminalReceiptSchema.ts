import type { DatabaseSync } from "node:sqlite";

export const STORAGE_TERMINAL_RECEIPT_SCHEMA_VERSION = 8;
export const STORAGE_TERMINAL_RECEIPT_MIGRATION_NAME = "operational-terminal-verifier-receipts-v8";
export const STORAGE_TERMINAL_RECEIPT_MIGRATION_CHECKSUM = "e35df8ac3d6059663fd75ac21c3e5040b4c7a07c6db4814fe28280312ccbe273";

export function migrateStorageTerminalReceiptV8Schema(db: DatabaseSync): void {
  runAtomically(db, () => {
    const installed = migration(db);
    if (installed) {
      assertMigrationIdentity(installed);
      return;
    }
    installStorageTerminalReceiptV8Objects(db);
  });
  assertStorageTerminalReceiptV8SchemaReady(db);
}

function installStorageTerminalReceiptV8Objects(db: DatabaseSync): void {
  // The offline Migration Coordinator extracts this literal. Keep the ledger values synchronized with the exported constants.
  db.exec(`
    create table canonical_terminal_verifier_receipts (
      id text primary key,
      project_id text not null,
      run_id text not null,
      job_id text not null,
      request_hash text not null check(length(request_hash) = 64),
      receipt_kind text not null check(receipt_kind in ('checkpoint','policy','artifact','evidence','acceptance')),
      criterion_id text not null,
      subject_kind text not null,
      subject_id text not null,
      subject_hash text not null check(length(subject_hash) = 64),
      output_hash text not null check(length(output_hash) = 64),
      source_receipt_ids text not null,
      verifier_version text not null check(verifier_version = 'storage-worker-terminal-verifier-v1'),
      verified_at text not null,
      receipt_hash text not null unique check(length(receipt_hash) = 64),
      unique(job_id, request_hash, receipt_kind, criterion_id, subject_kind, subject_id),
      foreign key(project_id) references projects_v2(id),
      foreign key(job_id) references jobs(id)
    );
    create index idx_terminal_verifier_receipts_job_request
      on canonical_terminal_verifier_receipts(job_id, request_hash, receipt_kind, criterion_id);
    create index idx_terminal_verifier_receipts_run
      on canonical_terminal_verifier_receipts(project_id, run_id, verified_at, id);
    create trigger trg_terminal_verifier_receipts_no_update
      before update on canonical_terminal_verifier_receipts begin select raise(abort, 'canonical terminal verifier receipts are immutable'); end;
    create trigger trg_terminal_verifier_receipts_no_delete
      before delete on canonical_terminal_verifier_receipts begin select raise(abort, 'canonical terminal verifier receipts are immutable'); end;
    insert into schema_migrations (version, name, checksum_sha256, applied_at)
      values (8, 'operational-terminal-verifier-receipts-v8', 'e35df8ac3d6059663fd75ac21c3e5040b4c7a07c6db4814fe28280312ccbe273', datetime('now'));
  `);
}

export function assertStorageTerminalReceiptV8SchemaReady(db: DatabaseSync): void {
  assertMigrationIdentity(migration(db));
  const columns = new Set(
    (db.prepare("pragma table_info(canonical_terminal_verifier_receipts)").all() as Array<{ name?: unknown }>).map((row) => String(row.name))
  );
  for (const name of [
    "id",
    "project_id",
    "run_id",
    "job_id",
    "request_hash",
    "receipt_kind",
    "criterion_id",
    "subject_kind",
    "subject_id",
    "subject_hash",
    "output_hash",
    "source_receipt_ids",
    "verifier_version",
    "verified_at",
    "receipt_hash"
  ]) {
    if (!columns.has(name)) throw new Error(`Storage terminal verifier receipt column is missing: ${name}`);
  }
  const triggers = new Set(
    (db.prepare("select name from sqlite_master where type='trigger'").all() as Array<{ name?: unknown }>).map((row) => String(row.name))
  );
  for (const name of ["trg_terminal_verifier_receipts_no_update", "trg_terminal_verifier_receipts_no_delete"]) {
    if (!triggers.has(name)) throw new Error(`Storage terminal verifier receipt trigger is missing: ${name}`);
  }
  const indexes = new Set(
    (db.prepare("pragma index_list(canonical_terminal_verifier_receipts)").all() as Array<{ name?: unknown }>).map((row) => String(row.name))
  );
  for (const name of ["idx_terminal_verifier_receipts_job_request", "idx_terminal_verifier_receipts_run"]) {
    if (!indexes.has(name)) throw new Error(`Storage terminal verifier receipt index is missing: ${name}`);
  }
  const foreignKeys = new Set(
    (db.prepare("pragma foreign_key_list(canonical_terminal_verifier_receipts)").all() as Array<{ table?: unknown }>).map((row) => String(row.table))
  );
  for (const table of ["projects_v2", "jobs"]) {
    if (!foreignKeys.has(table)) throw new Error(`Storage terminal verifier receipt foreign key is missing: ${table}`);
  }
}

function migration(db: DatabaseSync): { name?: unknown; checksum_sha256?: unknown } | undefined {
  return db.prepare("select name,checksum_sha256 from schema_migrations where version=?").get(STORAGE_TERMINAL_RECEIPT_SCHEMA_VERSION) as
    { name?: unknown; checksum_sha256?: unknown } | undefined;
}

function assertMigrationIdentity(value: { name?: unknown; checksum_sha256?: unknown } | undefined): void {
  if (value?.name !== STORAGE_TERMINAL_RECEIPT_MIGRATION_NAME || value.checksum_sha256 !== STORAGE_TERMINAL_RECEIPT_MIGRATION_CHECKSUM) {
    throw new Error("Storage terminal verifier receipt migration ledger is missing or has an unexpected checksum.");
  }
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
