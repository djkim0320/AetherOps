import { DatabaseSync } from "node:sqlite";
import { STORAGE_JOB_STATUSES } from "./types.js";
import { assertStorageTraceSchemaReady, migrateStorageTraceV3Schema } from "./traceSchema.js";
import { assertStorageJobV4SchemaReady, migrateStorageJobV4Schema } from "./jobSchema.js";
import { assertStorageRunStateV5SchemaReady, migrateStorageRunStateV5Schema } from "./runStateSchema.js";
import { assertStorageRunStateBootstrapV7SchemaReady, migrateStorageRunStateBootstrapV7Schema } from "./runStateBootstrapSchema.js";
import { assertStorageTerminalReceiptV8SchemaReady, migrateStorageTerminalReceiptV8Schema } from "./terminalReceiptSchema.js";
import { assertStorageTerminalAttestationV9SchemaReady, migrateStorageTerminalAttestationV9Schema } from "./terminalAttestationSchema.js";
import { assertStorageOwnershipV10SchemaReady, migrateStorageOwnershipV10Schema } from "./ownershipSchema.js";
import { assertStorageToolSideEffectV11SchemaReady, migrateStorageToolSideEffectV11Schema } from "./toolSideEffectReservationSchema.js";
import { assertStorageEngineeringBaselineV12SchemaReady, migrateStorageEngineeringBaselineV12Schema } from "./engineeringBaselineSchema.js";
import { assertStorageProjectRevisionV13SchemaReady, migrateStorageProjectRevisionV13Schema } from "./projectRevisionSchema.js";
import { assertStorageProjectMutationV14SchemaReady, migrateStorageProjectMutationV14Schema } from "./projectMutationSchema.js";

export const STORAGE_V2_SCHEMA_VERSION = 2;

const jobStatusCheck = STORAGE_JOB_STATUSES.map((status) => `'${status}'`).join(", ");

export interface StorageV2MigrationOptions {
  requireFts5?: boolean;
}

