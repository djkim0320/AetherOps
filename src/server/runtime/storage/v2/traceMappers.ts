import { optionalString, parseOptionalJson, requiredNumber, requiredString, type Row } from "./repositorySupport.js";
import type {
  StorageCodexCliExecution,
  StorageLlmInvocation,
  StorageNetworkAudit,
  StorageToolAttempt,
  StorageToolDecision,
  StorageToolOutputLink
} from "./traceTypes.js";

export function rowToLlmInvocation(row: Row): StorageLlmInvocation {
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

export function rowToToolDecision(row: Row): StorageToolDecision {
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

export function rowToToolAttempt(row: Row): StorageToolAttempt {
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

export function rowToCodexCliExecution(row: Row): StorageCodexCliExecution {
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

export function rowToOutputLink(row: Row): StorageToolOutputLink {
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

export function rowToNetworkAudit(row: Row): StorageNetworkAudit {
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
