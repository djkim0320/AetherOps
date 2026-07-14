import { isDeepStrictEqual } from "node:util";
import { isValidPublicSourceDomain, normalizePublicSourceDomain } from "../../../../shared/kernel/sourceAccessPolicy.js";
import { safeTraceUrl, sanitizeTraceValue } from "../../security/traceSanitizer.js";
import {
  assertCanonicalRelativePath,
  assertIsoTimestamp,
  assertLowerSha256,
  assertTimestampOrder,
  assertTraceIdentifier,
  assertTraceIdentifierList,
  assertTraceText,
  assertWorkspaceReference
} from "./traceFieldValidation.js";
import type { StorageCodexCliExecution, StorageNetworkAudit, StorageToolAttempt, StorageToolDecision, StorageToolOutputLink } from "./traceTypes.js";

const MAX_DECISION_BYTES = 2_048;
const MAX_ATTEMPT_DATA_BYTES = 1_024;
const MAX_NETWORK_BYTES = 16_384;

export function assertToolDecisionStorageBoundary(value: StorageToolDecision): void {
  assertTraceIdentifier(value.id, "Tool decision id");
  assertTraceIdentifier(value.projectId, "Tool decision project id");
  assertTraceIdentifier(value.jobId, "Tool decision job id");
  if (value.invocationId !== undefined) assertTraceIdentifier(value.invocationId, "Tool decision invocation id");
  assertTraceText(value.toolName, "Tool decision name", 128);
  assertTraceText(value.purpose, "Tool decision purpose", 1_000);
  assertTraceText(value.expectedOutcome, "Tool decision expected outcome", 1_000);
  if (value.policyReason !== undefined) assertTraceText(value.policyReason, "Tool decision policy reason", 1_000);
  if (typeof value.userPinned !== "boolean" || !["accepted", "rejected"].includes(value.policyStatus))
    throw new Error("Tool decision policy state is invalid.");
  assertIsoTimestamp(value.createdAt, "Tool decision timestamp");
  if (value.data !== undefined) throw new Error("Tool decision data is not part of the durable trace schema.");

  const raw = strictRecord(value.rawSelection, ["inputHash"], "Tool decision raw selection");
  const inputHash = raw.inputHash;
  if (inputHash !== undefined) assertLowerSha256(inputHash, "Tool decision input hash");

  if (value.compiledAction !== undefined) {
    const action = strictRecord(value.compiledAction, ["toolName", "ordinal", "phase", "inputHash", "outputDeclarations"], "Tool decision compiled action");
    assertTraceText(action.toolName, "Compiled tool name", 128);
    assertTraceText(action.phase, "Compiled tool phase", 128);
    if (!Number.isSafeInteger(action.ordinal) || Number(action.ordinal) < 0 || Number(action.ordinal) > 1_000) {
      throw new Error("Compiled tool ordinal is invalid.");
    }
    assertLowerSha256(action.inputHash, "Compiled tool input hash");
    if (action.inputHash !== inputHash) throw new Error("Compiled tool input hash does not match the raw selection.");
    if (action.toolName !== value.toolName) throw new Error("Compiled tool name does not match the decision.");
    assertOutputDeclarations(action.outputDeclarations, action.toolName === "CodexCliTool");
  }
  assertCanonicalSanitizedValue(value.rawSelection, MAX_DECISION_BYTES, "Tool decision raw selection");
  if (value.compiledAction !== undefined) assertCanonicalSanitizedValue(value.compiledAction, MAX_DECISION_BYTES, "Tool decision compiled action");
}

function assertOutputDeclarations(value: unknown, required: boolean): void {
  if (value === undefined) {
    if (required) throw new Error("Compiled Codex output declarations are required.");
    return;
  }
  if (!required) throw new Error("Only Codex decisions may declare workspace outputs.");
  if (!Array.isArray(value) || value.length < 1 || value.length > 8) throw new Error("Compiled Codex output declarations are invalid.");
  const paths = new Set<string>();
  for (const candidate of value) {
    const declaration = strictRecord(candidate, ["relativePath", "kind"], "Compiled Codex output declaration");
    assertCanonicalRelativePath(declaration.relativePath, "Compiled Codex output path");
    if (!["code", "report", "data"].includes(String(declaration.kind))) throw new Error("Compiled Codex output kind is invalid.");
    const identity = declaration.relativePath.toLowerCase();
    if (paths.has(identity)) throw new Error("Compiled Codex output paths are not unique.");
    paths.add(identity);
  }
}

