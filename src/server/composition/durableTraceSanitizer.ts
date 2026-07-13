import { redactTraceText, safeTraceUrl, sanitizeTraceValue } from "../runtime/security/traceSanitizer.js";
import type {
  StorageCodexCliExecution,
  StorageLlmInvocation,
  StorageNetworkAudit,
  StorageToolAttempt,
  StorageToolDecision,
  StorageToolOutputLink,
  StorageTraceData
} from "../runtime/storage/v2/traceTypes.js";

export function sanitizeLlmInvocation(value: StorageLlmInvocation): StorageLlmInvocation {
  return {
    ...value,
    model: requiredText(value.model, "redacted-model"),
    reasoningEffort: requiredText(value.reasoningEffort, "redacted-effort"),
    promptVersion: requiredText(value.promptVersion, "redacted-prompt-version"),
    schemaVersion: requiredText(value.schemaVersion, "redacted-schema-version"),
    error: optionalText(value.error),
    data: optionalData(value.data)
  };
}

export function sanitizeToolDecision(value: StorageToolDecision): StorageToolDecision {
  return {
    ...value,
    toolName: requiredText(value.toolName, "redacted-tool"),
    purpose: requiredText(value.purpose, "Redacted tool purpose."),
    expectedOutcome: requiredText(value.expectedOutcome, "Redacted expected outcome."),
    rawSelection: sanitizeTraceValue(value.rawSelection),
    policyReason: optionalText(value.policyReason),
    compiledAction: value.compiledAction === undefined ? undefined : sanitizeTraceValue(value.compiledAction),
    data: optionalData(value.data)
  };
}

export function sanitizeToolAttempt(value: StorageToolAttempt): StorageToolAttempt {
  return {
    ...value,
    terminalCause: optionalText(value.terminalCause),
    stagingRef: optionalText(value.stagingRef),
    quarantineRef: optionalText(value.quarantineRef),
    error: optionalText(value.error),
    data: optionalData(value.data)
  };
}

export function sanitizeCodexCliExecution(value: StorageCodexCliExecution): StorageCodexCliExecution {
  return {
    ...value,
    model: requiredText(value.model, "redacted-model"),
    reasoningEffort: requiredText(value.reasoningEffort, "redacted-effort"),
    sandboxProfile: requiredText(value.sandboxProfile, "redacted-sandbox"),
    terminationReason: optionalText(value.terminationReason),
    data: optionalData(value.data)
  };
}

export function sanitizeToolOutput(value: StorageToolOutputLink): StorageToolOutputLink {
  return { ...value, data: optionalData(value.data) };
}

export function sanitizeNetworkAudit(value: StorageNetworkAudit): StorageNetworkAudit {
  return {
    ...value,
    url: safeTraceUrl(value.url),
    redirectChain: value.redirectChain.slice(0, 32).map(safeTraceUrl),
    sourcePolicy: sanitizeTraceValue(value.sourcePolicy),
    reason: optionalText(value.reason),
    data: optionalData(value.data)
  };
}

function requiredText(value: string, fallback: string): string {
  return optionalText(value) ?? fallback;
}

function optionalText(value: string | undefined): string | undefined {
  return (
    redactTraceText(value)
      ?.replace(/[\r\n]+/g, " ")
      .trim() || undefined
  );
}

function optionalData(value: StorageTraceData | undefined): StorageTraceData | undefined {
  if (value === undefined) return undefined;
  const sanitized = sanitizeTraceValue(value);
  return Array.isArray(sanitized) || (sanitized !== null && typeof sanitized === "object") ? (sanitized as StorageTraceData) : undefined;
}
