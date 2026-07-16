import type { DatabaseSync } from "node:sqlite";

export const STORAGE_ENGINEERING_BASELINE_SCHEMA_VERSION = 12;
export const STORAGE_ENGINEERING_BASELINE_MIGRATION_NAME = "operational-engineering-baselines-v12";
export const STORAGE_ENGINEERING_BASELINE_MIGRATION_CHECKSUM = "f870d3669d92b0ed9d5f2b7b220a43d8a89bd98d064d0ada999e54cc2ec1125d";

const TABLES = [
  "engineering_configuration_baselines",
  "engineering_active_baselines",
  "engineering_result_promotions",
  "engineering_artifact_read_receipts"
] as const;

const TRIGGERS = [
  "trg_engineering_baselines_revision_insert",
  "trg_engineering_baselines_no_update",
  "trg_engineering_baselines_no_delete",
  "trg_engineering_active_baseline_insert",
  "trg_engineering_active_baseline_update",
  "trg_engineering_active_baseline_no_delete",
  "trg_engineering_promotions_owner_insert",
  "trg_engineering_promotions_stale_only",
  "trg_engineering_promotions_no_delete",
  "trg_engineering_reads_owner_insert",
  "trg_engineering_reads_no_update",
  "trg_engineering_reads_no_delete"
] as const;

export function migrateStorageEngineeringBaselineV12Schema(db: DatabaseSync): void {
  runAtomically(db, () => {
    const installed = migration(db);
    if (installed) {
      assertMigrationIdentity(installed);
      return;
    }
    installStorageEngineeringBaselineV12Objects(db);
  });
  assertStorageEngineeringBaselineV12SchemaReady(db);
}

