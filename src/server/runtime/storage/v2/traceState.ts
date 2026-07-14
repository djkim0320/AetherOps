import { isDeepStrictEqual } from "node:util";
import { redactTraceText } from "../../security/traceSanitizer.js";
import { assertIsoTimestamp, assertLowerSha256, assertTimestampOrder, assertTraceIdentifier, assertTraceText } from "./traceFieldValidation.js";
import type { StorageLlmInvocation, StorageToolAttempt, StorageToolOutputLink } from "./traceTypes.js";

const MAX_LLM_ERROR_LENGTH = 1_000;
const MAX_LLM_ERROR_BYTES = 4_000;
const MAX_LLM_DATA_BYTES = 8_192;
const LLM_DATA_KEYS = new Set(["provider", "schemaName", "accounting", "validationErrors", "contextPackId", "canonicalHash", "finalInputHash"]);

export function assertLlmInvocationUpdate(existing: StorageLlmInvocation | undefined, next: StorageLlmInvocation): void {
  if (next.status === "running") assertLlmInvocationShape(next);
  if (!existing) {
    if (next.status !== "running") throw new Error("New LLM invocation must begin with a running receipt.");
    return;
  }
  if (
    existing.id !== next.id ||
    existing.projectId !== next.projectId ||
    existing.jobId !== next.jobId ||
    existing.model !== next.model ||
    existing.reasoningEffort !== next.reasoningEffort ||
    existing.promptVersion !== next.promptVersion ||
    existing.schemaVersion !== next.schemaVersion ||
    existing.promptHash !== next.promptHash ||
    existing.startedAt !== next.startedAt ||
    !isDeepStrictEqual(llmIdentityData(existing.data), llmIdentityData(next.data))
  ) {
    throw new Error("LLM invocation identity conflict.");
  }
  if (existing.status !== "running") {
    if (!isDeepStrictEqual(comparableLlmInvocation(existing), comparableLlmInvocation(next))) {
      throw new Error("Terminal LLM invocation receipt is immutable.");
    }
    return;
  }
  if (next.status === "running" && !isDeepStrictEqual(comparableLlmInvocation(existing), comparableLlmInvocation(next))) {
    throw new Error("Running LLM invocation retry must be identical.");
  }
  if (next.status !== "running") assertLlmInvocationShape(next);
}

function assertLlmInvocationShape(value: StorageLlmInvocation): void {
  assertTraceIdentifier(value.id, "LLM invocation id");
  assertTraceIdentifier(value.projectId, "LLM invocation project id");
  assertTraceIdentifier(value.jobId, "LLM invocation job id");
  assertTraceText(value.model, "LLM invocation model", 128);
  assertTraceText(value.reasoningEffort, "LLM invocation reasoning effort", 32);
  assertTraceText(value.promptVersion, "LLM invocation prompt version", 128);
  assertTraceText(value.schemaVersion, "LLM invocation schema version", 128);
  assertLowerSha256(value.promptHash, "LLM invocation prompt hash");
  if (value.responseHash !== undefined) assertLowerSha256(value.responseHash, "LLM invocation response hash");
  if (!Number.isSafeInteger(value.repairCount) || value.repairCount < 0 || value.repairCount > 1) {
    throw new Error("LLM invocation repair count is invalid.");
  }
  if (!["running", "completed", "failed"].includes(value.status)) throw new Error("LLM invocation status is invalid.");
  assertIsoTimestamp(value.startedAt, "LLM invocation start timestamp");
  assertLlmInvocationData(value);
  if (value.status === "running") {
    if (value.completedAt || value.responseHash || value.latencyMs !== undefined || value.error || value.repairCount !== 0) {
      throw new Error("Running LLM invocation contains terminal fields.");
    }
    return;
  }
  if (!value.completedAt || value.latencyMs === undefined || !Number.isSafeInteger(value.latencyMs) || value.latencyMs < 0) {
    throw new Error("Terminal LLM invocation lacks a valid completion receipt.");
  }
  assertTimestampOrder(value.startedAt, value.completedAt, "LLM invocation");
  if (value.status === "completed") {
    if (value.responseHash === undefined) throw new Error("Completed LLM invocation requires a lowercase SHA-256 response hash.");
    if (value.error !== undefined) throw new Error("Completed LLM invocation cannot contain an error reason.");
  }
  if (value.status === "failed") {
    const error = value.error?.trim();
    const sanitized = redactTraceText(error)
      ?.replace(/[\r\n]+/g, " ")
      .trim();
    if (!error) throw new Error("Failed LLM invocation requires a bounded sanitized error reason.");
    if (error.length > MAX_LLM_ERROR_LENGTH || new TextEncoder().encode(error).byteLength > MAX_LLM_ERROR_BYTES || sanitized !== error) {
      throw new Error("Failed LLM invocation error reason is not bounded and sanitized.");
    }
  }
}

