import type { DatabaseSync } from "node:sqlite";
import { boolInt, json, normalizeLimit, type Row } from "./repositorySupport.js";
import { rowToCodexCliExecution, rowToLlmInvocation, rowToNetworkAudit, rowToOutputLink, rowToToolAttempt, rowToToolDecision } from "./traceMappers.js";
import { TracePaginationRepository } from "./tracePagination.js";
import type {
  StorageCodexCliExecution,
  StorageLlmInvocation,
  StorageNetworkAudit,
  StorageTraceCategory,
  StorageTracePage,
  StorageTraceSummary,
  StorageToolAttempt,
  StorageToolDecision,
  StorageToolOutputLink
} from "./traceTypes.js";
import { assertOutputLinkUpdate, assertToolAttemptUpdate } from "./traceState.js";

export class TraceRepository {
  private readonly pagination: TracePaginationRepository;

  constructor(private readonly db: DatabaseSync) {
    this.pagination = new TracePaginationRepository(db);
  }

  summaryJob(jobId: string): StorageTraceSummary {
    return this.pagination.summaryJob(jobId);
  }

  pageJob<C extends StorageTraceCategory>(jobId: string, category: C, cursor?: string, limit?: number): StorageTracePage<C> {
    return this.pagination.pageJob(jobId, category, cursor, limit);
  }

  saveLlmInvocation(value: StorageLlmInvocation): StorageLlmInvocation {
    this.db
      .prepare(
        `insert into llm_invocations (id, project_id, job_id, model, reasoning_effort, prompt_version, schema_version,
        prompt_hash, response_hash, latency_ms, repair_count, status, error, started_at, completed_at, data)
        values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        on conflict(id) do update set response_hash=excluded.response_hash, latency_ms=excluded.latency_ms,
        repair_count=excluded.repair_count, status=excluded.status, error=excluded.error,
        completed_at=excluded.completed_at, data=excluded.data`
      )
      .run(
        value.id,
        value.projectId,
        value.jobId,
        value.model,
        value.reasoningEffort,
        value.promptVersion,
        value.schemaVersion,
        value.promptHash,
        value.responseHash ?? null,
        value.latencyMs ?? null,
        value.repairCount,
        value.status,
        value.error ?? null,
        value.startedAt,
        value.completedAt ?? null,
        value.data === undefined ? null : json(value.data)
      );
    return this.requiredLlmInvocation(value.id);
  }

  listLlmInvocations(jobId: string, limit = 100): StorageLlmInvocation[] {
    return (this.db.prepare("select * from llm_invocations where job_id=? order by started_at, id limit ?").all(jobId, normalizeLimit(limit)) as Row[]).map(
      rowToLlmInvocation
    );
  }

  getLlmInvocation(invocationId: string): StorageLlmInvocation | undefined {
    const row = this.db.prepare("select * from llm_invocations where id=?").get(invocationId) as Row | undefined;
    return row ? rowToLlmInvocation(row) : undefined;
  }

  recordToolDecision(value: StorageToolDecision): StorageToolDecision {
    this.db
      .prepare(
        `insert into tool_decisions (id, project_id, job_id, invocation_id, tool_name, purpose, expected_outcome,
        raw_selection, user_pinned, policy_status, policy_reason, compiled_action, created_at, data)
        values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        on conflict(id) do update set policy_status=excluded.policy_status, policy_reason=excluded.policy_reason,
        compiled_action=excluded.compiled_action, data=excluded.data`
      )
      .run(
        value.id,
        value.projectId,
        value.jobId,
        value.invocationId ?? null,
        value.toolName,
        value.purpose,
        value.expectedOutcome,
        json(value.rawSelection),
        boolInt(value.userPinned),
        value.policyStatus,
        value.policyReason ?? null,
        value.compiledAction === undefined ? null : json(value.compiledAction),
        value.createdAt,
        value.data === undefined ? null : json(value.data)
      );
    return this.requiredToolDecision(value.id);
  }

  listToolDecisions(jobId: string, limit = 100): StorageToolDecision[] {
    return (this.db.prepare("select * from tool_decisions where job_id=? order by created_at, id limit ?").all(jobId, normalizeLimit(limit)) as Row[]).map(
      rowToToolDecision
    );
  }

  getToolDecision(decisionId: string): StorageToolDecision | undefined {
    const row = this.db.prepare("select * from tool_decisions where id=?").get(decisionId) as Row | undefined;
    return row ? rowToToolDecision(row) : undefined;
  }

