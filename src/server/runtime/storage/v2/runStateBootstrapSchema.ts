import type { DatabaseSync } from "node:sqlite";

export const STORAGE_RUN_STATE_BOOTSTRAP_SCHEMA_VERSION = 7;
export const STORAGE_RUN_STATE_BOOTSTRAP_MIGRATION_NAME = "operational-run-state-bootstrap-v7";
export const STORAGE_RUN_STATE_BOOTSTRAP_MIGRATION_CHECKSUM = "a353804ffc30594cf5e0e4e48c60e5dab900c011d16cc4f80d72e68720fe772d";

export function migrateStorageRunStateBootstrapV7Schema(db: DatabaseSync): void {
  runAtomically(db, () => {
    const installed = migration(db);
    if (installed) {
      assertMigrationIdentity(installed);
      return;
    }
    installStorageRunStateBootstrapV7Objects(db);
  });
  assertStorageRunStateBootstrapV7SchemaReady(db);
}

function installStorageRunStateBootstrapV7Objects(db: DatabaseSync): void {
  // The offline Migration Coordinator extracts this literal. Keep the ledger values synchronized with the exported constants.
  db.exec(`
    create table run_job_links_v7 (
      run_id text not null,
      project_id text not null,
      job_id text primary key,
      predecessor_job_id text,
      resume_checkpoint_id text,
      link_kind text not null check(link_kind in ('root', 'resume', 'bootstrap')),
      lineage_sequence integer not null check(lineage_sequence > 0),
      linked_at_revision integer not null check(linked_at_revision >= 0),
      created_at text not null,
      check(
        (link_kind = 'root' and predecessor_job_id is null and resume_checkpoint_id is null) or
        (link_kind = 'resume' and predecessor_job_id is not null and resume_checkpoint_id is not null) or
        (link_kind = 'bootstrap' and predecessor_job_id is not null and resume_checkpoint_id is null)
      ),
      foreign key(project_id) references projects_v2(id),
      foreign key(job_id) references jobs(id),
      foreign key(predecessor_job_id) references jobs(id),
      foreign key(resume_checkpoint_id) references checkpoints(id),
      unique(run_id, lineage_sequence)
    );
    insert into run_job_links_v7
      (run_id,project_id,job_id,predecessor_job_id,resume_checkpoint_id,link_kind,lineage_sequence,linked_at_revision,created_at)
      select run_id,project_id,job_id,predecessor_job_id,resume_checkpoint_id,
        case when predecessor_job_id is null then 'root' else 'resume' end,
        lineage_sequence,linked_at_revision,created_at
      from run_job_links;
    drop table run_job_links;
    alter table run_job_links_v7 rename to run_job_links;
    create index idx_run_job_links_run_sequence
      on run_job_links(project_id, run_id, lineage_sequence desc);
    create trigger trg_run_job_links_no_update
      before update on run_job_links begin select raise(abort, 'run_job_links rows are immutable'); end;
    create trigger trg_run_job_links_no_delete
      before delete on run_job_links begin select raise(abort, 'run_job_links rows are immutable'); end;
    insert into schema_migrations (version, name, checksum_sha256, applied_at)
      values (7, 'operational-run-state-bootstrap-v7', 'a353804ffc30594cf5e0e4e48c60e5dab900c011d16cc4f80d72e68720fe772d', datetime('now'));
  `);
}

export function assertStorageRunStateBootstrapV7SchemaReady(db: DatabaseSync): void {
  assertMigrationIdentity(migration(db));
  const columns = new Set((db.prepare("pragma table_info(run_job_links)").all() as Array<{ name?: unknown }>).map((row) => String(row.name)));
  if (!columns.has("link_kind")) throw new Error("Storage run-state bootstrap lineage kind is missing.");
  const table = db.prepare("select sql from sqlite_master where type='table' and name='run_job_links'").get() as { sql?: unknown } | undefined;
  if (typeof table?.sql !== "string" || !table.sql.includes("'bootstrap'")) {
    throw new Error("Storage run-state bootstrap lineage constraint is missing.");
  }
}

function migration(db: DatabaseSync): { name?: unknown; checksum_sha256?: unknown } | undefined {
  return db.prepare("select name,checksum_sha256 from schema_migrations where version=?").get(STORAGE_RUN_STATE_BOOTSTRAP_SCHEMA_VERSION) as
    { name?: unknown; checksum_sha256?: unknown } | undefined;
}

function assertMigrationIdentity(value: { name?: unknown; checksum_sha256?: unknown } | undefined): void {
  if (value?.name !== STORAGE_RUN_STATE_BOOTSTRAP_MIGRATION_NAME || value.checksum_sha256 !== STORAGE_RUN_STATE_BOOTSTRAP_MIGRATION_CHECKSUM) {
    throw new Error("Storage run-state bootstrap migration ledger is missing or has an unexpected checksum.");
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
