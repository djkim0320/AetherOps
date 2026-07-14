import type { DatabaseSync } from "node:sqlite";
import type {
  StorageCodexCliExecution,
  StorageLlmInvocation,
  StorageNetworkAudit,
  StorageToolAttempt,
  StorageToolDecision,
  StorageToolOutputLink
} from "./traceTypes.js";

interface OwnerRow {
  project_id?: unknown;
  job_id?: unknown;
}

export function assertLlmInvocationOwnership(db: DatabaseSync, value: StorageLlmInvocation): void {
  assertJobOwner(db, value.jobId, value.projectId, "LLM invocation");
}

export function assertToolDecisionOwnership(db: DatabaseSync, value: StorageToolDecision): void {
  assertJobOwner(db, value.jobId, value.projectId, "Tool decision");
  if (!value.invocationId) return;
  const invocation = db.prepare("select project_id,job_id from llm_invocations where id=?").get(value.invocationId) as OwnerRow | undefined;
  if (invocation?.project_id !== value.projectId || invocation.job_id !== value.jobId) {
    throw new Error("Tool decision LLM invocation ownership is unavailable or inconsistent.");
  }
}

export function assertToolAttemptOwnership(db: DatabaseSync, value: StorageToolAttempt): void {
  assertJobOwner(db, value.jobId, value.projectId, "Tool attempt");
  assertParentOwner(db, "tool_decisions", value.decisionId, value.projectId, value.jobId, "Tool attempt decision");
}

export function assertCodexExecutionOwnership(db: DatabaseSync, value: StorageCodexCliExecution): void {
  assertParentOwner(db, "tool_attempts", value.attemptId, value.projectId, value.jobId, "Codex execution attempt");
}

export function assertOutputLinkOwnership(db: DatabaseSync, value: StorageToolOutputLink): void {
  assertParentOwner(db, "tool_attempts", value.attemptId, value.projectId, value.jobId, "Tool output link");
}

export function assertNetworkAuditOwnership(db: DatabaseSync, value: StorageNetworkAudit): void {
  assertJobOwner(db, value.jobId, value.projectId, "Network audit");
  if (value.attemptId) assertParentOwner(db, "tool_attempts", value.attemptId, value.projectId, value.jobId, "Network audit attempt");
}

function assertJobOwner(db: DatabaseSync, jobId: string, projectId: string, label: string): void {
  const row = db.prepare("select project_id from jobs where id=?").get(jobId) as OwnerRow | undefined;
  if (row?.project_id !== projectId) throw new Error(`${label} job ownership is unavailable or inconsistent.`);
}

function assertParentOwner(db: DatabaseSync, table: "tool_decisions" | "tool_attempts", id: string, projectId: string, jobId: string, label: string): void {
  const row = db.prepare(`select project_id,job_id from ${table} where id=?`).get(id) as OwnerRow | undefined;
  if (row?.project_id !== projectId || row.job_id !== jobId) throw new Error(`${label} ownership is unavailable or inconsistent.`);
}