function assertLlmInvocationData(value: StorageLlmInvocation): void {
  const data = value.data;
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("LLM invocation metadata is missing or invalid.");
  if (Object.keys(data).some((key) => !LLM_DATA_KEYS.has(key))) throw new Error("LLM invocation metadata contains an unsupported field.");
  assertTraceText(data.provider, "LLM invocation provider", 128);
  assertTraceText(data.schemaName, "LLM invocation schema name", 256);
  if (value.status === "running") {
    if (Object.keys(data).some((key) => key !== "provider" && key !== "schemaName")) {
      throw new Error("Running LLM invocation metadata contains terminal fields.");
    }
  } else {
    assertLlmAccounting(data.accounting);
  }
  if (data.validationErrors) {
    if (data.validationErrors.length > 8) throw new Error("LLM invocation validation metadata exceeds its bound.");
    for (const item of data.validationErrors) assertTraceText(item, "LLM invocation validation error", 512);
  }
  if (data.contextPackId !== undefined) assertTraceIdentifier(data.contextPackId, "LLM invocation context pack id");
  for (const hash of [data.canonicalHash, data.finalInputHash]) {
    if (hash !== undefined) assertLowerSha256(hash, "LLM invocation metadata hash");
  }
  if (new TextEncoder().encode(JSON.stringify(data)).byteLength > MAX_LLM_DATA_BYTES) {
    throw new Error("LLM invocation metadata exceeds its byte bound.");
  }
}

function assertLlmAccounting(value: unknown): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Terminal LLM invocation lacks accounting metadata.");
  const accounting = value as Record<string, unknown>;
  if (
    Object.keys(accounting).some((key) => !["version", "inputUnits", "outputUnits", "unit", "estimator", "monetaryCost"].includes(key)) ||
    accounting.version !== 1 ||
    accounting.unit !== "estimated_token" ||
    accounting.estimator !== "utf8_bytes_div_4_ceil_v1" ||
    !nonnegativeSafeInteger(accounting.inputUnits) ||
    !nonnegativeSafeInteger(accounting.outputUnits)
  ) {
    throw new Error("Terminal LLM invocation accounting metadata is invalid.");
  }
  const monetary = accounting.monetaryCost;
  if (
    !monetary ||
    typeof monetary !== "object" ||
    Array.isArray(monetary) ||
    Object.keys(monetary).some((key) => !["availability", "policy"].includes(key)) ||
    (monetary as Record<string, unknown>).availability !== "unavailable" ||
    (monetary as Record<string, unknown>).policy !== "unmetered_codex_oauth_v1"
  ) {
    throw new Error("Terminal LLM invocation monetary metadata is invalid.");
  }
}

function nonnegativeSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function llmIdentityData(value: StorageLlmInvocation["data"]): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const data = value as Record<string, unknown>;
  return { provider: data.provider, schemaName: data.schemaName };
}

function comparableLlmInvocation(value: StorageLlmInvocation): Record<string, unknown> {
  return {
    ...value,
    responseHash: value.responseHash ?? null,
    latencyMs: value.latencyMs ?? null,
    error: value.error ?? null,
    completedAt: value.completedAt ?? null,
    data: value.data ?? null
  };
}

const terminalToolAttemptStatuses = new Set<StorageToolAttempt["status"]>(["completed", "blocked", "failed", "interrupted", "quarantined"]);

