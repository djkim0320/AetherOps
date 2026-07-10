import { randomUUID } from "node:crypto";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { blobToFloat32Embedding } from "./embeddings.js";
import type {
  StorageCapabilityAudit,
  StorageCheckpoint,
  StorageEmbedding,
  StorageJob,
  StorageJobEvent,
  StorageOntologyRun,
  StorageSearchOptions,
  StorageStepAttempt
} from "./types.js";

export type Row = Record<string, unknown>;

export const activeLaneStatuses = "'running', 'pause_requested', 'cancel_requested'";

export function runAtomically<T>(db: DatabaseSync, work: () => T): T {
  if (db.isTransaction) return work();
  db.exec("begin immediate");
  try {
    const result = work();
    db.exec("commit");
    return result;
  } catch (error) {
    db.exec("rollback");
    throw error;
  }
}

export function replaceFts(
  db: DatabaseSync,
  table: "records_v2_fts" | "memory_items_v2_fts",
  id: string,
  projectId: string,
  title: string,
  content: string
): void {
  db.prepare(`delete from ${table} where id = ?`).run(id);
  db.prepare(`insert into ${table} (id, project_id, title, content) values (?, ?, ?, ?)`).run(id, projectId, title, content);
}

export function replaceOntologyFts(db: DatabaseSync, id: string, projectId: string, kind: string, title: string, content: string): void {
  db.prepare("delete from ontology_v2_fts where id = ?").run(id);
  db.prepare("insert into ontology_v2_fts (id, project_id, kind, title, content) values (?, ?, ?, ?, ?)").run(id, projectId, kind, title, content);
}

export function projectVisibilityWhere(alias: string, options: StorageSearchOptions, includeGlobalDefault = true): { where: string; params: SQLInputValue[] } {
  if (!options.projectId) return { where: "", params: [] };
  const includeGlobal = options.includeGlobal ?? includeGlobalDefault;
  if (!includeGlobal) {
    return { where: `and ${alias}.project_id = ?`, params: [options.projectId] };
  }
  return {
    where: `and (${alias}.project_id = ? or ${alias}.workspace_project_id = ? or ${alias}.memory_scope = 'global')`,
    params: [options.projectId, options.projectId]
  };
}

export function ontologyProjectWhere(alias: string, options: StorageSearchOptions): { where: string; params: SQLInputValue[] } {
  if (!options.projectId) return { where: "", params: [] };
  return { where: `and ${alias}.project_id = ?`, params: [options.projectId] };
}

export function toFtsQuery(query: string): string {
  const terms =
    query
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s-]/gu, " ")
      .match(/\S+/g) ?? [];
  return terms
    .slice(0, 32)
    .map((term) => `"${term.replace(/"/g, '""')}"`)
    .join(" ");
}

export function normalizeLimit(limit: number | undefined): number {
  if (!Number.isFinite(limit ?? 0) || !limit || limit < 1) return 100;
  return Math.min(Math.floor(limit), 1000);
}

export function rowToJob(row: Row): StorageJob {
  return {
    id: requiredString(row.id, "job.id"),
    projectId: requiredString(row.project_id, "job.project_id"),
    operation: requiredString(row.operation, "job.operation"),
    status: requiredString(row.status, "job.status") as StorageJob["status"],
    priority: requiredNumber(row.priority, "job.priority"),
    attempt: requiredNumber(row.attempt, "job.attempt"),
    payload: parseJson(row.payload),
    result: parseOptionalJson(row.result),
    error: optionalString(row.error),
    idempotencyKey: optionalString(row.idempotency_key),
    requestedBy: optionalString(row.requested_by),
    leaseOwner: optionalString(row.lease_owner),
    leaseExpiresAt: optionalString(row.lease_expires_at),
    queuedAt: requiredString(row.queued_at, "job.queued_at"),
    startedAt: optionalString(row.started_at),
    completedAt: optionalString(row.completed_at),
    createdAt: requiredString(row.created_at, "job.created_at"),
    updatedAt: requiredString(row.updated_at, "job.updated_at")
  };
}

