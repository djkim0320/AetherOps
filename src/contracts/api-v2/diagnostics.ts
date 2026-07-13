import { z } from "zod";
import { CapabilityGrantSchema } from "./settings.js";
import { CodexReasoningEffortSchema } from "./settings.js";
import { EmptyParamsSchema, EntityIdSchema, rpcRequestSchema } from "./common.js";

const nonEmptyString = z.string().trim().min(1);
const timestamp = z.string().datetime({ offset: true });
const count = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const positiveCount = count.min(1);

export const ToolDiagnosticSchema = z
  .object({
    name: nonEmptyString,
    category: z.enum(["agent", "engineering", "search", "storage"]),
    status: z.enum(["ready", "blocked", "unavailable"]),
    reason: nonEmptyString.optional()
  })
  .strict();

export const ReliabilityRuntimeCountersSchema = z
  .object({
    activeProjectCount: count,
    activeJobCount: count,
    leaseRenewalSuccessCount: count,
    leaseRenewalFailureCount: count,
    leaseLostCount: count,
    staleWriteRejectionCount: count,
    recoveryScannedProjectCount: count
  })
  .strict();

export const ReliabilitySseSchema = z
  .object({
    activeConnectionCount: count,
    bufferedEventCount: count,
    bufferedBytes: count,
    peakBufferedEventCount: count,
    peakBufferedBytes: count,
    slowConsumerDisconnectCount: count,
    replayCount: count,
    replayedEventCount: count,
    replayTotalDurationMs: count,
    replayMaxDurationMs: count,
    replayLastDurationMs: count
  })
  .strict()
  .superRefine((value, context) => {
    if (value.bufferedEventCount > value.peakBufferedEventCount) {
      context.addIssue({ code: "custom", message: "buffered event peak is inconsistent", path: ["peakBufferedEventCount"] });
    }
    if (value.bufferedBytes > value.peakBufferedBytes) {
      context.addIssue({ code: "custom", message: "buffered byte peak is inconsistent", path: ["peakBufferedBytes"] });
    }
    validateAggregate(value.replayCount, value.replayTotalDurationMs, value.replayMaxDurationMs, value.replayLastDurationMs, context, "replay");
  });

export const ReliabilityTraceQuerySchema = z
  .object({
    queryCount: count,
    totalDurationMs: count,
    maxDurationMs: count,
    lastDurationMs: count,
    totalRows: count,
    maxRows: count,
    lastRows: count
  })
  .strict()
  .superRefine((value, context) => {
    validateAggregate(value.queryCount, value.totalDurationMs, value.maxDurationMs, value.lastDurationMs, context, "query duration");
    validateAggregate(value.queryCount, value.totalRows, value.maxRows, value.lastRows, context, "query rows");
  });

export const ReliabilityStorageTransactionSchema = z
  .object({
    transactionCount: count,
    totalDurationMs: count,
    maxDurationMs: count,
    lastDurationMs: count
  })
  .strict()
  .superRefine((value, context) => {
    validateAggregate(value.transactionCount, value.totalDurationMs, value.maxDurationMs, value.lastDurationMs, context, "transaction duration");
  });

export const ReliabilityQueueProjectSchema = z
  .object({
    projectId: EntityIdSchema,
    depth: positiveCount,
    oldestQueuedAt: timestamp,
    oldestQueuedAgeMs: count
  })
  .strict();

export const ReliabilityQueueSchema = z
  .object({
    projects: z.array(ReliabilityQueueProjectSchema).max(500),
    totalDepth: count,
    oldestQueuedAt: timestamp.optional(),
    oldestQueuedAgeMs: count.optional(),
    totalProjects: count,
    truncated: z.boolean()
  })
  .strict()
  .superRefine((value, context) => {
    const returnedDepth = value.projects.reduce((total, project) => total + project.depth, 0);
    if (returnedDepth > value.totalDepth || (!value.truncated && returnedDepth !== value.totalDepth)) {
      context.addIssue({ code: "custom", message: "queue depth summary is inconsistent", path: ["totalDepth"] });
    }
    if (value.truncated !== value.projects.length < value.totalProjects) {
      context.addIssue({ code: "custom", message: "queue truncation metadata is inconsistent", path: ["truncated"] });
    }
    if (value.totalDepth > 0 !== Boolean(value.oldestQueuedAt && value.oldestQueuedAgeMs !== undefined)) {
      context.addIssue({ code: "custom", message: "queue oldest age metadata is inconsistent", path: ["oldestQueuedAt"] });
    }
    if (new Set(value.projects.map((project) => project.projectId)).size !== value.projects.length) {
      context.addIssue({ code: "custom", message: "queue projects must be unique", path: ["projects"] });
    }
  });

