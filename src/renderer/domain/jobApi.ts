import {
  ChatEnqueueParamsSchema,
  JobReceiptSchema,
  JobSchema,
  JobsListParamsSchema,
  JobsListResponseSchema,
  LoopAbortParamsSchema,
  LoopPauseParamsSchema,
  LoopResumeParamsSchema,
  LoopStartParamsSchema
} from "../../contracts/api-v2/jobs.js";
import { callRpc } from "../platform/rpcTransport.js";

export const jobApi = {
  list: (projectId: string) => callRpc("jobs.list", JobsListParamsSchema.parse({ projectId, limit: 50 }), JobsListResponseSchema),
  get: (projectId: string, jobId: string) => callRpc("jobs.get", { projectId, jobId }, JobSchema),
  enqueueChat: (params: unknown) => callRpc("chat.enqueue", ChatEnqueueParamsSchema.parse(params), JobReceiptSchema),
  start: (params: unknown) => callRpc("loop.start", LoopStartParamsSchema.parse(params), JobReceiptSchema),
  pause: (params: unknown) => callRpc("loop.pause", LoopPauseParamsSchema.parse(params), JobSchema),
  resume: (params: unknown) => callRpc("loop.resume", LoopResumeParamsSchema.parse(params), JobReceiptSchema),
  abort: (params: unknown) => callRpc("loop.abort", LoopAbortParamsSchema.parse(params), JobSchema)
};
