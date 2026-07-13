import { Buffer } from "node:buffer";
import { TRACE_MAX_RECORDS, TRACE_MAX_SERIALIZED_BYTES, type JobDetail } from "../../../contracts/api-v2/jobs.js";
import { CodexModelIdSchema, CodexReasoningEffortSchema } from "../../../contracts/api-v2/settings.js";
import type { DurableJobDetail } from "../../composition/durableJobTypes.js";
import { boundedTraceText, safeTraceUrl, sanitizeTraceRecord } from "../../runtime/security/traceSanitizer.js";

const MAX_REDIRECT_HOPS = 8;
const MAX_HASH_LENGTH = 256;
const MAX_VALIDATED_INPUT_BYTES = 8_192;

export function toPublicJobTrace(job: DurableJobDetail): JobDetail["trace"] {
  const returned = Object.values(job.trace).reduce((total, items) => total + items.length, 0);
  const truncated = returned < job.traceSummary.total || Object.values(job.tracePages).some((page) => page.truncated);
  if (
    returned > TRACE_MAX_RECORDS ||
    returned !== job.traceBudget.returned ||
    job.traceBudget.total !== job.traceSummary.total ||
    job.traceBudget.truncated !== truncated
  ) {
    throw new Error("Durable trace record budget metadata is inconsistent.");
  }
  return {
    llmInvocations: job.trace.llmInvocations.map((item) => ({
      id: item.id,
      model: boundedTraceText(item.model, 200) ?? "unknown",
      reasoningEffort: boundedTraceText(item.reasoningEffort, 100) ?? "unknown",
      promptVersion: boundedTraceText(item.promptVersion, 200) ?? "unknown",
      schemaVersion: boundedTraceText(item.schemaVersion, 200) ?? "unknown",
      promptHash: boundedTraceText(item.promptHash, MAX_HASH_LENGTH) ?? "unavailable",
      responseHash: boundedTraceText(item.responseHash, MAX_HASH_LENGTH),
      latencyMs: item.latencyMs,
      repairCount: item.repairCount,
      status: item.status,
      startedAt: item.startedAt,
      completedAt: item.completedAt
    })),
    toolDecisions: job.trace.toolDecisions.map((item) => ({
      id: item.id,
      invocationId: item.invocationId,
      toolName: boundedTraceText(item.toolName, 200) ?? "unknown",
      purpose: boundedTraceText(item.purpose, 1_000) ?? "",
      expectedOutcome: boundedTraceText(item.expectedOutcome, 1_000) ?? "",
      userPinned: item.userPinned,
      policyStatus: item.policyStatus,
      policyReason: boundedTraceText(item.policyReason, 1_000),
      actionHash: decisionInputHash(item.rawSelection),
      validatedInputs: decisionInputs(item.rawSelection),
      actionSummary: actionSummary(item.compiledAction),
      createdAt: item.createdAt
    })),
    toolAttempts: job.trace.toolAttempts.map((item) => ({
      id: item.id,
      decisionId: item.decisionId,
      checkpointId: item.checkpointId,
      ordinal: item.ordinal,
      status: item.status,
      inputHash: boundedTraceText(item.inputHash, MAX_HASH_LENGTH) ?? "unavailable",
      outputHash: boundedTraceText(item.outputHash, MAX_HASH_LENGTH),
      terminalCause: boundedTraceText(item.terminalCause, 500),
      dependsOnAttemptIds: boundedDependencies(item.dependsOnAttemptIds),
      error: boundedTraceText(item.error, 1_000),
      queuedAt: item.queuedAt,
      startedAt: item.startedAt,
      completedAt: item.completedAt
    })),
    codexCliExecutions: job.trace.codexCliExecutions.map((item) => ({
      id: item.id,
      attemptId: item.attemptId,
      model: CodexModelIdSchema.parse(item.model),
      reasoningEffort: CodexReasoningEffortSchema.parse(item.reasoningEffort),
      sandboxProfile: boundedTraceText(item.sandboxProfile, 256) ?? "unknown",
      networkPolicy: item.networkPolicy,
      durationMs: item.durationMs,
      exitCode: item.exitCode,
      terminationReason: boundedTraceText(item.terminationReason, 1_000),
      eventCount: item.eventCount,
      workspaceManifestHash: boundedTraceText(item.workspaceManifestHash, MAX_HASH_LENGTH),
      outputManifestHash: boundedTraceText(item.outputManifestHash, MAX_HASH_LENGTH),
      createdAt: item.createdAt,
      completedAt: item.completedAt
    })),
    outputs: job.trace.outputs.map((item) => ({
      id: item.id,
      attemptId: item.attemptId,
      outputKind: item.outputKind,
      outputId: item.outputId,
      promoted: item.promoted,
      createdAt: item.createdAt,
      promotedAt: item.promotedAt
    })),
    networkAudits: job.trace.networkAudits.map((item) => ({
      id: item.id,
      attemptId: item.attemptId,
      url: safeTraceUrl(item.url),
      redirectChain: publicRedirectChain(item.redirectChain),
      policyDecision: item.policyDecision,
      reason: boundedTraceText(item.reason, 1_000),
      auditedAt: item.auditedAt
    })),
    summary: { counts: job.traceSummary.counts, total: job.traceSummary.total },
    pages: job.tracePages,
    budget: job.traceBudget
  };
}