export function migrateStorageV2Schema(db: DatabaseSync, options: StorageV2MigrationOptions = {}): void {
  const requireFts5 = options.requireFts5 ?? true;
  if (requireFts5) {
    preflightFts5(db);
  }

  db.exec("pragma foreign_keys = on");
  db.exec("pragma journal_mode = WAL");
  db.exec(`
    create table if not exists storage_v2_meta (
      key text primary key,
      value text not null,
      updated_at text not null
    );

    create table if not exists projects_v2 (
      id text primary key,
      short_id text not null,
      project_root text not null,
      topic text not null,
      status text not null,
      current_step text,
      created_at text not null,
      updated_at text not null,
      data text not null
    );
    create unique index if not exists idx_projects_v2_short_id on projects_v2(short_id);
    create index if not exists idx_projects_v2_root on projects_v2(project_root);
    create index if not exists idx_projects_v2_status_updated on projects_v2(status, updated_at desc);

    create table if not exists records_v2 (
      id text primary key,
      project_id text not null,
      workspace_project_id text,
      source_project_id text,
      kind text not null,
      memory_scope text not null,
      validation_status text not null,
      title text not null,
      content text not null,
      source_id text,
      artifact_id text,
      evidence_id text,
      citation text,
      created_at text not null,
      data text not null
    );
    create index if not exists idx_records_v2_project_kind on records_v2(project_id, kind, created_at);
    create index if not exists idx_records_v2_workspace on records_v2(workspace_project_id, created_at);
    create index if not exists idx_records_v2_scope_status on records_v2(memory_scope, validation_status, created_at);
    create index if not exists idx_records_v2_source on records_v2(source_id);
    create index if not exists idx_records_v2_evidence on records_v2(evidence_id);

    create table if not exists memory_items_v2 (
      id text primary key,
      project_id text not null,
      workspace_project_id text,
      source_project_id text,
      kind text not null,
      memory_scope text not null,
      validation_status text not null,
      title text not null,
      content text not null,
      source_id text,
      record_id text,
      evidence_id text,
      created_at text not null,
      data text not null
    );
    create index if not exists idx_memory_items_v2_project_kind on memory_items_v2(project_id, kind, created_at);
    create index if not exists idx_memory_items_v2_workspace on memory_items_v2(workspace_project_id, created_at);
    create index if not exists idx_memory_items_v2_scope_status on memory_items_v2(memory_scope, validation_status, created_at);
    create index if not exists idx_memory_items_v2_record on memory_items_v2(record_id);

    create table if not exists embeddings_v2 (
      id text primary key,
      project_id text not null,
      owner_table text not null,
      owner_id text not null,
      scope text,
      dimensions integer not null check(dimensions > 0),
      provider text,
      model text,
      embedding blob not null,
      created_at text not null,
      updated_at text not null,
      data text
    );
    create unique index if not exists idx_embeddings_v2_owner on embeddings_v2(owner_table, owner_id);
    create index if not exists idx_embeddings_v2_project on embeddings_v2(project_id, owner_table);

    create table if not exists jobs (
      id text primary key,
      project_id text not null,
      operation text not null,
      status text not null check(status in (${jobStatusCheck})),
      priority integer not null default 0,
      attempt integer not null default 0,
      lease_generation integer not null default 0,
      idempotency_key text,
      request_hash text,
      requested_capabilities text,
      effective_capabilities text,
      tool_policy text,
      blocked_reason text,
      failure_reason text,
      requested_by text,
      lease_owner text,
      lease_expires_at text,
      queued_at text not null,
      started_at text,
      completed_at text,
      created_at text not null,
      updated_at text not null,
      payload text not null,
      result text,
      error text
    );
    create unique index if not exists idx_jobs_project_idempotency on jobs(project_id, idempotency_key) where idempotency_key is not null;
    create index if not exists idx_jobs_project_lane on jobs(project_id, status, queued_at, id);
    create index if not exists idx_jobs_ready on jobs(status, queued_at, id);
    create index if not exists idx_jobs_lease on jobs(status, lease_expires_at);

    create table if not exists job_events (
      sequence integer primary key autoincrement,
      event_id text not null unique,
      project_id text not null,
      job_id text,
      type text not null,
      created_at text not null,
      payload text not null
    );
    create index if not exists idx_job_events_project_sequence on job_events(project_id, sequence);
    create index if not exists idx_job_events_job_sequence on job_events(job_id, sequence);

    create table if not exists checkpoints (
      id text primary key,
      project_id text not null,
      job_id text not null,
      attempt_id text,
      step text not null,
      checkpoint_key text not null,
      status text not null check(status in ('pending', 'committed', 'quarantined', 'failed')),
      output_ref text,
      error text,
      created_at text not null,
      committed_at text,
      data text
    );
    create unique index if not exists idx_checkpoints_job_key on checkpoints(job_id, checkpoint_key);
    create index if not exists idx_checkpoints_project_job on checkpoints(project_id, job_id, committed_at);
    create index if not exists idx_checkpoints_step_status on checkpoints(project_id, step, status);

    create table if not exists step_attempts (
      id text primary key,
      project_id text not null,
      job_id text not null,
      step text not null,
      attempt_index integer not null,
      status text not null check(status in ('running', 'completed', 'failed', 'interrupted', 'quarantined')),
      worker_id text,
      checkpoint_id text,
      quarantine_ref text,
      input_hash text,
      output_hash text,
      error text,
      started_at text not null,
      completed_at text,
      data text
    );
    create unique index if not exists idx_step_attempts_job_step_attempt on step_attempts(job_id, step, attempt_index);
    create index if not exists idx_step_attempts_project_status on step_attempts(project_id, status, started_at);
    create index if not exists idx_step_attempts_checkpoint on step_attempts(checkpoint_id);

    create table if not exists capability_audits (
      id text primary key,
      project_id text not null,
      job_id text,
      operation text not null check(operation in ('agent', 'engineering', 'search')),
      capability text not null,
      app_allowed integer not null check(app_allowed in (0, 1)),
      project_allowed integer not null check(project_allowed in (0, 1)),
      operation_allowed integer not null check(operation_allowed in (0, 1)),
      allowed integer not null check(allowed in (0, 1)),
      reason text,
      audited_at text not null,
      data text
    );
    create index if not exists idx_capability_audits_project on capability_audits(project_id, audited_at);
    create index if not exists idx_capability_audits_job on capability_audits(job_id, audited_at);
    create index if not exists idx_capability_audits_capability on capability_audits(operation, capability, allowed);

    create table if not exists ontology_runs (
      id text primary key,
      project_id text not null,
      job_id text,
      mode text not null check(mode in ('rule_based', 'llm', 'hybrid')),
      status text not null check(status in ('running', 'completed', 'failed')),
      entity_count integer not null default 0,
      relation_count integer not null default 0,
      constraint_count integer not null default 0,
      error text,
      started_at text not null,
      completed_at text,
      data text
    );
    create index if not exists idx_ontology_runs_project on ontology_runs(project_id, started_at);
    create index if not exists idx_ontology_runs_job on ontology_runs(job_id);
    create index if not exists idx_ontology_runs_mode_status on ontology_runs(mode, status);

    create table if not exists ontology_entities_v2 (
      id text primary key,
      project_id text not null,
      workspace_project_id text,
      source_project_id text,
      memory_scope text,
      validation_status text,
      label text not null,
      type text not null,
      confidence real not null,
      source_record_id text,
      source_evidence_id text,
      created_at text not null,
      data text not null
    );
    create index if not exists idx_ontology_entities_v2_project_type on ontology_entities_v2(project_id, type, created_at);
    create index if not exists idx_ontology_entities_v2_label on ontology_entities_v2(label);
    create index if not exists idx_ontology_entities_v2_record on ontology_entities_v2(source_record_id);

    create table if not exists ontology_relations_v2 (
      id text primary key,
      project_id text not null,
      workspace_project_id text,
      source_project_id text,
      memory_scope text,
      validation_status text,
      subject_id text not null,
      predicate text not null,
      object_id text not null,
      confidence real not null,
      source_record_id text,
      source_evidence_id text,
      created_at text not null,
      data text not null
    );
    create index if not exists idx_ontology_relations_v2_project_predicate on ontology_relations_v2(project_id, predicate, created_at);
    create index if not exists idx_ontology_relations_v2_subject on ontology_relations_v2(subject_id);
    create index if not exists idx_ontology_relations_v2_object on ontology_relations_v2(object_id);
    create index if not exists idx_ontology_relations_v2_record on ontology_relations_v2(source_record_id);

    create table if not exists ontology_constraints_v2 (
      id text primary key,
      project_id text not null,
      workspace_project_id text,
      source_project_id text,
      memory_scope text,
      validation_status text,
      label text not null,
      rule_type text not null,
      applies_to_entity_type text,
      confidence real not null,
      source_record_id text,
      created_at text not null,
      data text not null
    );
    create index if not exists idx_ontology_constraints_v2_project_rule on ontology_constraints_v2(project_id, rule_type, created_at);
    create index if not exists idx_ontology_constraints_v2_record on ontology_constraints_v2(source_record_id);
  `);

  migrateStorageTraceV3Schema(db);
  migrateStorageJobV4Schema(db);
  migrateStorageRunStateV5Schema(db);
  migrateStorageRunStateBootstrapV7Schema(db);
  migrateStorageTerminalReceiptV8Schema(db);
  migrateStorageTerminalAttestationV9Schema(db);
  migrateStorageOwnershipV10Schema(db);
  migrateStorageToolSideEffectV11Schema(db);
  migrateStorageEngineeringBaselineV12Schema(db);
  migrateStorageProjectRevisionV13Schema(db);
  migrateStorageProjectMutationV14Schema(db);
  blockLegacyResearchJobsRequiringReplan(db);
  createFtsTables(db);
  db.prepare(
    "insert into storage_v2_meta (key, value, updated_at) values ('schema_version', ?, datetime('now')) on conflict(key) do update set value = excluded.value, updated_at = excluded.updated_at"
  ).run(String(STORAGE_V2_SCHEMA_VERSION));
}