function installStorageEngineeringBaselineV12Objects(db: DatabaseSync): void {
  // The offline Migration Coordinator extracts this literal. Keep ledger identity synchronized with the exported constants.
  db.exec(`
    create table engineering_configuration_baselines (
      id text primary key,
      project_id text not null,
      revision integer not null check(revision > 0),
      content_hash text not null check(length(content_hash) = 64),
      created_at text not null,
      created_by text not null,
      change_reason text not null,
      data text not null,
      unique(project_id, revision),
      unique(project_id, content_hash),
      foreign key(project_id) references projects_v2(id)
    );
    create index idx_engineering_baselines_project_revision
      on engineering_configuration_baselines(project_id, revision desc);
    create table engineering_active_baselines (
      project_id text primary key,
      baseline_id text not null unique,
      revision integer not null check(revision > 0),
      content_hash text not null check(length(content_hash) = 64),
      generation integer not null check(generation > 0),
      updated_at text not null,
      foreign key(project_id) references projects_v2(id),
      foreign key(baseline_id) references engineering_configuration_baselines(id)
    );
    create table engineering_result_promotions (
      id text primary key,
      schema_version integer not null check(schema_version = 1),
      project_id text not null,
      job_id text not null,
      attempt_id text not null,
      output_link_id text not null unique,
      output_id text not null,
      result_kind text not null check(result_kind in (
        'aerodynamic_coefficient','dimensional_force','dimensional_moment','geometry','polar',
        'performance_metric','simulation_field','engineering_report','generic_scalar'
      )),
      baseline_id text not null,
      baseline_revision integer not null check(baseline_revision > 0),
      baseline_content_hash text not null check(length(baseline_content_hash) = 64),
      baseline_dependency_hash text not null check(length(baseline_dependency_hash) = 64),
      dependency_aspects text not null,
      geometry_hash text,
      artifact_hash text not null check(length(artifact_hash) = 64),
      artifact_bytes integer not null check(artifact_bytes >= 0),
      media_type text not null,
      cas_locator text not null,
      tool_name text not null,
      tool_version text not null,
      execution_media text not null,
      tool_receipt_hash text not null check(length(tool_receipt_hash) = 64),
      reference_geometry_hash text,
      convergence text not null check(convergence in ('converged','not_applicable','failed')),
      domain_assessment text not null check(domain_assessment in ('verified','not_assessed','outside_domain')),
      postcondition text not null check(postcondition in ('passed','not_required','failed')),
      postcondition_receipt_hash text,
      sensitivity text not null check(sensitivity in ('public','project','private','secret')),
      promoted_at text not null,
      stale_at text,
      stale_reason text,
      receipt_hash text not null check(length(receipt_hash) = 64),
      data text not null,
      foreign key(project_id) references projects_v2(id),
      foreign key(job_id) references jobs(id),
      foreign key(attempt_id) references tool_attempts(id),
      foreign key(output_link_id) references tool_output_links(id),
      foreign key(baseline_id) references engineering_configuration_baselines(id)
    );
    create index idx_engineering_promotions_project_baseline
      on engineering_result_promotions(project_id, baseline_revision, stale_at, promoted_at);
    create index idx_engineering_promotions_job
      on engineering_result_promotions(job_id, attempt_id, output_link_id);
    create table engineering_artifact_read_receipts (
      id text primary key,
      project_id text not null,
      promotion_id text not null,
      artifact_hash text not null check(length(artifact_hash) = 64),
      byte_length integer not null check(byte_length >= 0),
      complete integer not null check(complete in (0,1)),
      reader_version text not null,
      read_at text not null,
      receipt_hash text not null check(length(receipt_hash) = 64),
      foreign key(project_id) references projects_v2(id),
      foreign key(promotion_id) references engineering_result_promotions(id)
    );
    create index idx_engineering_reads_promotion
      on engineering_artifact_read_receipts(promotion_id, read_at desc, id);
    create trigger trg_engineering_baselines_revision_insert before insert on engineering_configuration_baselines
      when new.revision <> coalesce((select max(b.revision) + 1 from engineering_configuration_baselines b where b.project_id=new.project_id), 1)
      begin select raise(abort, 'engineering configuration baseline revision is not monotonic'); end;
    create trigger trg_engineering_baselines_no_update before update on engineering_configuration_baselines
      begin select raise(abort, 'engineering configuration baselines are immutable'); end;
    create trigger trg_engineering_baselines_no_delete before delete on engineering_configuration_baselines
      begin select raise(abort, 'engineering configuration baselines are immutable'); end;
    create trigger trg_engineering_active_baseline_insert before insert on engineering_active_baselines
      when new.generation<>1 or not exists (
        select 1 from engineering_configuration_baselines b
        where b.id=new.baseline_id and b.project_id=new.project_id and b.revision=new.revision and b.content_hash=new.content_hash
      ) begin select raise(abort, 'active engineering baseline owner is unavailable'); end;
    create trigger trg_engineering_active_baseline_update before update on engineering_active_baselines
      when new.project_id<>old.project_id or new.generation<>old.generation+1 or new.revision<>old.revision+1 or not exists (
        select 1 from engineering_configuration_baselines b
        where b.id=new.baseline_id and b.project_id=new.project_id and b.revision=new.revision and b.content_hash=new.content_hash
      ) begin select raise(abort, 'active engineering baseline transition is invalid'); end;
    create trigger trg_engineering_active_baseline_no_delete before delete on engineering_active_baselines
      begin select raise(abort, 'active engineering baseline pointers cannot be deleted'); end;
    create trigger trg_engineering_promotions_owner_insert before insert on engineering_result_promotions
      when not exists (
        select 1 from tool_output_links l join tool_attempts a on a.id=l.attempt_id
        join engineering_active_baselines b on b.project_id=l.project_id
        where l.id=new.output_link_id and l.output_id=new.output_id and l.project_id=new.project_id and l.job_id=new.job_id
          and l.attempt_id=new.attempt_id and l.promoted=1 and a.status='completed'
          and b.baseline_id=new.baseline_id and b.revision=new.baseline_revision and b.content_hash=new.baseline_content_hash
      ) begin select raise(abort, 'engineering result promotion owner or active baseline is unavailable'); end;
    create trigger trg_engineering_promotions_stale_only before update on engineering_result_promotions
      when old.stale_at is not null or new.stale_at is null or new.stale_reason is null
        or new.id is not old.id or new.schema_version is not old.schema_version or new.project_id is not old.project_id
        or new.job_id is not old.job_id or new.attempt_id is not old.attempt_id or new.output_link_id is not old.output_link_id
        or new.output_id is not old.output_id or new.result_kind is not old.result_kind or new.baseline_id is not old.baseline_id
        or new.baseline_revision is not old.baseline_revision or new.baseline_content_hash is not old.baseline_content_hash
        or new.baseline_dependency_hash is not old.baseline_dependency_hash or new.dependency_aspects is not old.dependency_aspects
        or new.geometry_hash is not old.geometry_hash or new.artifact_hash is not old.artifact_hash
        or new.artifact_bytes is not old.artifact_bytes or new.media_type is not old.media_type or new.cas_locator is not old.cas_locator
        or new.tool_name is not old.tool_name or new.tool_version is not old.tool_version or new.execution_media is not old.execution_media
        or new.tool_receipt_hash is not old.tool_receipt_hash or new.reference_geometry_hash is not old.reference_geometry_hash
        or new.convergence is not old.convergence or new.domain_assessment is not old.domain_assessment
        or new.postcondition is not old.postcondition or new.postcondition_receipt_hash is not old.postcondition_receipt_hash
        or new.sensitivity is not old.sensitivity or new.promoted_at is not old.promoted_at
        or new.receipt_hash is not old.receipt_hash or new.data is not old.data
      begin select raise(abort, 'engineering result promotion is immutable except for one stale transition'); end;
    create trigger trg_engineering_promotions_no_delete before delete on engineering_result_promotions
      begin select raise(abort, 'engineering result promotions are immutable'); end;
    create trigger trg_engineering_reads_owner_insert before insert on engineering_artifact_read_receipts
      when not exists (
        select 1 from engineering_result_promotions p
        where p.id=new.promotion_id and p.project_id=new.project_id
          and p.artifact_hash=new.artifact_hash and p.artifact_bytes=new.byte_length
      ) begin select raise(abort, 'engineering artifact read owner is unavailable'); end;
    create trigger trg_engineering_reads_no_update before update on engineering_artifact_read_receipts
      begin select raise(abort, 'engineering artifact read receipts are immutable'); end;
    create trigger trg_engineering_reads_no_delete before delete on engineering_artifact_read_receipts
      begin select raise(abort, 'engineering artifact read receipts are immutable'); end;
    insert into schema_migrations (version, name, checksum_sha256, applied_at)
      values (12, 'operational-engineering-baselines-v12', 'f870d3669d92b0ed9d5f2b7b220a43d8a89bd98d064d0ada999e54cc2ec1125d', datetime('now'));
  `);
}

