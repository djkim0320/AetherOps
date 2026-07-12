import { z } from "zod";
import { JOB_KINDS, JOB_STATUSES } from "../../shared/kernel/job.js";
import { RESEARCH_LOOP_STEPS } from "../../shared/kernel/researchLoop.js";
import { isValidPublicSourceDomain } from "../../shared/kernel/sourceAccessPolicy.js";
import { EntityIdSchema, IdempotencyKeySchema, RevisionSchema, TimestampSchema, rpcRequestSchema } from "./common.js";
import { CapabilitySetSchema } from "./capabilities.js";
import { CodexModelIdSchema, CodexReasoningEffortSchema } from "./settings.js";

export const JOB_STATUSES_V2 = JOB_STATUSES;
export const JOB_KINDS_V2 = JOB_KINDS;

export const JobStatusSchema = z.enum(JOB_STATUSES_V2);
export const JobKindSchema = z.enum(JOB_KINDS_V2);
export type JobStatus = z.infer<typeof JobStatusSchema>;
export type JobKind = z.infer<typeof JobKindSchema>;

export const JobReceiptSchema = z
  .object({
    jobId: EntityIdSchema,
    projectId: EntityIdSchema,
    kind: JobKindSchema,
    status: z.literal("queued"),
    queuePosition: z.number().int().nonnegative(),
    acceptedAt: TimestampSchema,
    projectRevision: RevisionSchema
  })
  .strict();

export type JobReceipt = z.infer<typeof JobReceiptSchema>;

export const JobSchema = z
  .object({
    id: EntityIdSchema,
    projectId: EntityIdSchema,
    kind: JobKindSchema,
    status: JobStatusSchema,
    currentStep: z.enum(RESEARCH_LOOP_STEPS).optional(),
    idempotencyKey: IdempotencyKeySchema,
    resumesJobId: EntityIdSchema.optional(),
    resumeCheckpointId: EntityIdSchema.optional(),
    blockedReason: z.string().min(1).optional(),
    failureReason: z.string().min(1).optional(),
    createdAt: TimestampSchema,
    updatedAt: TimestampSchema,
    startedAt: TimestampSchema.optional(),
    finishedAt: TimestampSchema.optional()
  })
  .strict()
  .superRefine((job, context) => {
    if (job.status === "blocked" && !job.blockedReason) {
      context.addIssue({ code: "custom", path: ["blockedReason"], message: "blockedReason is required for blocked jobs" });
    }
    if (job.status === "failed" && !job.failureReason) {
      context.addIssue({ code: "custom", path: ["failureReason"], message: "failureReason is required for failed jobs" });
    }
  });

export type Job = z.infer<typeof JobSchema>;

export const ChatMessageSchema = z
  .object({
    id: EntityIdSchema,
    projectId: EntityIdSchema,
    sessionId: EntityIdSchema,
    role: z.enum(["user", "assistant"]),
    content: z.string().min(1),
    clientMutationId: EntityIdSchema.optional(),
    createdAt: TimestampSchema
  })
  .strict();

export type ChatMessage = z.infer<typeof ChatMessageSchema>;

const EnqueueBaseSchema = z
  .object({
    projectId: EntityIdSchema,
    idempotencyKey: IdempotencyKeySchema
  })
  .strict();

export const SourceAccessPolicySchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("offline") }).strict(),
  z.object({ mode: z.literal("allowlist"), urls: z.array(z.string().url()).min(1).max(32) }).strict(),
  z
    .object({
      mode: z.literal("discovery"),
      allowedDomains: z.array(z.string().trim().toLowerCase().refine(isValidPublicSourceDomain, "A public DNS domain is required.")).max(32)
    })
    .strict()
]);

export const JobToolPolicySchema = z
  .object({
    allowCodexCli: z.boolean(),
    sourceAccess: SourceAccessPolicySchema
  })
  .strict();

const ResearchEnqueueBaseSchema = EnqueueBaseSchema.extend({
  requestedCapabilities: CapabilitySetSchema,
  toolPolicy: JobToolPolicySchema
}).strict();

export const ChatEnqueueParamsSchema = EnqueueBaseSchema.extend({
  sessionId: EntityIdSchema,
  content: z.string().trim().min(1).max(100_000),
  clientMutationId: EntityIdSchema
}).strict();

export const LoopStartParamsSchema = ResearchEnqueueBaseSchema;
export const LoopResumeParamsSchema = ResearchEnqueueBaseSchema.extend({
  interruptedJobId: EntityIdSchema,
  checkpointId: EntityIdSchema
}).strict();

const JobControlParamsSchema = z
  .object({
    projectId: EntityIdSchema,
    jobId: EntityIdSchema,
    expectedProjectRevision: RevisionSchema
  })
  .strict();

export const LoopPauseParamsSchema = JobControlParamsSchema;
export const LoopAbortParamsSchema = JobControlParamsSchema;
export const JobsGetParamsSchema = z.object({ projectId: EntityIdSchema, jobId: EntityIdSchema }).strict();
export const JobsListParamsSchema = z
  .object({
    projectId: EntityIdSchema,
    status: JobStatusSchema.optional(),
    limit: z.number().int().min(1).max(200).default(50),
    cursor: EntityIdSchema.optional()
  })
  .strict();

export const ChatEnqueueRequestSchema = rpcRequestSchema("chat.enqueue", ChatEnqueueParamsSchema);
export const LoopStartRequestSchema = rpcRequestSchema("loop.start", LoopStartParamsSchema);
export const LoopPauseRequestSchema = rpcRequestSchema("loop.pause", LoopPauseParamsSchema);
export const LoopResumeRequestSchema = rpcRequestSchema("loop.resume", LoopResumeParamsSchema);
export const LoopAbortRequestSchema = rpcRequestSchema("loop.abort", LoopAbortParamsSchema);
export const JobsGetRequestSchema = rpcRequestSchema("jobs.get", JobsGetParamsSchema);
export const JobsListRequestSchema = rpcRequestSchema("jobs.list", JobsListParamsSchema);

