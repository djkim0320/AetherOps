import type { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";

export const STORAGE_PROJECT_MUTATION_SCHEMA_VERSION = 14;
export const STORAGE_PROJECT_MUTATION_MIGRATION_NAME = "operational-project-mutation-journal-v14";
export const STORAGE_PROJECT_MUTATION_MIGRATION_CHECKSUM = "cd4823ba4c2b057cf66f1b9529f53fe0164eae897dc64f376b3ce5104525be5c";

const TABLE = "project_mutation_journal";
const INDEXES = ["idx_project_mutations_active_project", "idx_project_mutations_pending"] as const;
const TRIGGERS = ["trg_project_mutations_transition", "trg_project_mutations_no_delete"] as const;
const OBJECT_SQL_HASHES = new Map([
  [TABLE, "e9de51a36e572628a3e5d24bdd9f3b271248fcf7d213011a3cb5575d7ae6ac52"],
  ["idx_project_mutations_active_project", "d5706b8947e748e60535a8de494631ef43cb575e7ef9035e7dbd560c7f405354"],
  ["idx_project_mutations_pending", "b247ca7489831ef6345e6c4747cfd1dc0926057c9921fb726d98c1fea0cf92b9"],
  ["trg_project_mutations_no_delete", "d042ec76ade343cd4a1ff849e6cd49b49193a30295afc17ae0451d2e5310200d"],
  ["trg_project_mutations_transition", "ae63aaf102ea9f5f8fec7b2e3dca6da204cc1fca642ba466171653b74b13b192"]
]);

export function migrateStorageProjectMutationV14Schema(db: DatabaseSync): void {
  runAtomically(db, () => {
    const installed = migration(db);
    if (installed) {
      assertMigrationIdentity(installed);
      return;
    }
    installStorageProjectMutationV14Objects(db);
  });
  assertStorageProjectMutationV14SchemaReady(db);
}

function installStorageProjectMutationV14Objects(db: DatabaseSync): void {
  // The offline Migration Coordinator extracts this literal. Keep ledger identity synchronized with the exported constants.
  db.exec(`
    create table project_mutation_journal (
      operation_id text primary key,
      schema_version integer not null check(schema_version=1),
      method text not null check(method in ('projects.create','projects.update','sessions.create','sessions.delete')),
      request_id text not null,
      request_hash text not null check(length(request_hash)=64),
      project_id text not null,
      expected_revision integer not null check(expected_revision>=0),
      command_json text not null check(json_valid(command_json) and json_type(command_json)='object' and length(command_json)<=32768),
      command_hash text not null check(length(command_hash)=64),
      legacy_before_hash text not null check(length(legacy_before_hash)=64),
      state text not null check(state in ('prepared','legacy_applied','finalizing','finalized')),
      legacy_receipt_hash text,
      legacy_snapshot_hash text,
      legacy_applied_at text,
      finalize_request_hash text,
      event_id text,
      committed_revision integer check(committed_revision>0),
      public_result_json text,
      public_result_hash text,
      prepared_at text not null,
      updated_at text not null,
      finalized_at text,
      unique(method,request_id),
      check(
        (state='prepared' and legacy_receipt_hash is null and legacy_snapshot_hash is null and legacy_applied_at is null
          and finalize_request_hash is null and event_id is null and committed_revision is null
          and public_result_json is null and public_result_hash is null and finalized_at is null)
        or (state='legacy_applied' and length(legacy_receipt_hash)=64 and length(legacy_snapshot_hash)=64 and legacy_applied_at is not null
          and finalize_request_hash is null and event_id is null and committed_revision is null
          and public_result_json is null and public_result_hash is null and finalized_at is null)
        or (state='finalizing' and length(legacy_receipt_hash)=64 and length(legacy_snapshot_hash)=64 and legacy_applied_at is not null
          and length(finalize_request_hash)=64 and event_id is null and committed_revision is null
          and public_result_json is null and public_result_hash is null and finalized_at is null)
        or (state='finalized' and length(legacy_receipt_hash)=64 and length(legacy_snapshot_hash)=64 and legacy_applied_at is not null
          and length(finalize_request_hash)=64 and event_id is not null and committed_revision>0
          and json_valid(public_result_json) and json_type(public_result_json)='object'
          and length(public_result_hash)=64 and finalized_at is not null)
      ),
      foreign key(event_id) references job_events(event_id)
    );
    create unique index idx_project_mutations_active_project on project_mutation_journal(project_id)
      where state in ('prepared','legacy_applied','finalizing');
    create index idx_project_mutations_pending on project_mutation_journal(state,prepared_at,operation_id);
    create trigger trg_project_mutations_transition before update on project_mutation_journal
      when new.operation_id is not old.operation_id or new.schema_version is not old.schema_version
        or new.method is not old.method or new.request_id is not old.request_id or new.request_hash is not old.request_hash
        or new.project_id is not old.project_id or new.expected_revision is not old.expected_revision
        or new.command_json is not old.command_json or new.command_hash is not old.command_hash
        or new.legacy_before_hash is not old.legacy_before_hash or new.prepared_at is not old.prepared_at
        or not (
          (old.state='prepared' and new.state='legacy_applied' and length(new.legacy_receipt_hash)=64
            and length(new.legacy_snapshot_hash)=64 and new.legacy_applied_at is not null and new.updated_at=new.legacy_applied_at
            and new.finalize_request_hash is null and new.event_id is null and new.committed_revision is null
            and new.public_result_json is null and new.public_result_hash is null and new.finalized_at is null)
          or (old.state='legacy_applied' and new.state='finalizing' and length(new.finalize_request_hash)=64
            and new.legacy_receipt_hash=old.legacy_receipt_hash and new.legacy_snapshot_hash=old.legacy_snapshot_hash
            and new.legacy_applied_at=old.legacy_applied_at and new.event_id is null and new.committed_revision is null
            and new.public_result_json is null and new.public_result_hash is null and new.finalized_at is null)
          or (old.state='finalizing' and new.state='finalized' and new.finalize_request_hash=old.finalize_request_hash
            and new.legacy_receipt_hash=old.legacy_receipt_hash and new.legacy_snapshot_hash=old.legacy_snapshot_hash
            and new.legacy_applied_at=old.legacy_applied_at and new.event_id is not null and new.committed_revision>0
            and json_valid(new.public_result_json) and json_type(new.public_result_json)='object'
            and length(new.public_result_hash)=64 and new.finalized_at is not null and new.updated_at=new.finalized_at
            and exists (select 1 from job_events e where e.event_id=new.event_id and e.project_id=new.project_id
              and json_valid(e.payload) and json_extract(e.payload,'$.projectRevision')=new.committed_revision))
        )
      begin select raise(abort, 'project mutation journal transition is invalid'); end;
    create trigger trg_project_mutations_no_delete before delete on project_mutation_journal
      begin select raise(abort, 'project mutation journal entries cannot be deleted'); end;
    insert into schema_migrations (version,name,checksum_sha256,applied_at)
      values (14,'operational-project-mutation-journal-v14','cd4823ba4c2b057cf66f1b9529f53fe0164eae897dc64f376b3ce5104525be5c',datetime('now'));
  `);
}

export function assertStorageProjectMutationV14SchemaReady(db: DatabaseSync): void {
  assertMigrationIdentity(migration(db));
  if (!nameSet(db, "select name from sqlite_master where type='table'").has(TABLE)) throw new Error(`Storage project mutation table is missing: ${TABLE}`);
  const indexes = nameSet(db, "select name from sqlite_master where type='index'");
  for (const name of INDEXES) if (!indexes.has(name)) throw new Error(`Storage project mutation index is missing: ${name}`);
  const triggers = nameSet(db, "select name from sqlite_master where type='trigger'");
  for (const name of TRIGGERS) if (!triggers.has(name)) throw new Error(`Storage project mutation trigger is missing: ${name}`);
  assertObjectSqlIdentity(db);
  assertColumns(db);
  assertSemantics(db);
}

function assertObjectSqlIdentity(db: DatabaseSync): void {
  const statement = db.prepare("select sql from sqlite_master where name=? and type in ('table','index','trigger')");
  for (const [name, expectedHash] of OBJECT_SQL_HASHES) {
    const row = statement.get(name) as { sql?: unknown } | undefined;
    if (typeof row?.sql !== "string" || canonicalSqlHash(row.sql) !== expectedHash) {
      throw new Error(`Storage project mutation schema object changed: ${name}`);
    }
  }
}

function canonicalSqlHash(sql: string): string {
  const normalized = sql.trim().replace(/\s+/g, " ").replace(/;$/, "").trim().toLowerCase();
  return createHash("sha256").update(normalized).digest("hex");
}

function assertColumns(db: DatabaseSync): void {
  const columns = nameSet(db, `pragma table_info(${TABLE})`);
  for (const name of [
    "operation_id",
    "method",
    "request_id",
    "request_hash",
    "project_id",
    "expected_revision",
    "command_json",
    "command_hash",
    "legacy_before_hash",
    "state",
    "legacy_receipt_hash",
    "legacy_snapshot_hash",
    "finalize_request_hash",
    "event_id",
    "committed_revision",
    "public_result_json",
    "public_result_hash",
    "prepared_at",
    "updated_at",
    "finalized_at"
  ])
    if (!columns.has(name)) throw new Error(`Storage project mutation column is missing: ${name}`);
}

function assertSemantics(db: DatabaseSync): void {
  const invalid = db
    .prepare(
      `select operation_id from ${TABLE} where
    (state='finalizing') or
    (state='finalized' and not exists (
      select 1 from job_events e join project_revision_event_links l on l.event_id=e.event_id
      where e.event_id=${TABLE}.event_id and e.project_id=${TABLE}.project_id and l.revision=${TABLE}.committed_revision
    )) limit 1`
    )
    .get() as { operation_id?: unknown } | undefined;
  if (invalid) throw new Error(`Storage project mutation journal readback is inconsistent: ${String(invalid.operation_id)}`);
}

function migration(db: DatabaseSync): { name?: unknown; checksum_sha256?: unknown } | undefined {
  return db.prepare("select name,checksum_sha256 from schema_migrations where version=14").get() as { name?: unknown; checksum_sha256?: unknown } | undefined;
}

function assertMigrationIdentity(value: { name?: unknown; checksum_sha256?: unknown } | undefined): void {
  if (value?.name !== STORAGE_PROJECT_MUTATION_MIGRATION_NAME || value.checksum_sha256 !== STORAGE_PROJECT_MUTATION_MIGRATION_CHECKSUM) {
    throw new Error("Storage project mutation migration ledger is missing or has an unexpected checksum.");
  }
}

function nameSet(db: DatabaseSync, sql: string): Set<string> {
  return new Set((db.prepare(sql).all() as Array<{ name?: unknown }>).map((row) => String(row.name)));
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
