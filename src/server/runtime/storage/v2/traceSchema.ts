import type { DatabaseSync } from "node:sqlite";

export const STORAGE_TRACE_V3_MIGRATION_CHECKSUM = "a239551be946dd20dfa78120fd3d176a98a936f80c5b4615c0cb01027f39828d";
export const STORAGE_TRACE_SCHEMA_VERSION = 6;
export const STORAGE_TRACE_MIGRATION_NAME = "operational-tool-postcondition-receipts-v6";
export const STORAGE_TRACE_MIGRATION_CHECKSUM = "271563c4a547ba1c1d50faef37cc391e5a519d3477d8d9135b4f253e933da1e4";

const JOB_TRACE_COLUMNS = [
  ["request_hash", "text"],
  ["requested_capabilities", "text"],
  ["effective_capabilities", "text"],
  ["tool_policy", "text"],
  ["blocked_reason", "text"],
  ["failure_reason", "text"]
] as const;

export function migrateStorageTraceV3Schema(db: DatabaseSync): void {
  assertMigrationIdentityIfPresent(db, 3, "operational-codex-trace-v3", STORAGE_TRACE_V3_MIGRATION_CHECKSUM);
  assertMigrationIdentityIfPresent(db, STORAGE_TRACE_SCHEMA_VERSION, STORAGE_TRACE_MIGRATION_NAME, STORAGE_TRACE_MIGRATION_CHECKSUM);
  db.exec(`
    create table if not exists schema_migrations (
      version integer primary key,
      name text not null,
      checksum_sha256 text not null,
      applied_at text not null
    );

    create table if not exists llm_invocations (
      id text primary key,
      project_id text not null,
      job_id text not null,
      model text not null,
      reasoning_effort text not null,
      prompt_version text not null,
      schema_version text not null,
      prompt_hash text not null,
      response_hash text,
      latency_ms integer,
      repair_count integer not null default 0 check(repair_count between 0 and 1),
      status text not null check(status in ('running', 'completed', 'failed')),
      error text,
      started_at text not null,
      completed_at text,
      data text
    );
    create index if not exists idx_llm_invocations_job on llm_invocations(job_id, started_at, id);
    create index if not exists idx_llm_invocations_project on llm_invocations(project_id, started_at);

    create table if not exists tool_decisions (
      id text primary key,
      project_id text not null,
      job_id text not null,
      invocation_id text,
      tool_name text not null,
      purpose text not null,
      expected_outcome text not null,
      raw_selection text not null,
      user_pinned integer not null default 0 check(user_pinned in (0, 1)),
      policy_status text not null check(policy_status in ('accepted', 'rejected')),
      policy_reason text,
      compiled_action text,
      created_at text not null,
      data text
    );
    create index if not exists idx_tool_decisions_job on tool_decisions(job_id, created_at, id);
    create index if not exists idx_tool_decisions_invocation on tool_decisions(invocation_id, created_at);

    create table if not exists tool_attempts (
      id text primary key,
      project_id text not null,
      job_id text not null,
      decision_id text not null,
      checkpoint_id text,
      ordinal integer not null,
      status text not null check(status in ('queued', 'running', 'completed', 'blocked', 'failed', 'interrupted', 'quarantined')),
      input_hash text not null,
      output_hash text,
      trace_version integer check(trace_version = 1),
      descriptor_version text,
      descriptor_side_effects text,
      side_effect_key text,
      idempotency_key text,
      postcondition_disposition text check(postcondition_disposition in ('applied', 'not_applied')),
      postcondition_receipt text,
      terminal_cause text,
      depends_on_attempt_ids text not null default '[]',
      staging_ref text,
      quarantine_ref text,
      error text,
      queued_at text not null,
      started_at text,
      completed_at text,
      data text
    );
    create index if not exists idx_tool_attempts_job on tool_attempts(job_id, ordinal, queued_at, id);
    create index if not exists idx_tool_attempts_job_queued on tool_attempts(job_id, queued_at, id);
    create index if not exists idx_tool_attempts_decision on tool_attempts(decision_id, queued_at);
    create index if not exists idx_tool_attempts_status on tool_attempts(project_id, status, queued_at);

    create table if not exists tool_output_links (
      id text primary key,
      project_id text not null,
      job_id text not null,
      attempt_id text not null,
      output_kind text not null check(output_kind in ('source', 'evidence', 'artifact')),
      output_id text not null,
      promoted integer not null default 0 check(promoted in (0, 1)),
      created_at text not null,
      promoted_at text,
      data text
    );
    create unique index if not exists idx_tool_output_links_attempt_output on tool_output_links(attempt_id, output_kind, output_id);
    create index if not exists idx_tool_output_links_job on tool_output_links(job_id, created_at, id);

    create table if not exists network_audits (
      id text primary key,
      project_id text not null,
      job_id text not null,
      attempt_id text,
      url text not null,
      redirect_chain text not null,
      source_policy text not null,
      policy_decision text not null check(policy_decision in ('allowed', 'denied')),
      reason text,
      audited_at text not null,
      data text
    );
    create index if not exists idx_network_audits_job on network_audits(job_id, audited_at, id);
    create index if not exists idx_network_audits_attempt on network_audits(attempt_id, audited_at);

    create table if not exists codex_cli_executions (
      id text primary key,
      project_id text not null,
      job_id text not null,
      attempt_id text not null,
      model text not null,
      reasoning_effort text not null,
      sandbox_profile text not null,
      network_policy text not null check(network_policy = 'disabled'),
      duration_ms integer,
      exit_code integer,
      termination_reason text,
      event_count integer not null default 0 check(event_count >= 0),
      workspace_manifest_hash text,
      output_manifest_hash text,
      created_at text not null,
      completed_at text,
      data text
    );
    create unique index if not exists idx_codex_cli_executions_attempt on codex_cli_executions(attempt_id);
    create index if not exists idx_codex_cli_executions_job on codex_cli_executions(job_id, created_at, id);

    insert into schema_migrations (version, name, checksum_sha256, applied_at)
    values (2, 'operational-trace-v2', '99b17d1e0aebc8bb0a2c29084f2f44a263d6644a551a2116429542a20e24016c', datetime('now'))
    on conflict(version) do nothing;

    insert into schema_migrations (version, name, checksum_sha256, applied_at)
    values (3, 'operational-codex-trace-v3', 'a239551be946dd20dfa78120fd3d176a98a936f80c5b4615c0cb01027f39828d', datetime('now'))
    on conflict(version) do nothing;

    insert into schema_migrations (version, name, checksum_sha256, applied_at)
    values (6, 'operational-tool-postcondition-receipts-v6', '271563c4a547ba1c1d50faef37cc391e5a519d3477d8d9135b4f253e933da1e4', datetime('now'))
    on conflict(version) do nothing;
  `);

  addMissingJobTraceColumns(db);
  addMissingToolAttemptColumns(db);
  assertStorageTraceSchemaReady(db);
}

