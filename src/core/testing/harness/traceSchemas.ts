import { z } from "zod";

const StableIdSchema = z
  .string()
  .min(1)
  .max(160)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/);
const HashSchema = z.string().regex(/^[a-f0-9]{64}$/);
const ShortTextSchema = z.string().trim().min(1).max(1_000);
const EventIdSchema = z.string().uuid();
const baseFields = {
  schemaVersion: z.literal(1),
  eventId: EventIdSchema,
  runId: z.string().uuid(),
  caseId: StableIdSchema,
  projectId: StableIdSchema.optional(),
  jobId: StableIdSchema.optional(),
  sequence: z.number().int().positive(),
  timestamp: z.string().datetime({ offset: true }),
  dependsOn: z.array(EventIdSchema).max(64),
  previousEventHash: HashSchema.nullable(),
  eventHash: HashSchema
} as const;

function eventSchema<T extends string, S extends z.ZodType>(type: T, data: S) {
  return z.object({ ...baseFields, type: z.literal(type), data }).strict();
}

export const TaskCreatedTraceEventSchema = eventSchema(
  "task.created",
  z.object({ taskId: StableIdSchema, taskContractHash: HashSchema, objectiveHash: HashSchema }).strict()
);

export const RunStateRevisedTraceEventSchema = eventSchema(
  "run_state.revised",
  z
    .object({
      revision: z.number().int().nonnegative(),
      previousRevision: z.number().int().nonnegative().nullable(),
      stateHash: HashSchema,
      reason: z.enum(["created", "progress", "recovery", "resume", "terminal"])
    })
    .strict()
);

export const ContextCompiledTraceEventSchema = eventSchema(
  "context.compiled",
  z
    .object({
      contextPackHash: HashSchema,
      inputTokens: z.number().int().nonnegative(),
      loadedToolSchemaBytes: z.number().int().nonnegative(),
      selectedToolSpecs: z.array(z.object({ name: StableIdSchema, version: StableIdSchema }).strict()).max(32)
    })
    .strict()
);

export const ToolCandidatesRetrievedTraceEventSchema = eventSchema(
  "tool.candidates.retrieved",
  z.object({ queryHash: HashSchema, candidateNames: z.array(StableIdSchema).max(1_000), topK: z.number().int().nonnegative().max(1_000) }).strict()
);

export const ToolSelectedTraceEventSchema = eventSchema(
  "tool.selected",
  z.object({ selectionId: StableIdSchema, toolName: StableIdSchema, rank: z.number().int().positive(), decisionReason: ShortTextSchema }).strict()
);

export const ToolCallProposedTraceEventSchema = eventSchema(
  "tool.call.proposed",
  z
    .object({
      callId: StableIdSchema,
      selectionId: StableIdSchema,
      toolName: StableIdSchema,
      toolVersion: StableIdSchema,
      inputHash: HashSchema,
      mutating: z.boolean(),
      idempotencyKey: StableIdSchema.optional(),
      dependencyCallIds: z.array(StableIdSchema).max(32)
    })
    .strict()
);

export const ToolCallStartedTraceEventSchema = eventSchema(
  "tool.call.started",
  z.object({ callId: StableIdSchema, attempt: z.number().int().positive(), inputHash: HashSchema }).strict()
);

export const SideEffectReceiptSchema = z
  .object({
    receiptId: StableIdSchema,
    runId: z.string().uuid(),
    toolName: StableIdSchema,
    toolVersion: StableIdSchema,
    effectKey: StableIdSchema,
    inputHash: HashSchema,
    replayed: z.boolean()
  })
  .strict();

export const ToolCallCompletedTraceEventSchema = eventSchema(
  "tool.call.completed",
  z
    .object({
      callId: StableIdSchema,
      attempt: z.number().int().positive(),
      outcome: z.enum(["success", "partial", "transient_failure", "permanent_failure"]),
      outputArtifactIds: z.array(StableIdSchema).max(128),
      outputBytes: z.number().int().nonnegative(),
      sideEffectReceipt: SideEffectReceiptSchema.optional(),
      failureCode: StableIdSchema.optional()
    })
    .strict()
);

export const ToolCallVerifiedTraceEventSchema = eventSchema(
  "tool.call.verified",
  z
    .object({
      callId: StableIdSchema,
      verifier: z.enum(["postcondition", "schema", "artifact_diff", "test", "query"]),
      passed: z.boolean(),
      checks: z.array(StableIdSchema).min(1).max(32),
      promotedArtifactIds: z.array(StableIdSchema).max(128)
    })
    .strict()
);