export function assertToolAttemptCreate(value: StorageToolAttempt): void {
  assertToolAttemptLifecycleShape(value);
  if (value.traceVersion === 1 && value.status !== "queued") throw new Error("A new vnext tool attempt must begin queued.");
}

export function assertToolAttemptUpdate(existing: StorageToolAttempt, next: StorageToolAttempt): void {
  assertToolAttemptLifecycleShape(next);
  if (
    existing.projectId !== next.projectId ||
    existing.jobId !== next.jobId ||
    existing.decisionId !== next.decisionId ||
    existing.ordinal !== next.ordinal ||
    existing.inputHash !== next.inputHash ||
    existing.queuedAt !== next.queuedAt ||
    existing.traceVersion !== next.traceVersion ||
    existing.descriptorVersion !== next.descriptorVersion ||
    !isDeepStrictEqual(existing.descriptorSideEffects, next.descriptorSideEffects) ||
    existing.sideEffectKey !== next.sideEffectKey ||
    existing.idempotencyKey !== next.idempotencyKey
  ) {
    throw new Error(`Tool attempt identity conflict: ${existing.id}.`);
  }
  if (terminalToolAttemptStatuses.has(existing.status) && !isDeepStrictEqual(comparableAttempt(existing), comparableAttempt(next))) {
    if (isProvisionalCompletionQuarantine(existing, next)) return;
    if (!isVerifiedPostconditionAttachment(existing, next)) {
      throw new Error(`Invalid terminal tool attempt transition; retry must be identical except for one verified postcondition attachment: ${existing.id}.`);
    }
    return;
  }
  if (terminalToolAttemptStatuses.has(existing.status)) return;
  if (existing.traceVersion !== 1) {
    if (existing.status === "running" && next.status === "queued") throw new Error(`Invalid tool attempt transition for ${existing.id}: running -> queued.`);
    return;
  }
  if (existing.status === "queued") {
    if (!["queued", "running", "blocked", "interrupted"].includes(next.status)) throw new Error("Invalid vnext queued tool attempt transition.");
    if (next.status === "queued" && !isDeepStrictEqual(comparableAttempt(existing), comparableAttempt(next))) {
      throw new Error("Queued tool attempt retry must be identical.");
    }
    return;
  }
  if (existing.status === "running") {
    if (next.status === "running" && !isDeepStrictEqual(comparableAttempt(existing), comparableAttempt(next))) {
      throw new Error("Running tool attempt retry must be identical.");
    }
    if (next.status === "queued" || (!terminalToolAttemptStatuses.has(next.status) && next.status !== "running")) {
      throw new Error("Invalid vnext running tool attempt transition.");
    }
  }
}

function isProvisionalCompletionQuarantine(existing: StorageToolAttempt, next: StorageToolAttempt): boolean {
  if (
    existing.status !== "completed" ||
    next.status !== "quarantined" ||
    !existing.completedAt ||
    !next.completedAt ||
    Date.parse(next.completedAt) < Date.parse(existing.completedAt) ||
    !next.terminalCause ||
    !next.error
  ) {
    return false;
  }
  return isDeepStrictEqual(comparableAttempt(existing), {
    ...comparableAttempt(next),
    status: "completed",
    terminalCause: existing.terminalCause ?? null,
    quarantineRef: existing.quarantineRef ?? null,
    error: existing.error ?? null,
    completedAt: existing.completedAt
  });
}

function assertToolAttemptLifecycleShape(value: StorageToolAttempt): void {
  if (value.traceVersion !== 1) return;
  const hasTerminalFields =
    value.outputHash !== undefined ||
    value.terminalCause !== undefined ||
    value.error !== undefined ||
    value.completedAt !== undefined ||
    value.postconditionDisposition !== undefined ||
    value.postconditionReceipt !== undefined;
  if (value.status === "queued") {
    if (value.startedAt !== undefined || hasTerminalFields) throw new Error("Queued tool attempt contains execution or terminal fields.");
    return;
  }
  if (value.status === "running") {
    if (!value.startedAt || hasTerminalFields) throw new Error("Running tool attempt lacks a clean start receipt.");
    return;
  }
  if (!value.completedAt) throw new Error("Terminal tool attempt requires a completion timestamp.");
  if (value.status === "completed" && (!value.startedAt || !value.outputHash || value.error !== undefined)) {
    throw new Error("Completed tool attempt requires start and output receipts without an error.");
  }
}

