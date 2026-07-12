import type { DatabaseSync } from "node:sqlite";
import { boolInt, json, normalizeLimit, optionalString, parseOptionalJson, requiredNumber, requiredString, type Row } from "./repositorySupport.js";
import type {
  StorageCodexCliExecution,
  StorageLlmInvocation,
  StorageNetworkAudit,
  StorageToolAttempt,
  StorageToolDecision,
  StorageToolOutputLink
} from "./traceTypes.js";

export class TraceRepository {
  constructor(private readonly db: DatabaseSync) {}

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

  saveToolAttempt(value: StorageToolAttempt): StorageToolAttempt {
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

  getToolAttempt(attemptId: string): StorageToolAttempt | undefined {
    const row = this.db.prepare("select * from tool_attempts where id=?").get(attemptId) as Row | undefined;
    return row ? rowToToolAttempt(row) : undefined;
  }

  listToolAttempts(jobId: string, limit = 100): StorageToolAttempt[] {
    return (
      this.db.prepare("select * from tool_attempts where job_id=? order by ordinal, queued_at, id limit ?").all(jobId, normalizeLimit(limit)) as Row[]
    ).map(rowToToolAttempt);
  }

  recordOutputLink(value: StorageToolOutputLink): StorageToolOutputLink {
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
    return rowToOutputLink(row);
  }

  listOutputLinks(attemptId: string, limit = 100): StorageToolOutputLink[] {
    return (
      this.db.prepare("select * from tool_output_links where attempt_id=? order by created_at, id limit ?").all(attemptId, normalizeLimit(limit)) as Row[]
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

function rowToLlmInvocation(row: Row): StorageLlmInvocation {
  return {
    id: requiredString(row.id, "llm_invocation.id"),
    projectId: requiredString(row.project_id, "llm_invocation.project_id"),
    jobId: requiredString(row.job_id, "llm_invocation.job_id"),
    model: requiredString(row.model, "llm_invocation.model"),
    reasoningEffort: requiredString(row.reasoning_effort, "llm_invocation.reasoning_effort"),
    promptVersion: requiredString(row.prompt_version, "llm_invocation.prompt_version"),
    schemaVersion: requiredString(row.schema_version, "llm_invocation.schema_version"),
    promptHash: requiredString(row.prompt_hash, "llm_invocation.prompt_hash"),
    responseHash: optionalString(row.response_hash),
    latencyMs: typeof row.latency_ms === "number" ? row.latency_ms : undefined,
    repairCount: requiredNumber(row.repair_count, "llm_invocation.repair_count"),
    status: requiredString(row.status, "llm_invocation.status") as StorageLlmInvocation["status"],
    error: optionalString(row.error),
    startedAt: requiredString(row.started_at, "llm_invocation.started_at"),
    completedAt: optionalString(row.completed_at),
    data: parseOptionalJson(row.data)
  };
}

function rowToToolDecision(row: Row): StorageToolDecision {
  return {
    id: requiredString(row.id, "tool_decision.id"),
    projectId: requiredString(row.project_id, "tool_decision.project_id"),
    jobId: requiredString(row.job_id, "tool_decision.job_id"),
    invocationId: optionalString(row.invocation_id),
    toolName: requiredString(row.tool_name, "tool_decision.tool_name"),
    purpose: requiredString(row.purpose, "tool_decision.purpose"),
    expectedOutcome: requiredString(row.expected_outcome, "tool_decision.expected_outcome"),
    rawSelection: parseOptionalJson(row.raw_selection),
    userPinned: Boolean(row.user_pinned),
    policyStatus: requiredString(row.policy_status, "tool_decision.policy_status") as StorageToolDecision["policyStatus"],
    policyReason: optionalString(row.policy_reason),
    compiledAction: parseOptionalJson(row.compiled_action),
    createdAt: requiredString(row.created_at, "tool_decision.created_at"),
    data: parseOptionalJson(row.data)
  };
}

function rowToToolAttempt(row: Row): StorageToolAttempt {
  return {
    id: requiredString(row.id, "tool_attempt.id"),
    projectId: requiredString(row.project_id, "tool_attempt.project_id"),
    jobId: requiredString(row.job_id, "tool_attempt.job_id"),
    decisionId: requiredString(row.decision_id, "tool_attempt.decision_id"),
    checkpointId: optionalString(row.checkpoint_id),
    ordinal: requiredNumber(row.ordinal, "tool_attempt.ordinal"),
    status: requiredString(row.status, "tool_attempt.status") as StorageToolAttempt["status"],
    inputHash: requiredString(row.input_hash, "tool_attempt.input_hash"),
    outputHash: optionalString(row.output_hash),
    terminalCause: optionalString(row.terminal_cause),
    dependsOnAttemptIds: parseOptionalJson<string[]>(row.depends_on_attempt_ids) ?? [],
    stagingRef: optionalString(row.staging_ref),
    quarantineRef: optionalString(row.quarantine_ref),
    error: optionalString(row.error),
    queuedAt: requiredString(row.queued_at, "tool_attempt.queued_at"),
    startedAt: optionalString(row.started_at),
    completedAt: optionalString(row.completed_at),
    data: parseOptionalJson(row.data)
  };
}

function rowToCodexCliExecution(row: Row): StorageCodexCliExecution {
  return {
    id: requiredString(row.id, "codex_cli_execution.id"),
    projectId: requiredString(row.project_id, "codex_cli_execution.project_id"),
    jobId: requiredString(row.job_id, "codex_cli_execution.job_id"),
    attemptId: requiredString(row.attempt_id, "codex_cli_execution.attempt_id"),
    model: requiredString(row.model, "codex_cli_execution.model"),
    reasoningEffort: requiredString(row.reasoning_effort, "codex_cli_execution.reasoning_effort"),
    sandboxProfile: requiredString(row.sandbox_profile, "codex_cli_execution.sandbox_profile"),
    networkPolicy: requiredString(row.network_policy, "codex_cli_execution.network_policy") as "disabled",
    durationMs: typeof row.duration_ms === "number" ? row.duration_ms : undefined,
    exitCode: typeof row.exit_code === "number" ? row.exit_code : undefined,
    terminationReason: optionalString(row.termination_reason),
    eventCount: requiredNumber(row.event_count, "codex_cli_execution.event_count"),
    workspaceManifestHash: optionalString(row.workspace_manifest_hash),
    outputManifestHash: optionalString(row.output_manifest_hash),
    createdAt: requiredString(row.created_at, "codex_cli_execution.created_at"),
    completedAt: optionalString(row.completed_at),
    data: parseOptionalJson(row.data)
  };
}

function rowToOutputLink(row: Row): StorageToolOutputLink {
  return {
    id: requiredString(row.id, "tool_output_link.id"),
    projectId: requiredString(row.project_id, "tool_output_link.project_id"),
    jobId: requiredString(row.job_id, "tool_output_link.job_id"),
    attemptId: requiredString(row.attempt_id, "tool_output_link.attempt_id"),
    outputKind: requiredString(row.output_kind, "tool_output_link.output_kind") as StorageToolOutputLink["outputKind"],
    outputId: requiredString(row.output_id, "tool_output_link.output_id"),
    promoted: Boolean(row.promoted),
    createdAt: requiredString(row.created_at, "tool_output_link.created_at"),
    promotedAt: optionalString(row.promoted_at),
    data: parseOptionalJson(row.data)
  };
}

function rowToNetworkAudit(row: Row): StorageNetworkAudit {
  return {
    id: requiredString(row.id, "network_audit.id"),
    projectId: requiredString(row.project_id, "network_audit.project_id"),
    jobId: requiredString(row.job_id, "network_audit.job_id"),
    attemptId: optionalString(row.attempt_id),
    url: requiredString(row.url, "network_audit.url"),
    redirectChain: parseOptionalJson<string[]>(row.redirect_chain) ?? [],
    sourcePolicy: parseOptionalJson(row.source_policy),
    policyDecision: requiredString(row.policy_decision, "network_audit.policy_decision") as StorageNetworkAudit["policyDecision"],
    reason: optionalString(row.reason),
    auditedAt: requiredString(row.audited_at, "network_audit.audited_at"),
    data: parseOptionalJson(row.data)
  };
}