export function rowToEvent(row: Row): StorageJobEvent {
  return {
    sequence: requiredNumber(row.sequence, "event.sequence"),
    eventId: requiredString(row.event_id, "event.event_id"),
    projectId: requiredString(row.project_id, "event.project_id"),
    jobId: optionalString(row.job_id),
    type: requiredString(row.type, "event.type"),
    payload: parseJson(row.payload),
    createdAt: requiredString(row.created_at, "event.created_at")
  };
}

export function rowToCheckpoint(row: Row): StorageCheckpoint {
  return {
    id: requiredString(row.id, "checkpoint.id"),
    projectId: requiredString(row.project_id, "checkpoint.project_id"),
    jobId: requiredString(row.job_id, "checkpoint.job_id"),
    attemptId: optionalString(row.attempt_id),
    step: requiredString(row.step, "checkpoint.step"),
    checkpointKey: requiredString(row.checkpoint_key, "checkpoint.checkpoint_key"),
    status: requiredString(row.status, "checkpoint.status") as StorageCheckpoint["status"],
    outputRef: optionalString(row.output_ref),
    error: optionalString(row.error),
    createdAt: requiredString(row.created_at, "checkpoint.created_at"),
    committedAt: optionalString(row.committed_at),
    data: parseOptionalJson(row.data)
  };
}

export function rowToStepAttempt(row: Row): StorageStepAttempt {
  return {
    id: requiredString(row.id, "attempt.id"),
    projectId: requiredString(row.project_id, "attempt.project_id"),
    jobId: requiredString(row.job_id, "attempt.job_id"),
    step: requiredString(row.step, "attempt.step"),
    attemptIndex: requiredNumber(row.attempt_index, "attempt.attempt_index"),
    status: requiredString(row.status, "attempt.status") as StorageStepAttempt["status"],
    workerId: optionalString(row.worker_id),
    checkpointId: optionalString(row.checkpoint_id),
    quarantineRef: optionalString(row.quarantine_ref),
    inputHash: optionalString(row.input_hash),
    outputHash: optionalString(row.output_hash),
    data: parseOptionalJson(row.data),
    error: optionalString(row.error),
    startedAt: requiredString(row.started_at, "attempt.started_at"),
    completedAt: optionalString(row.completed_at)
  };
}

export function rowToCapabilityAudit(row: Row): StorageCapabilityAudit {
  return {
    id: requiredString(row.id, "capability.id"),
    projectId: requiredString(row.project_id, "capability.project_id"),
    jobId: optionalString(row.job_id),
    operation: requiredString(row.operation, "capability.operation") as StorageCapabilityAudit["operation"],
    capability: requiredString(row.capability, "capability.capability"),
    appAllowed: Boolean(row.app_allowed),
    projectAllowed: Boolean(row.project_allowed),
    operationAllowed: Boolean(row.operation_allowed),
    allowed: Boolean(row.allowed),
    reason: optionalString(row.reason),
    data: parseOptionalJson(row.data),
    auditedAt: requiredString(row.audited_at, "capability.audited_at")
  };
}

export function rowToOntologyRun(row: Row): StorageOntologyRun {
  return {
    id: requiredString(row.id, "ontology_run.id"),
    projectId: requiredString(row.project_id, "ontology_run.project_id"),
    jobId: optionalString(row.job_id),
    mode: requiredString(row.mode, "ontology_run.mode") as StorageOntologyRun["mode"],
    status: requiredString(row.status, "ontology_run.status") as StorageOntologyRun["status"],
    entityCount: requiredNumber(row.entity_count, "ontology_run.entity_count"),
    relationCount: requiredNumber(row.relation_count, "ontology_run.relation_count"),
    constraintCount: requiredNumber(row.constraint_count, "ontology_run.constraint_count"),
    error: optionalString(row.error),
    startedAt: requiredString(row.started_at, "ontology_run.started_at"),
    completedAt: optionalString(row.completed_at),
    data: parseOptionalJson(row.data)
  };
}

