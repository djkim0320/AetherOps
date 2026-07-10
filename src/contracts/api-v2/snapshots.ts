import { z } from "zod";
import { RESEARCH_LOOP_STEPS } from "../../shared/kernel/index.js";
import { ProjectExecutionStateSchema } from "./projects.js";
import { rpcRequestSchema } from "./common.js";

const identifier = z.string().trim().min(1).max(256);
const timestamp = z.string().datetime({ offset: true });

export const ResearchLoopStepSchema = z.enum(RESEARCH_LOOP_STEPS);
export { ProjectExecutionStateSchema } from "./projects.js";

export const SnapshotGetParamsSchema = z
  .object({
    projectId: identifier
  })
  .strict();

export const SnapshotGetRequestSchema = rpcRequestSchema("snapshots.get", SnapshotGetParamsSchema);

export const ProjectSnapshotSchema = z
  .object({
    projectId: identifier,
    revision: z.number().int().nonnegative(),
    execution: ProjectExecutionStateSchema,
    updatedAt: timestamp,
    data: z.record(z.string(), z.unknown())
  })
  .strict();

export type { ProjectExecutionState } from "./projects.js";
export type SnapshotGetParams = z.infer<typeof SnapshotGetParamsSchema>;
export type ProjectSnapshot = z.infer<typeof ProjectSnapshotSchema>;