function blockLegacyResearchJobsRequiringReplan(db: DatabaseSync): void {
  db.prepare(
    `update jobs set status='blocked',
     error=case when payload like '%OpenCodeTool%' or payload like '%"target":"opencode"%'
       then 'replan_required_executor_removed' else 'replan_required' end,
     blocked_reason=case when payload like '%OpenCodeTool%' or payload like '%"target":"opencode"%'
       then 'replan_required_executor_removed' else 'replan_required' end,
     lease_owner=null, lease_expires_at=null,
     completed_at=coalesce(completed_at, datetime('now')), updated_at=datetime('now')
     where operation='research_loop' and status in ('queued', 'running', 'paused', 'interrupted')
     and (payload like '%OpenCodeTool%' or payload like '%"target":"opencode"%' or
       (payload like '%"requiredTools"%' and payload not like '%"toolRequests"%'))`
  ).run();
}

export function preflightFts5(db: DatabaseSync): void {
  db.exec("create virtual table temp.aetherops_fts5_preflight using fts5(content)");
  db.exec("drop table temp.aetherops_fts5_preflight");
}

export function assertStorageV2SchemaReady(db: DatabaseSync): void {
  const row = db.prepare("select value from storage_v2_meta where key = 'schema_version'").get() as { value?: unknown } | undefined;
  if (String(row?.value ?? "") !== String(STORAGE_V2_SCHEMA_VERSION)) {
    throw new Error("Storage v2 schema is not ready. Run migrate:apply and migrate:verify before starting the storage worker.");
  }
  assertStorageTraceSchemaReady(db);
  assertStorageJobV4SchemaReady(db);
  assertStorageRunStateV5SchemaReady(db);
  assertStorageRunStateBootstrapV7SchemaReady(db);
  assertStorageTerminalReceiptV8SchemaReady(db);
  assertStorageTerminalAttestationV9SchemaReady(db);
  assertStorageOwnershipV10SchemaReady(db);
  assertStorageToolSideEffectV11SchemaReady(db);
  assertStorageEngineeringBaselineV12SchemaReady(db);
  assertStorageProjectRevisionV13SchemaReady(db);
  assertStorageProjectMutationV14SchemaReady(db);
}

function createFtsTables(db: DatabaseSync): void {
  db.exec(`
    create virtual table if not exists records_v2_fts using fts5(
      id unindexed,
      project_id unindexed,
      title,
      content,
      tokenize = 'unicode61'
    );

    create virtual table if not exists memory_items_v2_fts using fts5(
      id unindexed,
      project_id unindexed,
      title,
      content,
      tokenize = 'unicode61'
    );

    create virtual table if not exists ontology_v2_fts using fts5(
      id unindexed,
      project_id unindexed,
      kind unindexed,
      title,
      content,
      tokenize = 'unicode61'
    );
  `);
}