export function assertToolAttemptStorageBoundary(value: StorageToolAttempt): void {
  assertTraceIdentifier(value.id, "Tool attempt id");
  assertTraceIdentifier(value.projectId, "Tool attempt project id");
  assertTraceIdentifier(value.jobId, "Tool attempt job id");
  assertTraceIdentifier(value.decisionId, "Tool attempt decision id");
  if (value.checkpointId !== undefined) assertTraceIdentifier(value.checkpointId, "Tool attempt checkpoint id");
  if (!Number.isSafeInteger(value.ordinal) || value.ordinal < 0 || value.ordinal > 1_000) throw new Error("Tool attempt ordinal is invalid.");
  if (!["queued", "running", "completed", "blocked", "failed", "interrupted", "quarantined"].includes(value.status)) {
    throw new Error("Tool attempt status is invalid.");
  }
  assertLowerSha256(value.inputHash, "Tool attempt input hash");
  if (value.outputHash !== undefined) assertLowerSha256(value.outputHash, "Tool attempt output hash");
  if (value.descriptorVersion !== undefined) assertTraceText(value.descriptorVersion, "Tool descriptor version", 128);
  if (value.sideEffectKey !== undefined) assertTraceIdentifier(value.sideEffectKey, "Tool attempt side-effect key");
  if (value.idempotencyKey !== undefined) assertTraceIdentifier(value.idempotencyKey, "Tool attempt idempotency key");
  assertTraceIdentifierList(value.dependsOnAttemptIds, "Tool attempt dependencies", 200);
  if (value.stagingRef !== undefined) assertWorkspaceReference(value.stagingRef, "Tool attempt staging reference");
  if (value.quarantineRef !== undefined) assertWorkspaceReference(value.quarantineRef, "Tool attempt quarantine reference");
  if (value.terminalCause !== undefined) assertTraceText(value.terminalCause, "Tool attempt terminal cause", 256);
  if (value.error !== undefined) assertTraceText(value.error, "Tool attempt error", 1_000);
  assertIsoTimestamp(value.queuedAt, "Tool attempt queued timestamp");
  if (value.startedAt !== undefined) assertTimestampOrder(value.queuedAt, value.startedAt, "Tool attempt queue");
  assertTimestampOrder(value.startedAt ?? value.queuedAt, value.completedAt, "Tool attempt");
  if (value.data === undefined) return;
  const data = strictRecord(value.data, ["phase", "accounting"], "Tool attempt data");
  if (data.phase !== undefined) assertTraceText(data.phase, "Tool attempt phase", 128);
  if (data.accounting !== undefined) assertToolAccounting(data.accounting);
  assertCanonicalSanitizedValue(value.data, MAX_ATTEMPT_DATA_BYTES, "Tool attempt data");
}

export function assertCodexCliExecutionStorageBoundary(value: StorageCodexCliExecution): void {
  assertTraceIdentifier(value.id, "Codex execution id");
  assertTraceIdentifier(value.projectId, "Codex execution project id");
  assertTraceIdentifier(value.jobId, "Codex execution job id");
  assertTraceIdentifier(value.attemptId, "Codex execution attempt id");
  assertTraceText(value.model, "Codex model", 128);
  assertTraceText(value.reasoningEffort, "Codex reasoning effort", 32);
  assertTraceText(value.sandboxProfile, "Codex sandbox profile", 128);
  if (value.networkPolicy !== "disabled") throw new Error("Codex execution network policy must be disabled.");
  if (value.terminationReason !== undefined) assertTraceText(value.terminationReason, "Codex termination reason", 1_000);
  if (value.data !== undefined) throw new Error("Codex execution data is not part of the durable trace schema.");
  if (!Number.isSafeInteger(value.eventCount) || value.eventCount < 0 || value.eventCount > 100_000) throw new Error("Codex event count is invalid.");
  if (value.durationMs !== undefined && (!Number.isSafeInteger(value.durationMs) || value.durationMs < 0)) {
    throw new Error("Codex duration is invalid.");
  }
  if (value.exitCode !== undefined && !Number.isSafeInteger(value.exitCode)) throw new Error("Codex exit code is invalid.");
  for (const hash of [value.workspaceManifestHash, value.outputManifestHash]) {
    if (hash !== undefined) assertLowerSha256(hash, "Codex manifest hash");
  }
  assertIsoTimestamp(value.createdAt, "Codex execution timestamp");
  assertTimestampOrder(value.createdAt, value.completedAt, "Codex execution");
}

export function assertOutputLinkStorageBoundary(value: StorageToolOutputLink): void {
  assertTraceIdentifier(value.id, "Tool output link id");
  assertTraceIdentifier(value.projectId, "Tool output project id");
  assertTraceIdentifier(value.jobId, "Tool output job id");
  assertTraceIdentifier(value.attemptId, "Tool output attempt id");
  assertTraceIdentifier(value.outputId, "Tool output id");
  if (!["source", "evidence", "artifact"].includes(value.outputKind)) throw new Error("Tool output kind is invalid.");
  if (typeof value.promoted !== "boolean") throw new Error("Tool output promotion state is invalid.");
  assertIsoTimestamp(value.createdAt, "Tool output timestamp");
  assertTimestampOrder(value.createdAt, value.promotedAt, "Tool output promotion");
  if (value.data !== undefined) throw new Error("Tool output links persist stable handles only.");
  if (value.promoted && !value.promotedAt) throw new Error("Promoted tool output requires a promotion timestamp.");
  if (!value.promoted && value.promotedAt) throw new Error("Unpromoted tool output cannot carry a promotion timestamp.");
}

