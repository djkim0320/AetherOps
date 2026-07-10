import { z } from "zod";
import { JOB_KINDS, JOB_STATUSES } from "../../shared/kernel/job.js";
import { RESEARCH_LOOP_STEPS } from "../../shared/kernel/researchLoop.js";
import { EntityIdSchema, IdempotencyKeySchema, RevisionSchema, TimestampSchema, rpcRequestSchema } from "./common.js";

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
  .strict();

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

export const ChatEnqueueParamsSchema = EnqueueBaseSchema.extend({
  sessionId: EntityIdSchema,
  content: z.string().trim().min(1).max(100_000),
  clientMutationId: EntityIdSchema
}).strict();

export const LoopStartParamsSchema = EnqueueBaseSchema;
export const LoopResumeParamsSchema = EnqueueBaseSchema.extend({
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

export const JobsListResponseSchema = z.object({ jobs: z.array(JobSchema), nextCursor: EntityIdSchema.optional() }).strict();

export type JobsListResponse = z.infer<typeof JobsListResponseSchema>;
