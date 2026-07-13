import type { DatabaseSync } from "node:sqlite";

export const STORAGE_JOB_SCHEMA_VERSION = 4;
export const STORAGE_JOB_MIGRATION_NAME = "operational-job-fencing-v4";
export const STORAGE_JOB_MIGRATION_CHECKSUM = "2d0d46ff98928bb5240f5452a9e5d513ec1a050aecf11507139465854927f073";

const activeStatuses = "'running','pause_requested','cancel_requested'";

export function migrateStorageJobV4Schema(db: DatabaseSync): void {
  runAtomically(db, () => {
    db.exec(`
      create table if not exists schema_migrations (
        version integer primary key,
        name text not null,
        checksum_sha256 text not null,
        applied_at text not null
      )
    `);
    const installed = db.prepare("select name,checksum_sha256 from schema_migrations where version=?").get(STORAGE_JOB_SCHEMA_VERSION) as
      { name?: unknown; checksum_sha256?: unknown } | undefined;
    if (installed) {
      if (installed.name !== STORAGE_JOB_MIGRATION_NAME || installed.checksum_sha256 !== STORAGE_JOB_MIGRATION_CHECKSUM) {
        throw new Error("Storage job fencing migration ledger has an unexpected checksum.");
      }
      return;
    }
    const columns = tableColumnNames(db, "jobs");
    if (!columns.has("lease_generation")) {
      db.exec("alter table jobs add column lease_generation integer not null default 0");
    }

    // The migration runs without the worker process that owned an old lease.
    // Retaining an active row would either violate the project guard or strand
    // the lane, so every pre-migration active row becomes resumable history.
    db.prepare(
      `update jobs set status='interrupted',
       error=coalesce(error, 'migration_active_job_interrupted'),
       lease_owner=null, lease_expires_at=null,
       completed_at=coalesce(completed_at, updated_at, created_at)
       where status in (${activeStatuses})`
    ).run();

    installStorageJobV4Objects(db);
  });
  assertStorageJobV4SchemaReady(db);
}

function installStorageJobV4Objects(db: DatabaseSync): void {
  // This literal is also extracted by the offline Migration Coordinator. Keep its ledger values in sync with the exported constants above.
  db.exec(`
    drop index if exists idx_jobs_project_lane;
    drop index if exists idx_jobs_ready;
    create index idx_jobs_project_lane on jobs(project_id, status, queued_at, id);
    create index idx_jobs_ready on jobs(status, queued_at, id);
    create unique index if not exists idx_jobs_one_active_project on jobs(project_id)
      where status in ('running','pause_requested','cancel_requested');
    create index if not exists idx_jobs_lease_generation on jobs(id, attempt, lease_generation, lease_owner, lease_expires_at);
    insert into schema_migrations (version, name, checksum_sha256, applied_at)
      values (4, 'operational-job-fencing-v4', '2d0d46ff98928bb5240f5452a9e5d513ec1a050aecf11507139465854927f073', datetime('now'))
      on conflict(version) do nothing;
  `);
}

export function assertStorageJobV4SchemaReady(db: DatabaseSync): void {
  const migration = db.prepare("select name, checksum_sha256 from schema_migrations where version=?").get(STORAGE_JOB_SCHEMA_VERSION) as
    { name?: unknown; checksum_sha256?: unknown } | undefined;
  if (migration?.name !== STORAGE_JOB_MIGRATION_NAME || migration.checksum_sha256 !== STORAGE_JOB_MIGRATION_CHECKSUM) {
    throw new Error("Storage job fencing migration ledger is missing or has an unexpected checksum.");
  }
  if (!tableColumnNames(db, "jobs").has("lease_generation")) throw new Error("Storage jobs lease_generation column is missing.");
  const indexes = new Set((db.prepare("pragma index_list(jobs)").all() as Array<{ name?: unknown }>).map((row) => String(row.name)));
  for (const index of ["idx_jobs_project_lane", "idx_jobs_ready", "idx_jobs_one_active_project", "idx_jobs_lease_generation"]) {
    if (!indexes.has(index)) throw new Error(`Storage jobs fencing index is missing: ${index}`);
  }
}

function tableColumnNames(db: DatabaseSync, table: string): Set<string> {
  return new Set((db.prepare(`pragma table_info(${table})`).all() as Array<{ name?: unknown }>).map((row) => String(row.name)));
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
