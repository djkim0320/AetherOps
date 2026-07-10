import { z } from "zod";
import { CapabilityGrantSchema } from "./settings.js";
import { CodexReasoningEffortSchema } from "./settings.js";
import { EmptyParamsSchema, rpcRequestSchema } from "./common.js";

const nonEmptyString = z.string().trim().min(1);
const timestamp = z.string().datetime({ offset: true });

export const ToolDiagnosticSchema = z
  .object({
    name: nonEmptyString,
    category: z.enum(["agent", "engineering", "search", "storage"]),
    status: z.enum(["ready", "blocked", "unavailable"]),
    reason: nonEmptyString.optional()
  })
  .strict();

export const ToolsDiagnosticsResponseSchema = z
  .object({
    capabilities: CapabilityGrantSchema,
    tools: z.array(ToolDiagnosticSchema),
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
export type ToolsDiagnosticsResponse = z.infer<typeof ToolsDiagnosticsResponseSchema>;
export type CodexAuthStatusResponse = z.infer<typeof CodexAuthStatusResponseSchema>;
export type LlmStatusResponse = z.infer<typeof LlmStatusResponseSchema>;