export const ReliabilityDiagnosticsSchema = z
  .object({
    generatedAt: timestamp,
    countersSince: timestamp,
    runtime: ReliabilityRuntimeCountersSchema,
    sse: ReliabilitySseSchema,
    traceQueries: ReliabilityTraceQuerySchema,
    storageTransactions: ReliabilityStorageTransactionSchema,
    queue: ReliabilityQueueSchema
  })
  .strict();

export const ToolsDiagnosticsResponseSchema = z
  .object({
    capabilities: CapabilityGrantSchema,
    tools: z.array(ToolDiagnosticSchema),
    reliability: ReliabilityDiagnosticsSchema,
    generatedAt: timestamp
  })
  .strict();

export const CodexAuthStatusResponseSchema = z
  .object({
    provider: z.literal("codex-oauth"),
    status: z.enum(["authenticated", "unauthenticated", "error"]),
    authenticated: z.boolean(),
    accountLabel: nonEmptyString.optional(),
    expiresAt: timestamp.optional(),
    message: nonEmptyString.optional()
  })
  .strict()
  .superRefine((value, context) => {
    if (value.authenticated !== (value.status === "authenticated")) {
      context.addIssue({ code: "custom", message: "authenticated must match status", path: ["authenticated"] });
    }
  });

export const LlmStatusResponseSchema = z
  .object({
    provider: z.literal("codex-oauth"),
    model: nonEmptyString,
    reasoningEffort: CodexReasoningEffortSchema,
    catalog: z.enum(["supported", "unsupported"]),
    access: z.enum(["not_checked", "available", "unavailable"]),
    status: z.enum(["ready", "not_authenticated", "blocked", "error"]),
    available: z.boolean(),
    message: nonEmptyString.optional()
  })
  .strict()
  .superRefine((value, context) => {
    if (value.available !== (value.status === "ready")) {
      context.addIssue({ code: "custom", message: "available must match status", path: ["available"] });
    }
    if (value.catalog === "unsupported" && value.status !== "blocked") {
      context.addIssue({ code: "custom", message: "unsupported catalog entries must be blocked", path: ["status"] });
    }
    if (value.access === "unavailable" && value.status !== "blocked") {
      context.addIssue({ code: "custom", message: "unavailable model access must be blocked", path: ["status"] });
    }
  });

export const ToolsDiagnosticsRequestSchema = rpcRequestSchema("tools.diagnostics", EmptyParamsSchema);
export const CodexAuthStatusRequestSchema = rpcRequestSchema("auth.codexStatus", EmptyParamsSchema);
export const LlmStatusRequestSchema = rpcRequestSchema("llm.status", EmptyParamsSchema);

export type ToolDiagnostic = z.infer<typeof ToolDiagnosticSchema>;
export type ReliabilityDiagnostics = z.infer<typeof ReliabilityDiagnosticsSchema>;
export type ToolsDiagnosticsResponse = z.infer<typeof ToolsDiagnosticsResponseSchema>;
export type CodexAuthStatusResponse = z.infer<typeof CodexAuthStatusResponseSchema>;
export type LlmStatusResponse = z.infer<typeof LlmStatusResponseSchema>;

function validateAggregate(sampleCount: number, total: number, maximum: number, last: number, context: z.RefinementCtx, label: string): void {
  if (maximum > total || last > maximum) {
    context.addIssue({ code: "custom", message: `${label} aggregate is inconsistent` });
  }
  if (sampleCount === 0 && (total !== 0 || maximum !== 0 || last !== 0)) {
    context.addIssue({ code: "custom", message: `${label} must be zero without samples` });
  }
}
