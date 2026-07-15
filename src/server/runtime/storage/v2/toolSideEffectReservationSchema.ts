import type { DatabaseSync } from "node:sqlite";

export const STORAGE_TOOL_SIDE_EFFECT_SCHEMA_VERSION = 11;
export const STORAGE_TOOL_SIDE_EFFECT_MIGRATION_NAME = "operational-tool-side-effect-reservations-v11";
export const STORAGE_TOOL_SIDE_EFFECT_MIGRATION_CHECKSUM = "55959399a8a0674f7452a01ce6b1d11bbc350359844687aaaee5b9d75fc3cd35";

const TABLE = "tool_side_effect_reservations";
const INDEXES = ["idx_tool_side_effect_reservations_job", "idx_tool_side_effect_reservations_status"] as const;
const TRIGGERS = ["trg_tool_side_effect_reservations_owner_insert", "trg_tool_side_effect_reservations_owner_update"] as const;

export function migrateStorageToolSideEffectV11Schema(db: DatabaseSync): void {
  runAtomically(db, () => {
    const installed = migration(db);
    if (installed) {
      assertMigrationIdentity(installed);
      return;
    }
    installStorageToolSideEffectV11Objects(db);
  });
  assertStorageToolSideEffectV11SchemaReady(db);
}

function installStorageToolSideEffectV11Objects(db: DatabaseSync): void {
  // The offline Migration Coordinator extracts this literal. Keep the ledger values synchronized with the exported constants.
  db.exec(`
    create table tool_side_effect_reservations (
      project_id text not null,
      side_effect_key text not null,
      attempt_id text not null unique,
      job_id text not null,
      idempotency_key text not null,
      input_hash text not null,
      descriptor_version text not null,
      status text not null check(status in ('reserved','applied','not_applied','ambiguous')),
      generation integer not null check(generation > 0),
      reserved_at text not null,
      resolved_at text,
      primary key(project_id, side_effect_key),
      foreign key(job_id) references jobs(id),
      foreign key(attempt_id) references tool_attempts(id)
    );
    create index idx_tool_side_effect_reservations_job
      on tool_side_effect_reservations(job_id, attempt_id);
    create index idx_tool_side_effect_reservations_status
      on tool_side_effect_reservations(status, reserved_at, project_id, side_effect_key);
    create trigger trg_tool_side_effect_reservations_owner_insert before insert on tool_side_effect_reservations
      when not exists (
        select 1 from tool_attempts
        where id=new.attempt_id and job_id=new.job_id and project_id=new.project_id
          and side_effect_key=new.side_effect_key and idempotency_key=new.idempotency_key
          and input_hash=new.input_hash and descriptor_version=new.descriptor_version
      ) begin select raise(abort, 'tool side-effect reservation owner is unavailable'); end;
    create trigger trg_tool_side_effect_reservations_owner_update before update on tool_side_effect_reservations
      when not exists (
        select 1 from tool_attempts
        where id=new.attempt_id and job_id=new.job_id and project_id=new.project_id
          and side_effect_key=new.side_effect_key and idempotency_key=new.idempotency_key
          and input_hash=new.input_hash and descriptor_version=new.descriptor_version
      ) begin select raise(abort, 'tool side-effect reservation owner is unavailable'); end;
    insert into tool_side_effect_reservations
      (project_id, side_effect_key, attempt_id, job_id, idempotency_key, input_hash, descriptor_version,
       status, generation, reserved_at, resolved_at)
    select selected.project_id, selected.side_effect_key, selected.id, selected.job_id, selected.idempotency_key,
      selected.input_hash, selected.descriptor_version,
      case
        when grouped.execution_count > 1 then 'ambiguous'
        when selected.postcondition_disposition='applied' and selected.postcondition_receipt is not null then 'applied'
        when selected.postcondition_disposition='not_applied' and selected.postcondition_receipt is not null then 'not_applied'
        else 'ambiguous'
      end,
      grouped.execution_count, grouped.reserved_at,
      coalesce(grouped.resolved_at, grouped.reserved_at)
    from tool_attempts selected
    join (
      select project_id, side_effect_key, min(id) attempt_id, count(*) execution_count,
        min(coalesce(started_at, queued_at)) reserved_at, max(completed_at) resolved_at
      from tool_attempts
      where trace_version=1 and side_effect_key is not null and idempotency_key is not null
        and descriptor_version is not null and started_at is not null and status <> 'queued'
      group by project_id, side_effect_key
    ) grouped
      on grouped.project_id=selected.project_id and grouped.side_effect_key=selected.side_effect_key
      and grouped.attempt_id=selected.id;
    insert into schema_migrations (version, name, checksum_sha256, applied_at)
      values (11, 'operational-tool-side-effect-reservations-v11', '55959399a8a0674f7452a01ce6b1d11bbc350359844687aaaee5b9d75fc3cd35', datetime('now'));
  `);
}

export function assertStorageToolSideEffectV11SchemaReady(db: DatabaseSync): void {
  assertMigrationIdentity(migration(db));
  assertNames(db, `pragma table_info(${TABLE})`, [
    "project_id",
    "side_effect_key",
    "attempt_id",
    "job_id",
    "idempotency_key",
    "input_hash",
    "descriptor_version",
    "status",
    "generation",
    "reserved_at",
    "resolved_at"
  ]);
  assertNames(db, `pragma index_list(${TABLE})`, [...INDEXES]);
  const triggers = names(db, "select name from sqlite_master where type='trigger'");
  for (const name of TRIGGERS) if (!triggers.has(name)) throw new Error(`Storage tool side-effect reservation trigger is missing: ${name}`);
}

function assertNames(db: DatabaseSync, sql: string, required: readonly string[]): void {
  const actual = names(db, sql);
  for (const name of required) if (!actual.has(name)) throw new Error(`Storage tool side-effect reservation object is missing: ${name}`);
}

function names(db: DatabaseSync, sql: string): Set<string> {
  return new Set((db.prepare(sql).all() as Array<{ name?: unknown }>).map((row) => String(row.name)));
}

function migration(db: DatabaseSync): { name?: unknown; checksum_sha256?: unknown } | undefined {
  return db.prepare("select name,checksum_sha256 from schema_migrations where version=?").get(STORAGE_TOOL_SIDE_EFFECT_SCHEMA_VERSION) as
    { name?: unknown; checksum_sha256?: unknown } | undefined;
}

function assertMigrationIdentity(value: { name?: unknown; checksum_sha256?: unknown } | undefined): void {
  if (value?.name !== STORAGE_TOOL_SIDE_EFFECT_MIGRATION_NAME || value.checksum_sha256 !== STORAGE_TOOL_SIDE_EFFECT_MIGRATION_CHECKSUM) {
    throw new Error("Storage tool side-effect reservation migration ledger is missing or has an unexpected checksum.");
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
