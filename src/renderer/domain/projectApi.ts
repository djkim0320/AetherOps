import { z } from "zod";
import {
  ProjectSchema,
  ProjectSummarySchema,
  ProjectsCreateParamsSchema,
  ProjectsGetParamsSchema,
  ProjectsUpdateParamsSchema,
  SessionSchema,
  SessionsCreateParamsSchema,
  SessionsDeleteParamsSchema,
  type Project
} from "../../contracts/api-v2/projects.js";
import { callRpc } from "../platform/rpcTransport.js";

export const projectApi = {
  list: () => callRpc("projects.list", {}, z.array(ProjectSummarySchema)),
  get: (projectId: string) => callRpc("projects.get", ProjectsGetParamsSchema.parse({ projectId }), ProjectSchema),
  create: (params: z.input<typeof ProjectsCreateParamsSchema>) => callRpc("projects.create", ProjectsCreateParamsSchema.parse(params), ProjectSchema),
  update: (params: z.input<typeof ProjectsUpdateParamsSchema>) => callRpc("projects.update", ProjectsUpdateParamsSchema.parse(params), ProjectSchema),
  createSession: (params: z.input<typeof SessionsCreateParamsSchema>) => callRpc("sessions.create", SessionsCreateParamsSchema.parse(params), SessionSchema),
  deleteSession: (params: z.input<typeof SessionsDeleteParamsSchema>) =>
    callRpc("sessions.delete", SessionsDeleteParamsSchema.parse(params), z.object({ deleted: z.literal(true) }).passthrough())
};

export type ProjectModel = Project;