function addMissingToolAttemptColumns(db: DatabaseSync): void {
  const columns = tableColumnNames(db, "tool_attempts");
  if (!columns.has("terminal_cause")) db.exec("alter table tool_attempts add column terminal_cause text");
  if (!columns.has("depends_on_attempt_ids")) db.exec("alter table tool_attempts add column depends_on_attempt_ids text not null default '[]'");
  if (!columns.has("trace_version")) db.exec("alter table tool_attempts add column trace_version integer check(trace_version = 1)");
  if (!columns.has("descriptor_version")) db.exec("alter table tool_attempts add column descriptor_version text");
  if (!columns.has("descriptor_side_effects")) db.exec("alter table tool_attempts add column descriptor_side_effects text");
  if (!columns.has("side_effect_key")) db.exec("alter table tool_attempts add column side_effect_key text");
  if (!columns.has("idempotency_key")) db.exec("alter table tool_attempts add column idempotency_key text");
  if (!columns.has("postcondition_disposition")) {
    db.exec("alter table tool_attempts add column postcondition_disposition text check(postcondition_disposition in ('applied', 'not_applied'))");
  }
  if (!columns.has("postcondition_receipt")) db.exec("alter table tool_attempts add column postcondition_receipt text");
  db.exec("create index if not exists idx_tool_attempts_side_effect_key on tool_attempts(project_id, side_effect_key) where side_effect_key is not null");
}

export function assertStorageTraceSchemaReady(db: DatabaseSync): void {
  assertMigrationIdentity(db, 3, "operational-codex-trace-v3", STORAGE_TRACE_V3_MIGRATION_CHECKSUM);
  assertMigrationIdentity(db, STORAGE_TRACE_SCHEMA_VERSION, STORAGE_TRACE_MIGRATION_NAME, STORAGE_TRACE_MIGRATION_CHECKSUM);
  const columns = tableColumnNames(db, "jobs");
  for (const [name] of JOB_TRACE_COLUMNS) {
    if (!columns.has(name)) throw new Error(`Storage jobs trace column is missing: ${name}`);
  }
  const attemptColumns = tableColumnNames(db, "tool_attempts");
  for (const name of [
    "terminal_cause",
    "depends_on_attempt_ids",
    "trace_version",
    "descriptor_version",
    "descriptor_side_effects",
    "side_effect_key",
    "idempotency_key",
    "postcondition_disposition",
    "postcondition_receipt"
  ]) {
    if (!attemptColumns.has(name)) throw new Error(`Storage tool attempt trace column is missing: ${name}`);
  }
  if (!tableExists(db, "codex_cli_executions")) throw new Error("Storage Codex CLI execution trace table is missing.");
}

function assertMigrationIdentityIfPresent(db: DatabaseSync, version: number, name: string, checksum: string): void {
  if (!tableExists(db, "schema_migrations")) return;
  const migration = db.prepare("select name, checksum_sha256 from schema_migrations where version = ?").get(version) as
    { name?: unknown; checksum_sha256?: unknown } | undefined;
  if (migration && (migration.name !== name || migration.checksum_sha256 !== checksum)) {
    throw new Error(`Storage trace migration ${version} has an unexpected identity or checksum.`);
  }
}

function assertMigrationIdentity(db: DatabaseSync, version: number, name: string, checksum: string): void {
  const migration = db.prepare("select name, checksum_sha256 from schema_migrations where version = ?").get(version) as
    { name?: unknown; checksum_sha256?: unknown } | undefined;
  if (migration?.name !== name || migration.checksum_sha256 !== checksum) {
    throw new Error(`Storage trace migration ${version} is missing or has an unexpected identity or checksum.`);
  }
}

function addMissingJobTraceColumns(db: DatabaseSync): void {
  const columns = tableColumnNames(db, "jobs");
  for (const [name, type] of JOB_TRACE_COLUMNS) {
    if (!columns.has(name)) db.exec(`alter table jobs add column ${name} ${type}`);
  }
}

function tableColumnNames(db: DatabaseSync, table: string): Set<string> {
  const rows = db.prepare(`pragma table_info(${table})`).all() as Array<{ name?: unknown }>;
  return new Set(rows.map((row) => String(row.name)));
}

function tableExists(db: DatabaseSync, table: string): boolean {
  return Boolean(db.prepare("select 1 from sqlite_master where type='table' and name=?").get(table));
}