export const JobRpcRequestSchema = z.discriminatedUnion("method", [
  ChatEnqueueRequestSchema,
  LoopStartRequestSchema,
  LoopPauseRequestSchema,
  LoopResumeRequestSchema,
  LoopAbortRequestSchema,
  JobsGetRequestSchema,
  JobsListRequestSchema
]);

export type JobRpcRequest = z.infer<typeof JobRpcRequestSchema>;
export type SourceAccessPolicy = z.infer<typeof SourceAccessPolicySchema>;
export type JobToolPolicy = z.infer<typeof JobToolPolicySchema>;

export const LlmInvocationTraceSchema = z
  .object({
    id: EntityIdSchema,
    model: z.string().trim().min(1),
    reasoningEffort: z.string().trim().min(1),
    promptVersion: z.string().trim().min(1),
    schemaVersion: z.string().trim().min(1),
    promptHash: z.string().trim().min(1),
    responseHash: z.string().trim().min(1).optional(),
    latencyMs: z.number().int().nonnegative().optional(),
    repairCount: z.number().int().nonnegative(),
    status: z.enum(["running", "completed", "failed"]),
    startedAt: TimestampSchema,
    completedAt: TimestampSchema.optional()
  })
  .strict();

export const ToolDecisionTraceSchema = z
  .object({
    id: EntityIdSchema,
    invocationId: EntityIdSchema.optional(),
    toolName: z.string().trim().min(1),
    purpose: z.string(),
    expectedOutcome: z.string(),
    userPinned: z.boolean(),
    policyStatus: z.enum(["accepted", "rejected"]),
    policyReason: z.string().trim().min(1).optional(),
    actionHash: z.string().trim().min(1).optional(),
    validatedInputs: z.record(z.string(), z.unknown()).optional(),
    actionSummary: z
      .object({
        phase: z.string().trim().min(1).optional(),
        ordinal: z.number().int().nonnegative().optional()
      })
      .strict()
      .optional(),
    createdAt: TimestampSchema
  })
  .strict();

export const ToolAttemptTraceSchema = z
  .object({
    id: EntityIdSchema,
    decisionId: EntityIdSchema,
    checkpointId: EntityIdSchema.optional(),
    ordinal: z.number().int().nonnegative(),
    status: z.enum(["queued", "running", "completed", "blocked", "failed", "interrupted", "quarantined"]),
    inputHash: z.string().trim().min(1),
    outputHash: z.string().trim().min(1).optional(),
    terminalCause: z.string().trim().min(1).optional(),
    dependsOnAttemptIds: z.array(EntityIdSchema),
    error: z.string().trim().min(1).optional(),
    queuedAt: TimestampSchema,
    startedAt: TimestampSchema.optional(),
    completedAt: TimestampSchema.optional()
  })
  .strict();

export const CodexCliExecutionTraceSchema = z
  .object({
    id: EntityIdSchema,
    attemptId: EntityIdSchema,
    model: CodexModelIdSchema,
    reasoningEffort: CodexReasoningEffortSchema,
    sandboxProfile: z.string().trim().min(1),
    networkPolicy: z.literal("disabled"),
    durationMs: z.number().int().nonnegative().optional(),
    exitCode: z.number().int().optional(),
    terminationReason: z.string().trim().min(1).optional(),
    eventCount: z.number().int().nonnegative(),
    workspaceManifestHash: z.string().trim().min(1).optional(),
    outputManifestHash: z.string().trim().min(1).optional(),
    createdAt: TimestampSchema,
    completedAt: TimestampSchema.optional()
  })
  .strict();

export const ToolOutputTraceSchema = z
  .object({
    id: EntityIdSchema,
    attemptId: EntityIdSchema,
    outputKind: z.enum(["source", "evidence", "artifact"]),
    outputId: EntityIdSchema,
    promoted: z.boolean(),
    createdAt: TimestampSchema,
    promotedAt: TimestampSchema.optional()
  })
  .strict();

export const NetworkAuditTraceSchema = z
  .object({
    id: EntityIdSchema,
    attemptId: EntityIdSchema.optional(),
    url: z.string().url(),
    redirectChain: z.array(z.string().url()),
    policyDecision: z.enum(["allowed", "denied"]),
    reason: z.string().trim().min(1).optional(),
    auditedAt: TimestampSchema
  })
  .strict();

export const JobDetailSchema = JobSchema.safeExtend({
  requestHash: z.string().trim().min(1).optional(),
  requestedCapabilities: CapabilitySetSchema.optional(),
  effectiveCapabilities: CapabilitySetSchema.optional(),
  toolPolicy: JobToolPolicySchema.optional(),
  traceAvailability: z.enum(["available", "legacy_unavailable"]),
  trace: z
    .object({
      llmInvocations: z.array(LlmInvocationTraceSchema),
      toolDecisions: z.array(ToolDecisionTraceSchema),
      toolAttempts: z.array(ToolAttemptTraceSchema),
      codexCliExecutions: z.array(CodexCliExecutionTraceSchema),
      outputs: z.array(ToolOutputTraceSchema),
      networkAudits: z.array(NetworkAuditTraceSchema)
    })
    .strict()
}).strict();

export type JobDetail = z.infer<typeof JobDetailSchema>;

export const JobsListResponseSchema = z.object({ jobs: z.array(JobSchema), nextCursor: EntityIdSchema.optional() }).strict();

export type JobsListResponse = z.infer<typeof JobsListResponseSchema>;