export function rowToEmbedding(row: Row): StorageEmbedding {
  const blob = row.embedding;
  if (!(blob instanceof Uint8Array)) {
    throw new Error("Stored embedding is not a BLOB.");
  }
  return {
    id: requiredString(row.id, "embedding.id"),
    projectId: requiredString(row.project_id, "embedding.project_id"),
    ownerTable: requiredString(row.owner_table, "embedding.owner_table"),
    ownerId: requiredString(row.owner_id, "embedding.owner_id"),
    vector: blobToFloat32Embedding(blob),
    dimensions: requiredNumber(row.dimensions, "embedding.dimensions"),
    provider: optionalString(row.provider),
    model: optionalString(row.model),
    scope: optionalString(row.scope),
    createdAt: requiredString(row.created_at, "embedding.created_at"),
    updatedAt: requiredString(row.updated_at, "embedding.updated_at"),
    data: parseOptionalJson(row.data)
  };
}

export function requiredJob(job: StorageJob | undefined, id: string): StorageJob {
  if (!job) throw new Error(`Storage job not found: ${id}`);
  return job;
}

export function requiredEvent(event: StorageJobEvent | undefined, id: string): StorageJobEvent {
  if (!event) throw new Error(`Storage event not found: ${id}`);
  return event;
}

export function requiredCheckpoint(checkpoint: StorageCheckpoint | undefined, id: string): StorageCheckpoint {
  if (!checkpoint) throw new Error(`Storage checkpoint not found: ${id}`);
  return checkpoint;
}

export function requiredStepAttempt(attempt: StorageStepAttempt | undefined, id: string): StorageStepAttempt {
  if (!attempt) throw new Error(`Storage step attempt not found: ${id}`);
  return attempt;
}

export function requiredCapabilityAudit(audit: StorageCapabilityAudit | undefined, id: string): StorageCapabilityAudit {
  if (!audit) throw new Error(`Storage capability audit not found: ${id}`);
  return audit;
}

export function requiredOntologyRun(run: StorageOntologyRun | undefined, id: string): StorageOntologyRun {
  if (!run) throw new Error(`Storage ontology run not found: ${id}`);
  return run;
}

export function parseJson<T = unknown>(value: unknown): T {
  if (typeof value !== "string") {
    throw new Error("Expected JSON text from SQLite row.");
  }
  return JSON.parse(value) as T;
}

export function parseOptionalJson<T = unknown>(value: unknown): T | undefined {
  if (value === null || value === undefined) return undefined;
  return parseJson<T>(value);
}

export function json(value: unknown): string {
  return JSON.stringify(value);
}

export function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length ? value : undefined;
}

export function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.length) throw new Error(`Expected ${label} to be a non-empty string.`);
  return value;
}

export function requiredNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`Expected ${label} to be a finite number.`);
  return value;
}

export function boolInt(value: boolean): 0 | 1 {
  return value ? 1 : 0;
}

export function recordOf(value: unknown): Row {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected a JSON object.");
  return value as Row;
}

export function rankScore(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? -value : 0;
}

export function terminalJobStatus(status: StorageJob["status"]): boolean {
  return status === "aborted" || status === "interrupted" || status === "failed" || status === "completed";
}

export function parseLastEventId(value: string | number | undefined): number {
  if (typeof value === "number" && Number.isFinite(value)) return Math.max(0, Math.floor(value));
  if (typeof value !== "string" || !value.length) return 0;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? Math.max(0, parsed) : 0;
}

export function createStorageId(prefix: string): string {
  return `${prefix}_${randomUUID()}`;
}

export function shortProjectId(id: string): string {
  const compact = id.replace(/^project[_-]/, "").replace(/[^a-zA-Z0-9]/g, "");
  return (compact || id.replace(/[^a-zA-Z0-9]/g, "")).slice(0, 12);
}

export function nowIso(): string {
  return new Date().toISOString();
}