export const ToolCallRejectedTraceEventSchema = eventSchema(
  "tool.call.rejected",
  z
    .object({
      callId: StableIdSchema,
      toolName: StableIdSchema,
      reasonCode: z.enum(["prohibited", "capability_denied", "schema_invalid", "precondition_failed", "injection_detected"]),
      reason: ShortTextSchema
    })
    .strict()
);

export const RecoverySelectedTraceEventSchema = eventSchema(
  "recovery.selected",
  z
    .object({
      failedCallId: StableIdSchema,
      strategy: z.enum(["retry", "resume", "alternate_tool", "stop"]),
      retryCallId: StableIdSchema.optional(),
      reason: ShortTextSchema
    })
    .strict()
);

export const MemoryCandidateCreatedTraceEventSchema = eventSchema(
  "memory.candidate.created",
  z
    .object({
      candidateId: StableIdSchema,
      sourceArtifactIds: z.array(StableIdSchema).min(1).max(64),
      scope: z.enum(["run", "project", "user"]),
      contentHash: HashSchema
    })
    .strict()
);

export const MemoryCandidateDispositionedTraceEventSchema = eventSchema(
  "memory.candidate.dispositioned",
  z.object({ candidateId: StableIdSchema, disposition: z.enum(["accepted", "rejected", "quarantined"]), policyReason: ShortTextSchema }).strict()
);

export const MemoryRetrievedTraceEventSchema = eventSchema(
  "memory.retrieved",
  z
    .object({
      queryHash: HashSchema,
      records: z.array(z.object({ recordId: StableIdSchema, owningProjectId: StableIdSchema }).strict()).max(128),
      scope: z.enum(["run", "project", "user"]),
      selectionReasons: z.array(ShortTextSchema).max(128),
      authorizationReceipt: z.object({ requestedProjectId: StableIdSchema, decision: z.literal("allowed"), policyHash: HashSchema }).strict()
    })
    .strict()
);

export const MemoryRevalidatedTraceEventSchema = eventSchema(
  "memory.revalidated",
  z.object({ recordId: StableIdSchema, valid: z.boolean(), reason: ShortTextSchema }).strict()
);

export const SkillSelectedTraceEventSchema = eventSchema(
  "skill.selected",
  z.object({ skillId: StableIdSchema, version: StableIdSchema, selectionReason: ShortTextSchema }).strict()
);

export const WorkOrderCreatedTraceEventSchema = eventSchema(
  "work_order.created",
  z
    .object({
      workOrderId: StableIdSchema,
      readOnly: z.boolean(),
      scopeKeys: z.array(StableIdSchema).min(1).max(64),
      dependencyWorkOrderIds: z.array(StableIdSchema).max(32)
    })
    .strict()
);

export const WorkOrderCompletedTraceEventSchema = eventSchema(
  "work_order.completed",
  z
    .object({
      workOrderId: StableIdSchema,
      outcome: z.enum(["completed", "failed", "blocked", "cancelled"]),
      receiptHash: HashSchema.optional(),
      reasonCode: StableIdSchema.optional(),
      conflictingWorkOrderId: StableIdSchema.optional()
    })
    .strict()
    .superRefine((completion, context) => {
      if (completion.outcome === "completed" && !completion.receiptHash) {
        context.addIssue({ code: "custom", path: ["receiptHash"], message: "Completed work orders require a receipt hash." });
      }
      if (completion.outcome !== "completed" && completion.receiptHash) {
        context.addIssue({ code: "custom", path: ["receiptHash"], message: "Non-completed work orders cannot include a success receipt." });
      }
      if (completion.outcome !== "completed" && !completion.reasonCode) {
        context.addIssue({ code: "custom", path: ["reasonCode"], message: "Non-completed work orders require a reason code." });
      }
      const isWriteConflict = completion.outcome === "blocked" && completion.reasonCode === "WRITE_SCOPE_CONFLICT";
      if (isWriteConflict !== Boolean(completion.conflictingWorkOrderId)) {
        context.addIssue({
          code: "custom",
          path: ["conflictingWorkOrderId"],
          message: "WRITE_SCOPE_CONFLICT completions must identify exactly one conflicting work-order owner."
        });
      }
    })
);

export const AcceptanceCheckedTraceEventSchema = eventSchema(
  "acceptance.checked",
  z.object({ criterionId: StableIdSchema, passed: z.boolean(), evidenceEventIds: z.array(EventIdSchema).max(128), message: ShortTextSchema }).strict()
);

