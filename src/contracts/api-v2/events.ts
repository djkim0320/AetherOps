import { z } from "zod";
import { RESEARCH_LOOP_STEPS } from "../../shared/kernel/researchLoop.js";
import { SSE_EVENT_NAMES } from "../../shared/kernel/sse.js";
import { EntityIdSchema, RevisionSchema, TimestampSchema } from "./common.js";
import { ChatMessageSchema, JobStatusSchema } from "./jobs.js";

export const SSE_EVENT_NAMES_V2 = SSE_EVENT_NAMES;

export const SseEventNameSchema = z.enum(SSE_EVENT_NAMES_V2);
export type SseEventName = z.infer<typeof SseEventNameSchema>;

const EventEnvelopeFields = {
  id: z.number().int().positive(),
  projectId: EntityIdSchema,
  projectRevision: RevisionSchema,
  occurredAt: TimestampSchema
};

export const ProjectSnapshotChangedEventSchema = z
  .object({
    ...EventEnvelopeFields,
    type: z.literal("project.snapshot.changed"),
    data: z
      .object({
        snapshotVersion: RevisionSchema,
        reason: z.enum(["project_updated", "job_changed", "resync_required"])
      })
      .strict()
  })
  .strict();

export const ChatMessageAppendedEventSchema = z
  .object({
    ...EventEnvelopeFields,
    type: z.literal("chat.message.appended"),
    data: z.object({ sessionId: EntityIdSchema, message: ChatMessageSchema }).strict()
  })
  .strict();

export const RunStatusChangedEventSchema = z
  .object({
    ...EventEnvelopeFields,
    type: z.literal("run.status.changed"),
    data: z
      .object({
        jobId: EntityIdSchema,
        status: JobStatusSchema,
        previousStatus: JobStatusSchema.optional(),
        reason: z.string().min(1).optional()
      })
      .strict()
  })
  .strict();

export const RunStepChangedEventSchema = z
  .object({
    ...EventEnvelopeFields,
    type: z.literal("run.step.changed"),
    data: z
      .object({
        jobId: EntityIdSchema,
        step: z.enum(RESEARCH_LOOP_STEPS),
        checkpointId: EntityIdSchema.optional()
      })
      .strict()
  })
  .strict();

export const ToolRunChangedEventSchema = z
  .object({
    ...EventEnvelopeFields,
    type: z.literal("tool.run.changed"),
    data: z
      .object({
        jobId: EntityIdSchema,
        toolRunId: EntityIdSchema,
        toolName: z.string().trim().min(1),
        status: z.enum(["queued", "running", "blocked", "failed", "completed"])
      })
      .strict()
  })
  .strict();

export const ArtifactCreatedEventSchema = z
  .object({
    ...EventEnvelopeFields,
    type: z.literal("artifact.created"),
    data: z
      .object({
        jobId: EntityIdSchema,
        artifactId: EntityIdSchema,
        name: z.string().trim().min(1),
        kind: z.string().trim().min(1)
      })
      .strict()
  })
  .strict();

export const SseEventSchema = z.discriminatedUnion("type", [
  ProjectSnapshotChangedEventSchema,
  ChatMessageAppendedEventSchema,
  RunStatusChangedEventSchema,
  RunStepChangedEventSchema,
  ToolRunChangedEventSchema,
  ArtifactCreatedEventSchema
]);

export type SseEvent = z.infer<typeof SseEventSchema>;
