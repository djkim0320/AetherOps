import { z } from "zod";
import { RESEARCH_LOOP_STEPS } from "../../shared/kernel/researchLoop.js";
import { EmptyParamsSchema, EntityIdSchema, RevisionSchema, TimestampSchema, rpcRequestSchema } from "./common.js";
import { JobStatusSchema } from "./jobs.js";
import { CapabilitySetSchema } from "./capabilities.js";

export { CapabilitySetSchema } from "./capabilities.js";
export type { CapabilitySet } from "./capabilities.js";

export const ProjectExecutionStateSchema = z
  .object({
    status: z.union([z.literal("idle"), JobStatusSchema]),
    currentStep: z.enum(RESEARCH_LOOP_STEPS),
    activeJobId: EntityIdSchema.optional(),
    lastCheckpointId: EntityIdSchema.optional(),
    revision: RevisionSchema
  })
  .strict();

export type ProjectExecutionState = z.infer<typeof ProjectExecutionStateSchema>;

export const ProjectInputSchema = z
  .object({
    goal: z.string().trim().min(1).max(4_000),
    topic: z.string().trim().min(1).max(1_000),
    scope: z.string().trim().min(1).max(4_000),
    budget: z.string().trim().min(1).max(1_000)
  })
  .strict();

export type ProjectInput = z.infer<typeof ProjectInputSchema>;

export const ProjectSchema = z
  .object({
    id: EntityIdSchema,
    input: ProjectInputSchema,
    capabilities: CapabilitySetSchema,
    execution: ProjectExecutionStateSchema,
    createdAt: TimestampSchema,
    updatedAt: TimestampSchema
  })
  .strict();

export type Project = z.infer<typeof ProjectSchema>;

export const ProjectSummarySchema = ProjectSchema.pick({
  id: true,
  input: true,
  capabilities: true,
  execution: true,
  createdAt: true,
  updatedAt: true
});

export type ProjectSummary = z.infer<typeof ProjectSummarySchema>;

export const SessionSchema = z
  .object({
    id: EntityIdSchema,
    projectId: EntityIdSchema,
    title: z.string().trim().min(1).max(500),
    focus: z.string().max(4_000),
    createdAt: TimestampSchema,
    updatedAt: TimestampSchema
  })
  .strict();

export type Session = z.infer<typeof SessionSchema>;

export const ProjectsCreateParamsSchema = z.object({ input: ProjectInputSchema }).strict();
export const ProjectsUpdateParamsSchema = z
  .object({
    projectId: EntityIdSchema,
    expectedRevision: RevisionSchema,
    input: ProjectInputSchema.partial().strict(),
    capabilities: CapabilitySetSchema.partial().strict().optional()
  })
  .strict();
export const ProjectsGetParamsSchema = z.object({ projectId: EntityIdSchema }).strict();
export const ProjectsListParamsSchema = EmptyParamsSchema;

export const SessionsCreateParamsSchema = z
  .object({
    projectId: EntityIdSchema,
    title: z.string().trim().min(1).max(500).optional(),
    focus: z.string().max(4_000).optional()
  })
  .strict();
export const SessionsDeleteParamsSchema = z.object({ projectId: EntityIdSchema, sessionId: EntityIdSchema }).strict();

export const ProjectsCreateRequestSchema = rpcRequestSchema("projects.create", ProjectsCreateParamsSchema);
export const ProjectsUpdateRequestSchema = rpcRequestSchema("projects.update", ProjectsUpdateParamsSchema);
export const ProjectsGetRequestSchema = rpcRequestSchema("projects.get", ProjectsGetParamsSchema);
export const ProjectsListRequestSchema = rpcRequestSchema("projects.list", ProjectsListParamsSchema);
export const SessionsCreateRequestSchema = rpcRequestSchema("sessions.create", SessionsCreateParamsSchema);
export const SessionsDeleteRequestSchema = rpcRequestSchema("sessions.delete", SessionsDeleteParamsSchema);

export const ProjectRpcRequestSchema = z.discriminatedUnion("method", [
  ProjectsCreateRequestSchema,
  ProjectsUpdateRequestSchema,
  ProjectsGetRequestSchema,
  ProjectsListRequestSchema,
  SessionsCreateRequestSchema,
  SessionsDeleteRequestSchema
]);

export type ProjectRpcRequest = z.infer<typeof ProjectRpcRequestSchema>;