export const EvalCompletedTraceEventSchema = eventSchema(
  "eval.completed",
  z
    .object({ result: z.enum(["passed", "failed", "blocked"]), acceptancePassed: z.number().int().nonnegative(), acceptanceTotal: z.number().int().positive() })
    .strict()
);

export const TraceEventTypeSchema = z.enum([
  "task.created",
  "run_state.revised",
  "context.compiled",
  "tool.candidates.retrieved",
  "tool.selected",
  "tool.call.proposed",
  "tool.call.started",
  "tool.call.completed",
  "tool.call.verified",
  "tool.call.rejected",
  "recovery.selected",
  "memory.candidate.created",
  "memory.candidate.dispositioned",
  "memory.retrieved",
  "memory.revalidated",
  "skill.selected",
  "work_order.created",
  "work_order.completed",
  "acceptance.checked",
  "eval.completed"
]);

export const TraceEventSchema = z.discriminatedUnion("type", [
  TaskCreatedTraceEventSchema,
  RunStateRevisedTraceEventSchema,
  ContextCompiledTraceEventSchema,
  ToolCandidatesRetrievedTraceEventSchema,
  ToolSelectedTraceEventSchema,
  ToolCallProposedTraceEventSchema,
  ToolCallStartedTraceEventSchema,
  ToolCallCompletedTraceEventSchema,
  ToolCallVerifiedTraceEventSchema,
  ToolCallRejectedTraceEventSchema,
  RecoverySelectedTraceEventSchema,
  MemoryCandidateCreatedTraceEventSchema,
  MemoryCandidateDispositionedTraceEventSchema,
  MemoryRetrievedTraceEventSchema,
  MemoryRevalidatedTraceEventSchema,
  SkillSelectedTraceEventSchema,
  WorkOrderCreatedTraceEventSchema,
  WorkOrderCompletedTraceEventSchema,
  AcceptanceCheckedTraceEventSchema,
  EvalCompletedTraceEventSchema
]);

export const TraceSchema = z.array(TraceEventSchema).min(1).max(100_000);

export type TraceEventType = z.infer<typeof TraceEventTypeSchema>;
export type TaskCreatedTraceEvent = z.infer<typeof TaskCreatedTraceEventSchema>;
export type RunStateRevisedTraceEvent = z.infer<typeof RunStateRevisedTraceEventSchema>;
export type ContextCompiledTraceEvent = z.infer<typeof ContextCompiledTraceEventSchema>;
export type ToolCandidatesRetrievedTraceEvent = z.infer<typeof ToolCandidatesRetrievedTraceEventSchema>;
export type ToolSelectedTraceEvent = z.infer<typeof ToolSelectedTraceEventSchema>;
export type ToolCallProposedTraceEvent = z.infer<typeof ToolCallProposedTraceEventSchema>;
export type ToolCallStartedTraceEvent = z.infer<typeof ToolCallStartedTraceEventSchema>;
export type ToolCallCompletedTraceEvent = z.infer<typeof ToolCallCompletedTraceEventSchema>;
export type ToolCallVerifiedTraceEvent = z.infer<typeof ToolCallVerifiedTraceEventSchema>;
export type ToolCallRejectedTraceEvent = z.infer<typeof ToolCallRejectedTraceEventSchema>;
export type RecoverySelectedTraceEvent = z.infer<typeof RecoverySelectedTraceEventSchema>;
export type MemoryCandidateCreatedTraceEvent = z.infer<typeof MemoryCandidateCreatedTraceEventSchema>;
export type MemoryCandidateDispositionedTraceEvent = z.infer<typeof MemoryCandidateDispositionedTraceEventSchema>;
export type MemoryRetrievedTraceEvent = z.infer<typeof MemoryRetrievedTraceEventSchema>;
export type MemoryRevalidatedTraceEvent = z.infer<typeof MemoryRevalidatedTraceEventSchema>;
export type SkillSelectedTraceEvent = z.infer<typeof SkillSelectedTraceEventSchema>;
export type WorkOrderCreatedTraceEvent = z.infer<typeof WorkOrderCreatedTraceEventSchema>;
export type WorkOrderCompletedTraceEvent = z.infer<typeof WorkOrderCompletedTraceEventSchema>;
export type AcceptanceCheckedTraceEvent = z.infer<typeof AcceptanceCheckedTraceEventSchema>;
export type EvalCompletedTraceEvent = z.infer<typeof EvalCompletedTraceEventSchema>;
export type SideEffectReceipt = z.infer<typeof SideEffectReceiptSchema>;
export type TraceEvent = z.infer<typeof TraceEventSchema>;