export function assertSerializedTraceResponseBudget(response: JobDetail): void {
  const bytes = Buffer.byteLength(JSON.stringify(response), "utf8");
  if (bytes > TRACE_MAX_SERIALIZED_BYTES) throw new Error("Serialized trace response budget exceeded.");
}

function decisionInputHash(rawSelection: unknown): string | undefined {
  if (!rawSelection || typeof rawSelection !== "object" || Array.isArray(rawSelection)) return undefined;
  const record = rawSelection as Record<string, unknown>;
  if (typeof record.inputHash === "string" && record.inputHash.trim()) return boundedTraceText(record.inputHash, MAX_HASH_LENGTH);
  return undefined;
}

function decisionInputs(rawSelection: unknown): Record<string, unknown> | undefined {
  if (!rawSelection || typeof rawSelection !== "object" || Array.isArray(rawSelection)) return undefined;
  const inputs = (rawSelection as Record<string, unknown>).inputs;
  if (inputs === undefined) return undefined;
  const sanitized = sanitizeTraceRecord(inputs);
  const serializedBytes = Buffer.byteLength(JSON.stringify(sanitized), "utf8");
  if (serializedBytes <= MAX_VALIDATED_INPUT_BYTES) return sanitized;
  return { __traceTruncated: { reason: "serialized_byte_budget", maxBytes: MAX_VALIDATED_INPUT_BYTES, observedBytes: serializedBytes } };
}

function publicRedirectChain(chain: string[]): string[] {
  if (chain.length <= MAX_REDIRECT_HOPS) return chain.map(safeTraceUrl);
  const kept = chain.slice(0, MAX_REDIRECT_HOPS - 1).map(safeTraceUrl);
  return [...kept, `https://trace.invalid/truncated?omitted=${chain.length - kept.length}`];
}

function boundedDependencies(dependencies: string[]): string[] {
  if (dependencies.length > 200) throw new Error("Tool attempt dependency trace exceeds its public record budget.");
  return dependencies;
}

function actionSummary(value: unknown): { phase?: string; ordinal?: number } | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const phase = typeof record.phase === "string" && record.phase.trim() ? boundedTraceText(record.phase, 100) : undefined;
  const ordinal = typeof record.ordinal === "number" && Number.isInteger(record.ordinal) && record.ordinal >= 0 ? record.ordinal : undefined;
  return phase === undefined && ordinal === undefined ? undefined : { ...(phase ? { phase } : {}), ...(ordinal !== undefined ? { ordinal } : {}) };
}