export function assertNetworkAuditStorageBoundary(value: StorageNetworkAudit): void {
  assertTraceIdentifier(value.id, "Network audit id");
  assertTraceIdentifier(value.projectId, "Network audit project id");
  assertTraceIdentifier(value.jobId, "Network audit job id");
  if (value.attemptId !== undefined) assertTraceIdentifier(value.attemptId, "Network audit attempt id");
  if (value.data !== undefined) throw new Error("Network audits do not persist arbitrary data.");
  assertSafeHttpUrl(value.url, "Network audit URL");
  if (!Array.isArray(value.redirectChain) || value.redirectChain.length > 32) throw new Error("Network redirect chain exceeds its hop bound.");
  value.redirectChain.forEach((url) => assertSafeHttpUrl(url, "Network redirect URL"));
  assertSourcePolicy(value.sourcePolicy);
  if (!["allowed", "denied"].includes(value.policyDecision)) throw new Error("Network audit policy decision is invalid.");
  if (value.reason !== undefined) assertTraceText(value.reason, "Network audit reason", 1_000);
  assertIsoTimestamp(value.auditedAt, "Network audit timestamp");
  assertCanonicalSanitizedValue({ url: value.url, redirectChain: value.redirectChain, sourcePolicy: value.sourcePolicy }, MAX_NETWORK_BYTES, "Network audit");
}

function assertToolAccounting(value: unknown): void {
  const accounting = strictRecord(value, ["version", "canonicalResultBytes", "source", "workspaceOutputBytes", "workspaceSource"], "Tool attempt accounting");
  if (accounting.version !== 1 || accounting.source !== "canonical_result_utf8_v1" || !nonnegativeSafeInteger(accounting.canonicalResultBytes)) {
    throw new Error("Tool attempt accounting is invalid.");
  }
  const hasWorkspaceBytes = accounting.workspaceOutputBytes !== undefined;
  const hasWorkspaceSource = accounting.workspaceSource !== undefined;
  if (hasWorkspaceBytes !== hasWorkspaceSource) throw new Error("Tool workspace accounting is incomplete.");
  if (hasWorkspaceBytes && (!nonnegativeSafeInteger(accounting.workspaceOutputBytes) || accounting.workspaceSource !== "verified_codex_output_manifest_v1")) {
    throw new Error("Tool workspace accounting is invalid.");
  }
}

function assertSourcePolicy(value: unknown): void {
  const policy = plainRecord(value, "Network source policy");
  if (policy.mode === "offline") {
    assertExactKeys(policy, ["mode"], "Offline source policy");
    return;
  }
  if (policy.mode === "allowlist") {
    assertExactKeys(policy, ["mode", "urls"], "Allowlist source policy");
    if (!Array.isArray(policy.urls) || policy.urls.length > 32) throw new Error("Source allowlist exceeds its URL bound.");
    policy.urls.forEach((url) => assertSafeHttpUrl(url, "Source allowlist URL"));
    return;
  }
  if (policy.mode === "discovery") {
    assertExactKeys(policy, ["mode", "allowedDomains"], "Discovery source policy");
    if (!Array.isArray(policy.allowedDomains) || policy.allowedDomains.length > 32) throw new Error("Discovery policy exceeds its domain bound.");
    for (const domain of policy.allowedDomains) {
      if (typeof domain !== "string" || !isValidPublicSourceDomain(domain) || normalizePublicSourceDomain(domain) !== domain) {
        throw new Error("Discovery policy contains a non-canonical public domain.");
      }
    }
    return;
  }
  throw new Error("Network source policy mode is invalid.");
}

function assertSafeHttpUrl(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || value.length > 1_024) throw new Error(`${label} is invalid.`);
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${label} is invalid.`);
  }
  if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password || parsed.hash || safeTraceUrl(value) !== value) {
    throw new Error(`${label} is not canonical and credential-free.`);
  }
}

function strictRecord(value: unknown, keys: string[], label: string): Record<string, unknown> {
  const record = plainRecord(value, label);
  assertExactKeys(record, keys, label);
  return record;
}

function plainRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new Error(`${label} must be a plain object.`);
  }
  return value as Record<string, unknown>;
}

function assertExactKeys(value: Record<string, unknown>, allowed: string[], label: string): void {
  if (Object.keys(value).some((key) => !allowed.includes(key))) throw new Error(`${label} contains an unsupported field.`);
}

function assertCanonicalSanitizedValue(value: unknown, maxBytes: number, label: string): void {
  if (!isDeepStrictEqual(sanitizeTraceValue(value), value)) throw new Error(`${label} is not sanitized.`);
  assertByteBound(value, maxBytes, label);
}

function assertByteBound(value: unknown, maxBytes: number, label: string): void {
  if (new TextEncoder().encode(JSON.stringify(value)).byteLength > maxBytes) throw new Error(`${label} exceeds its byte bound.`);
}

function nonnegativeSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
