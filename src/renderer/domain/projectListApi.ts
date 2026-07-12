import { z } from "zod";
import { ProjectSummarySchema } from "../../contracts/api-v2/projects.js";
import { callRpc } from "../platform/rpcTransport.js";

export const listProjects = () => callRpc("projects.list", {}, z.array(ProjectSummarySchema));