  saveToolAttempt(value: StorageToolAttempt): StorageToolAttempt {
    const existing = this.getToolAttempt(value.id);
    if (existing) assertToolAttemptUpdate(existing, value);
    this.db
      .prepare(
        `insert into tool_attempts (id, project_id, job_id, decision_id, checkpoint_id, ordinal, status, input_hash,
        output_hash, terminal_cause, depends_on_attempt_ids, staging_ref, quarantine_ref, error, queued_at, started_at, completed_at, data)
        values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        on conflict(id) do update set checkpoint_id=excluded.checkpoint_id, status=excluded.status,
        output_hash=excluded.output_hash, terminal_cause=excluded.terminal_cause,
        depends_on_attempt_ids=excluded.depends_on_attempt_ids, staging_ref=excluded.staging_ref, quarantine_ref=excluded.quarantine_ref,
        error=excluded.error, started_at=excluded.started_at, completed_at=excluded.completed_at, data=excluded.data`
      )
      .run(
        value.id,
        value.projectId,
        value.jobId,
        value.decisionId,
        value.checkpointId ?? null,
        value.ordinal,
        value.status,
        value.inputHash,
        value.outputHash ?? null,
        value.terminalCause ?? null,
        json(value.dependsOnAttemptIds ?? []),
        value.stagingRef ?? null,
        value.quarantineRef ?? null,
        value.error ?? null,
        value.queuedAt,
        value.startedAt ?? null,
        value.completedAt ?? null,
        value.data === undefined ? null : json(value.data)
      );
    return this.requiredToolAttempt(value.id);
  }

  saveCodexCliExecution(value: StorageCodexCliExecution): StorageCodexCliExecution {
    this.db
      .prepare(
        `insert into codex_cli_executions (id, project_id, job_id, attempt_id, model, reasoning_effort,
        sandbox_profile, network_policy, duration_ms, exit_code, termination_reason, event_count,
        workspace_manifest_hash, output_manifest_hash, created_at, completed_at, data)
        values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        on conflict(id) do update set duration_ms=excluded.duration_ms, exit_code=excluded.exit_code,
        termination_reason=excluded.termination_reason, event_count=excluded.event_count,
        workspace_manifest_hash=excluded.workspace_manifest_hash, output_manifest_hash=excluded.output_manifest_hash,
        completed_at=excluded.completed_at, data=excluded.data`
      )
      .run(
        value.id,
        value.projectId,
        value.jobId,
        value.attemptId,
        value.model,
        value.reasoningEffort,
        value.sandboxProfile,
        value.networkPolicy,
        value.durationMs ?? null,
        value.exitCode ?? null,
        value.terminationReason ?? null,
        value.eventCount,
        value.workspaceManifestHash ?? null,
        value.outputManifestHash ?? null,
        value.createdAt,
        value.completedAt ?? null,
        value.data === undefined ? null : json(value.data)
      );
    const row = this.db.prepare("select * from codex_cli_executions where id=?").get(value.id) as Row;
    return rowToCodexCliExecution(row);
  }

  listCodexCliExecutions(jobId: string, limit = 100): StorageCodexCliExecution[] {
    return (
      this.db.prepare("select * from codex_cli_executions where job_id=? order by created_at, id limit ?").all(jobId, normalizeLimit(limit)) as Row[]
    ).map(rowToCodexCliExecution);
  }

  getCodexCliExecution(executionId: string): StorageCodexCliExecution | undefined {
    const row = this.db.prepare("select * from codex_cli_executions where id=?").get(executionId) as Row | undefined;
    return row ? rowToCodexCliExecution(row) : undefined;
  }

  getToolAttempt(attemptId: string): StorageToolAttempt | undefined {
    const row = this.db.prepare("select * from tool_attempts where id=?").get(attemptId) as Row | undefined;
    return row ? rowToToolAttempt(row) : undefined;
  }

  listToolAttempts(jobId: string, limit = 100): StorageToolAttempt[] {
    return (
      this.db.prepare("select * from tool_attempts where job_id=? order by ordinal, queued_at, id limit ?").all(jobId, normalizeLimit(limit)) as Row[]
    ).map(rowToToolAttempt);
  }

