import type { DatabaseSync } from "node:sqlite";

export const STORAGE_RUN_STATE_SCHEMA_VERSION = 5;
export const STORAGE_RUN_STATE_MIGRATION_NAME = "operational-run-state-v5";
export const STORAGE_RUN_STATE_MIGRATION_CHECKSUM = "cafec8f620174e7d61e931dd034073b4373be9f17b3059a4bca7ee7d0bc6ccf7";

export function migrateStorageRunStateV5Schema(db: DatabaseSync): void {
  runAtomically(db, () => {
    db.exec(`
      create table if not exists schema_migrations (
        version integer primary key,
        name text not null,
        checksum_sha256 text not null,
        applied_at text not null
      )
    `);
    const installed = db.prepare("select name, checksum_sha256 from schema_migrations where version=?").get(STORAGE_RUN_STATE_SCHEMA_VERSION) as
      { name?: unknown; checksum_sha256?: unknown } | undefined;
    if (installed) {
      assertMigrationIdentity(installed);
      return;
    }
    installStorageRunStateV5Objects(db);
  });
  assertStorageRunStateV5SchemaReady(db);
}

function installStorageRunStateV5Objects(db: DatabaseSync): void {
  // The offline Migration Coordinator extracts this literal. Keep the ledger values synchronized with the exported constants.
  db.exec(`
    create table if not exists task_contracts (
      id text primary key,
      project_id text not null,
      schema_version integer not null check(schema_version > 0),
      content_hash text not null check(length(content_hash) = 64),
      created_at text not null,
      data text not null,
      foreign key(project_id) references projects_v2(id)
    );
    create index if not exists idx_task_contracts_project_created
      on task_contracts(project_id, created_at, id);

    create table if not exists context_packs (
      id text primary key,
      project_id text not null,
      run_id text not null,
      job_id text not null,
      schema_version integer not null check(schema_version > 0),
      state_revision integer not null check(state_revision >= 0),
      task_contract_id text not null,
      task_contract_hash text not null check(length(task_contract_hash) = 64),
      content_hash text not null check(length(content_hash) = 64),
      created_at text not null,
      data text not null,
      foreign key(project_id) references projects_v2(id),
      foreign key(job_id) references jobs(id),
      foreign key(task_contract_id) references task_contracts(id)
    );
    create index if not exists idx_context_packs_project_run_revision
      on context_packs(project_id, run_id, state_revision, created_at, id);
    create index if not exists idx_context_packs_job_revision
      on context_packs(job_id, state_revision, created_at, id);
    create index if not exists idx_context_packs_task_contract
      on context_packs(task_contract_id, created_at, id);

    create table if not exists run_state_revisions (
      id text primary key,
      project_id text not null,
      run_id text not null,
      job_id text not null,
      schema_version integer not null check(schema_version > 0),
      revision integer not null check(revision >= 0),
      previous_revision integer,
      parent_revision_hash text,
      state_hash text not null check(length(state_hash) = 64),
      task_contract_id text not null,
      task_contract_hash text not null check(length(task_contract_hash) = 64),
      context_pack_id text,
      created_at text not null,
      data text not null,
      check((revision = 0 and previous_revision is null and parent_revision_hash is null) or
        (revision > 0 and previous_revision = revision - 1 and length(parent_revision_hash) = 64)),
      unique(run_id, revision),
      foreign key(project_id) references projects_v2(id),
      foreign key(job_id) references jobs(id),
      foreign key(task_contract_id) references task_contracts(id),
      foreign key(context_pack_id) references context_packs(id)
    );
    create index if not exists idx_run_state_revisions_project_run
      on run_state_revisions(project_id, run_id, revision desc);
    create index if not exists idx_run_state_revisions_job
      on run_state_revisions(job_id, revision desc);
    create index if not exists idx_run_state_revisions_task_contract
      on run_state_revisions(task_contract_id, revision);
    create index if not exists idx_run_state_revisions_context_pack
      on run_state_revisions(context_pack_id) where context_pack_id is not null;

    create table if not exists run_job_links (
      run_id text not null,
      project_id text not null,
      job_id text primary key,
      predecessor_job_id text,
      resume_checkpoint_id text,
      lineage_sequence integer not null check(lineage_sequence > 0),
      linked_at_revision integer not null check(linked_at_revision >= 0),
      created_at text not null,
      check((predecessor_job_id is null and resume_checkpoint_id is null) or
        (predecessor_job_id is not null and resume_checkpoint_id is not null)),
      foreign key(project_id) references projects_v2(id),
      foreign key(job_id) references jobs(id),
      foreign key(predecessor_job_id) references jobs(id),
      foreign key(resume_checkpoint_id) references checkpoints(id),
      unique(run_id, lineage_sequence)
    );
    create index if not exists idx_run_job_links_run_sequence
      on run_job_links(project_id, run_id, lineage_sequence desc);

    create trigger if not exists trg_task_contracts_no_update
      before update on task_contracts begin select raise(abort, 'task_contracts rows are immutable'); end;
    create trigger if not exists trg_task_contracts_no_delete
      before delete on task_contracts begin select raise(abort, 'task_contracts rows are immutable'); end;
    create trigger if not exists trg_context_packs_no_update
      before update on context_packs begin select raise(abort, 'context_packs rows are immutable'); end;
    create trigger if not exists trg_context_packs_no_delete
      before delete on context_packs begin select raise(abort, 'context_packs rows are immutable'); end;
    create trigger if not exists trg_run_state_revisions_no_update
      before update on run_state_revisions begin select raise(abort, 'run_state_revisions rows are immutable'); end;
    create trigger if not exists trg_run_state_revisions_no_delete
      before delete on run_state_revisions begin select raise(abort, 'run_state_revisions rows are immutable'); end;
    create trigger if not exists trg_run_job_links_no_update
      before update on run_job_links begin select raise(abort, 'run_job_links rows are immutable'); end;
    create trigger if not exists trg_run_job_links_no_delete
      before delete on run_job_links begin select raise(abort, 'run_job_links rows are immutable'); end;

    insert into schema_migrations (version, name, checksum_sha256, applied_at)
      values (5, 'operational-run-state-v5', 'cafec8f620174e7d61e931dd034073b4373be9f17b3059a4bca7ee7d0bc6ccf7', datetime('now'))
      on conflict(version) do nothing;
  `);
}