function isVerifiedPostconditionAttachment(existing: StorageToolAttempt, next: StorageToolAttempt): boolean {
  if (existing.postconditionDisposition || existing.postconditionReceipt || !next.postconditionDisposition || !next.postconditionReceipt) return false;
  const existingComparable: Record<string, unknown> = {
    ...comparableAttempt(existing),
    postconditionDisposition: null,
    postconditionReceipt: null
  };
  const nextComparable: Record<string, unknown> = {
    ...comparableAttempt(next),
    postconditionDisposition: null,
    postconditionReceipt: null
  };
  const { data: existingData, ...existingWithoutReceipt } = existingComparable;
  const { data: nextData, ...nextWithoutReceipt } = nextComparable;
  return isDeepStrictEqual(existingWithoutReceipt, nextWithoutReceipt) && isVerifiedAccountingAttachment(existingData, nextData, next);
}

function isVerifiedAccountingAttachment(existing: unknown, next: unknown, attempt: StorageToolAttempt): boolean {
  if (isDeepStrictEqual(existing, next)) return true;
  if (attempt.postconditionReceipt?.verifier !== "storage-worker-codex-workspace-v1") return false;
  const existingData = object(existing);
  const nextData = object(next);
  const existingAccounting = object(existingData?.accounting);
  const nextAccounting = object(nextData?.accounting);
  if (!existingData || !nextData || !existingAccounting || !nextAccounting) return false;
  const existingRest = { ...existingData };
  const nextRest = { ...nextData };
  delete existingRest.accounting;
  delete nextRest.accounting;
  const { workspaceOutputBytes, workspaceSource, ...nextBase } = nextAccounting;
  return (
    isDeepStrictEqual(existingRest, nextRest) &&
    isDeepStrictEqual(existingAccounting, nextBase) &&
    typeof workspaceOutputBytes === "number" &&
    Number.isSafeInteger(workspaceOutputBytes) &&
    workspaceOutputBytes >= 0 &&
    workspaceSource === "verified_codex_output_manifest_v1"
  );
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function comparableAttempt(value: StorageToolAttempt): Record<string, unknown> {
  return {
    id: value.id,
    projectId: value.projectId,
    jobId: value.jobId,
    decisionId: value.decisionId,
    checkpointId: value.checkpointId ?? null,
    ordinal: value.ordinal,
    status: value.status,
    inputHash: value.inputHash,
    outputHash: value.outputHash ?? null,
    traceVersion: value.traceVersion ?? null,
    descriptorVersion: value.descriptorVersion ?? null,
    descriptorSideEffects: value.descriptorSideEffects ?? null,
    sideEffectKey: value.sideEffectKey ?? null,
    idempotencyKey: value.idempotencyKey ?? null,
    postconditionDisposition: value.postconditionDisposition ?? null,
    postconditionReceipt: value.postconditionReceipt ?? null,
    terminalCause: value.terminalCause ?? null,
    dependsOnAttemptIds: value.dependsOnAttemptIds,
    stagingRef: value.stagingRef ?? null,
    quarantineRef: value.quarantineRef ?? null,
    error: value.error ?? null,
    queuedAt: value.queuedAt,
    startedAt: value.startedAt ?? null,
    completedAt: value.completedAt ?? null,
    data: value.data ?? null
  };
}

export function assertOutputLinkUpdate(existing: StorageToolOutputLink, next: StorageToolOutputLink): void {
  if (
    existing.id !== next.id ||
    existing.projectId !== next.projectId ||
    existing.jobId !== next.jobId ||
    existing.attemptId !== next.attemptId ||
    existing.outputKind !== next.outputKind ||
    existing.outputId !== next.outputId ||
    existing.createdAt !== next.createdAt
  ) {
    throw new Error(`Tool output link identity conflict: ${next.id}.`);
  }
  if (existing.promoted && !next.promoted) {
    throw new Error(`Promoted tool output cannot be downgraded: ${existing.id}.`);
  }
}