  interruptActiveToolAttempts(jobId: string, completedAt: string, error: string): StorageToolAttempt[] {
    this.db
      .prepare(
        `update tool_attempts set status='interrupted',terminal_cause='lease_expired',error=?,completed_at=?
         where job_id=? and status in ('queued','running')`
      )
      .run(error, completedAt, jobId);
    return this.listToolAttempts(jobId, 1_000).filter((attempt) => attempt.status === "interrupted" && attempt.completedAt === completedAt);
  }

  recordOutputLink(value: StorageToolOutputLink): StorageToolOutputLink {
    const existingRow = this.db
      .prepare("select * from tool_output_links where attempt_id=? and output_kind=? and output_id=?")
      .get(value.attemptId, value.outputKind, value.outputId) as Row | undefined;
    const existing = existingRow ? rowToOutputLink(existingRow) : undefined;
    if (existing) assertOutputLinkUpdate(existing, value);
    this.db
      .prepare(
        `insert into tool_output_links (id, project_id, job_id, attempt_id, output_kind, output_id, promoted, created_at, promoted_at, data)
        values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        on conflict(attempt_id, output_kind, output_id) do update set promoted=excluded.promoted,
        promoted_at=excluded.promoted_at, data=excluded.data`
      )
      .run(
        value.id,
        value.projectId,
        value.jobId,
        value.attemptId,
        value.outputKind,
        value.outputId,
        boolInt(value.promoted),
        value.createdAt,
        value.promotedAt ?? null,
        value.data === undefined ? null : json(value.data)
      );
    const row = this.db
      .prepare("select * from tool_output_links where attempt_id=? and output_kind=? and output_id=?")
      .get(value.attemptId, value.outputKind, value.outputId) as Row;
    const stored = rowToOutputLink(row);
    if (stored.id !== value.id || stored.projectId !== value.projectId || stored.jobId !== value.jobId) {
      throw new Error(`Tool output link identity conflict: ${value.id}.`);
    }
    return stored;
  }

  listOutputLinks(attemptId: string, limit = 100): StorageToolOutputLink[] {
    return (
      this.db.prepare("select * from tool_output_links where attempt_id=? order by created_at, id limit ?").all(attemptId, normalizeLimit(limit)) as Row[]
    ).map(rowToOutputLink);
  }

  listOutputLinksForAttempts(attemptIds: string[], limit = 100): StorageToolOutputLink[] {
    const ids = [...new Set(attemptIds)].slice(0, 1_000);
    if (!ids.length) return [];
    const placeholders = ids.map(() => "?").join(",");
    return (
      this.db
        .prepare(`select * from tool_output_links where attempt_id in (${placeholders}) order by attempt_id,created_at,id limit ?`)
        .all(...ids, normalizeLimit(limit)) as Row[]
    ).map(rowToOutputLink);
  }

  recordNetworkAudit(value: StorageNetworkAudit): StorageNetworkAudit {
    this.db
      .prepare(
        `insert into network_audits (id, project_id, job_id, attempt_id, url, redirect_chain, source_policy,
        policy_decision, reason, audited_at, data) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        value.id,
        value.projectId,
        value.jobId,
        value.attemptId ?? null,
        value.url,
        json(value.redirectChain),
        json(value.sourcePolicy),
        value.policyDecision,
        value.reason ?? null,
        value.auditedAt,
        value.data === undefined ? null : json(value.data)
      );
    const row = this.db.prepare("select * from network_audits where id=?").get(value.id) as Row;
    return rowToNetworkAudit(row);
  }

  listNetworkAudits(jobId: string, limit = 100): StorageNetworkAudit[] {
    return (this.db.prepare("select * from network_audits where job_id=? order by audited_at, id limit ?").all(jobId, normalizeLimit(limit)) as Row[]).map(
      rowToNetworkAudit
    );
  }

  private requiredLlmInvocation(id: string): StorageLlmInvocation {
    const row = this.db.prepare("select * from llm_invocations where id=?").get(id) as Row | undefined;
    if (!row) throw new Error(`Storage LLM invocation not found: ${id}`);
    return rowToLlmInvocation(row);
  }

  private requiredToolDecision(id: string): StorageToolDecision {
    const row = this.db.prepare("select * from tool_decisions where id=?").get(id) as Row | undefined;
    if (!row) throw new Error(`Storage tool decision not found: ${id}`);
    return rowToToolDecision(row);
  }

  private requiredToolAttempt(id: string): StorageToolAttempt {
    const attempt = this.getToolAttempt(id);
    if (!attempt) throw new Error(`Storage tool attempt not found: ${id}`);
    return attempt;
  }
}