export function assertStorageEngineeringBaselineV12SchemaReady(db: DatabaseSync): void {
  assertMigrationIdentity(migration(db));
  const tables = names(db, "select name from sqlite_master where type='table'");
  for (const name of TABLES) if (!tables.has(name)) throw new Error(`Storage engineering baseline table is missing: ${name}`);
  const triggers = names(db, "select name from sqlite_master where type='trigger'");
  for (const name of TRIGGERS) if (!triggers.has(name)) throw new Error(`Storage engineering baseline trigger is missing: ${name}`);
  assertColumns(db, "engineering_configuration_baselines", ["project_id", "revision", "content_hash", "change_reason", "data"]);
  assertColumns(db, "engineering_result_promotions", [
    "output_link_id",
    "baseline_dependency_hash",
    "artifact_hash",
    "cas_locator",
    "reference_geometry_hash",
    "stale_at",
    "receipt_hash"
  ]);
}

function assertColumns(db: DatabaseSync, table: string, required: readonly string[]): void {
  const columns = names(db, `pragma table_info(${table})`);
  for (const name of required) if (!columns.has(name)) throw new Error(`Storage engineering baseline column is missing: ${table}.${name}`);
}

function names(db: DatabaseSync, sql: string): Set<string> {
  return new Set((db.prepare(sql).all() as Array<{ name?: unknown }>).map((row) => String(row.name)));
}

function migration(db: DatabaseSync): { name?: unknown; checksum_sha256?: unknown } | undefined {
  return db.prepare("select name,checksum_sha256 from schema_migrations where version=?").get(STORAGE_ENGINEERING_BASELINE_SCHEMA_VERSION) as
    { name?: unknown; checksum_sha256?: unknown } | undefined;
}

function assertMigrationIdentity(value: { name?: unknown; checksum_sha256?: unknown } | undefined): void {
  if (value?.name !== STORAGE_ENGINEERING_BASELINE_MIGRATION_NAME || value.checksum_sha256 !== STORAGE_ENGINEERING_BASELINE_MIGRATION_CHECKSUM) {
    throw new Error("Storage engineering baseline migration ledger is missing or has an unexpected checksum.");
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