export function assertStorageRunStateV5SchemaReady(db: DatabaseSync): void {
  const migration = db.prepare("select name, checksum_sha256 from schema_migrations where version=?").get(STORAGE_RUN_STATE_SCHEMA_VERSION) as
    { name?: unknown; checksum_sha256?: unknown } | undefined;
  assertMigrationIdentity(migration);
  assertColumns(db, "task_contracts", ["id", "project_id", "schema_version", "content_hash", "created_at", "data"]);
  assertColumns(db, "context_packs", [
    "id",
    "project_id",
    "run_id",
    "job_id",
    "schema_version",
    "state_revision",
    "task_contract_id",
    "task_contract_hash",
    "content_hash",
    "created_at",
    "data"
  ]);
  assertColumns(db, "run_state_revisions", [
    "id",
    "project_id",
    "run_id",
    "job_id",
    "schema_version",
    "revision",
    "previous_revision",
    "parent_revision_hash",
    "state_hash",
    "task_contract_id",
    "task_contract_hash",
    "context_pack_id",
    "created_at",
    "data"
  ]);
  assertColumns(db, "run_job_links", [
    "run_id",
    "project_id",
    "job_id",
    "predecessor_job_id",
    "resume_checkpoint_id",
    "lineage_sequence",
    "linked_at_revision",
    "created_at"
  ]);
  assertIndexes(db, "task_contracts", ["idx_task_contracts_project_created"]);
  assertIndexes(db, "context_packs", ["idx_context_packs_project_run_revision", "idx_context_packs_job_revision", "idx_context_packs_task_contract"]);
  assertIndexes(db, "run_state_revisions", [
    "idx_run_state_revisions_project_run",
    "idx_run_state_revisions_job",
    "idx_run_state_revisions_task_contract",
    "idx_run_state_revisions_context_pack"
  ]);
  assertIndexes(db, "run_job_links", ["idx_run_job_links_run_sequence"]);
  assertForeignKeys(db, "task_contracts", ["projects_v2"]);
  assertForeignKeys(db, "context_packs", ["projects_v2", "jobs", "task_contracts"]);
  assertForeignKeys(db, "run_state_revisions", ["projects_v2", "jobs", "task_contracts", "context_packs"]);
  assertForeignKeys(db, "run_job_links", ["projects_v2", "jobs", "checkpoints"]);
  const triggers = new Set(
    (db.prepare("select name from sqlite_master where type='trigger'").all() as Array<{ name?: unknown }>).map((row) => String(row.name))
  );
  for (const name of [
    "trg_task_contracts_no_update",
    "trg_task_contracts_no_delete",
    "trg_context_packs_no_update",
    "trg_context_packs_no_delete",
    "trg_run_state_revisions_no_update",
    "trg_run_state_revisions_no_delete",
    "trg_run_job_links_no_update",
    "trg_run_job_links_no_delete"
  ]) {
    if (!triggers.has(name)) throw new Error(`Storage run-state immutability trigger is missing: ${name}`);
  }
}

function assertMigrationIdentity(migration: { name?: unknown; checksum_sha256?: unknown } | undefined): void {
  if (migration?.name !== STORAGE_RUN_STATE_MIGRATION_NAME || migration.checksum_sha256 !== STORAGE_RUN_STATE_MIGRATION_CHECKSUM) {
    throw new Error("Storage run-state migration ledger is missing or has an unexpected checksum.");
  }
}

function assertColumns(db: DatabaseSync, table: string, required: readonly string[]): void {
  const columns = new Set((db.prepare(`pragma table_info(${table})`).all() as Array<{ name?: unknown }>).map((row) => String(row.name)));
  for (const name of required) if (!columns.has(name)) throw new Error(`Storage run-state column is missing: ${table}.${name}`);
}

function assertIndexes(db: DatabaseSync, table: string, required: readonly string[]): void {
  const indexes = new Set((db.prepare(`pragma index_list(${table})`).all() as Array<{ name?: unknown }>).map((row) => String(row.name)));
  for (const name of required) if (!indexes.has(name)) throw new Error(`Storage run-state index is missing: ${name}`);
}

function assertForeignKeys(db: DatabaseSync, table: string, requiredTables: readonly string[]): void {
  const targets = new Set((db.prepare(`pragma foreign_key_list(${table})`).all() as Array<{ table?: unknown }>).map((row) => String(row.table)));
  for (const target of requiredTables) if (!targets.has(target)) throw new Error(`Storage run-state foreign key is missing: ${table}->${target}`);
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
