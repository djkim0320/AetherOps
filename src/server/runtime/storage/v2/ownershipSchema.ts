import type { DatabaseSync } from "node:sqlite";

export const STORAGE_OWNERSHIP_SCHEMA_VERSION = 10;
export const STORAGE_OWNERSHIP_MIGRATION_NAME = "operational-storage-ownership-v10";
export const STORAGE_OWNERSHIP_MIGRATION_CHECKSUM = "fbd45f9ddf0dc7484ad5f11858a705b703a736423fcfbf6b1ae3f824ce3e5861";

const OWNERSHIP_TRIGGERS = [
  "trg_capability_audits_owner_insert",
  "trg_capability_audits_owner_update",
  "trg_tool_attempts_owner_insert",
  "trg_tool_attempts_owner_update",
  "trg_tool_output_links_owner_insert",
  "trg_tool_output_links_owner_update"
] as const;

export function migrateStorageOwnershipV10Schema(db: DatabaseSync): void {
  runAtomically(db, () => {
    const installed = migration(db);
    if (installed) {
      assertMigrationIdentity(installed);
      return;
    }
    installStorageOwnershipV10Objects(db);
  });
  assertStorageOwnershipV10SchemaReady(db);
}

function installStorageOwnershipV10Objects(db: DatabaseSync): void {
  // The offline Migration Coordinator extracts this literal. Keep the ledger values synchronized with the exported constants.
  db.exec(`
    create trigger trg_capability_audits_owner_insert before insert on capability_audits
      when new.job_id is not null and not exists (
        select 1 from jobs where id=new.job_id and project_id=new.project_id
      ) begin select raise(abort, 'capability audit owner is unavailable'); end;
    create trigger trg_capability_audits_owner_update before update on capability_audits
      when new.job_id is not null and not exists (
        select 1 from jobs where id=new.job_id and project_id=new.project_id
      ) begin select raise(abort, 'capability audit owner is unavailable'); end;
    create trigger trg_tool_attempts_owner_insert before insert on tool_attempts
      when not exists (
        select 1 from jobs where id=new.job_id and project_id=new.project_id
      ) or not exists (
        select 1 from tool_decisions where id=new.decision_id and job_id=new.job_id and project_id=new.project_id
      ) begin select raise(abort, 'tool attempt owner is unavailable'); end;
    create trigger trg_tool_attempts_owner_update before update on tool_attempts
      when not exists (
        select 1 from jobs where id=new.job_id and project_id=new.project_id
      ) or not exists (
        select 1 from tool_decisions where id=new.decision_id and job_id=new.job_id and project_id=new.project_id
      ) begin select raise(abort, 'tool attempt owner is unavailable'); end;
    create trigger trg_tool_output_links_owner_insert before insert on tool_output_links
      when not exists (
        select 1 from tool_attempts where id=new.attempt_id and job_id=new.job_id and project_id=new.project_id
      ) begin select raise(abort, 'tool output link owner is unavailable'); end;
    create trigger trg_tool_output_links_owner_update before update on tool_output_links
      when not exists (
        select 1 from tool_attempts where id=new.attempt_id and job_id=new.job_id and project_id=new.project_id
      ) begin select raise(abort, 'tool output link owner is unavailable'); end;
    insert into schema_migrations (version, name, checksum_sha256, applied_at)
      values (10, 'operational-storage-ownership-v10', 'fbd45f9ddf0dc7484ad5f11858a705b703a736423fcfbf6b1ae3f824ce3e5861', datetime('now'));
  `);
}

export function assertStorageOwnershipV10SchemaReady(db: DatabaseSync): void {
  assertMigrationIdentity(migration(db));
  const triggers = new Set(
    (db.prepare("select name from sqlite_master where type='trigger'").all() as Array<{ name?: unknown }>).map((row) => String(row.name))
  );
  for (const name of OWNERSHIP_TRIGGERS) if (!triggers.has(name)) throw new Error(`Storage ownership trigger is missing: ${name}`);
}

function migration(db: DatabaseSync): { name?: unknown; checksum_sha256?: unknown } | undefined {
  return db.prepare("select name,checksum_sha256 from schema_migrations where version=?").get(STORAGE_OWNERSHIP_SCHEMA_VERSION) as
    { name?: unknown; checksum_sha256?: unknown } | undefined;
}

function assertMigrationIdentity(value: { name?: unknown; checksum_sha256?: unknown } | undefined): void {
  if (value?.name !== STORAGE_OWNERSHIP_MIGRATION_NAME || value.checksum_sha256 !== STORAGE_OWNERSHIP_MIGRATION_CHECKSUM) {
    throw new Error("Storage ownership migration ledger is missing or has an unexpected checksum.");
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
