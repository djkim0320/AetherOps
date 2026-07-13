import {
  ChatEnqueueParamsSchema,
  JobReceiptSchema,
  JobDetailSchema,
  JobSchema,
  JobsGetParamsSchema,
  JobsListParamsSchema,
  JobsListResponseSchema,
  LoopAbortParamsSchema,
  LoopPauseParamsSchema,
  LoopResumeParamsSchema,
  LoopStartParamsSchema,
  type TracePageRequest
} from "../../contracts/api-v2/jobs.js";
import { callRpc } from "../platform/rpcTransport.js";

export const jobApi = {
  list: (projectId: string) => callRpc("jobs.list", JobsListParamsSchema.parse({ projectId, limit: 50 }), JobsListResponseSchema),
  get: (projectId: string, jobId: string, tracePage?: TracePageRequest) =>
    callRpc("jobs.get", JobsGetParamsSchema.parse({ projectId, jobId, ...(tracePage ? { tracePage } : {}) }), JobDetailSchema),
  enqueueChat: (params: unknown) => callRpc("chat.enqueue", ChatEnqueueParamsSchema.parse(params), JobReceiptSchema),
  start: (params: unknown) => callRpc("loop.start", LoopStartParamsSchema.parse(params), JobReceiptSchema),
  pause: (params: unknown) => callRpc("loop.pause", LoopPauseParamsSchema.parse(params), JobSchema),
  resume: (params: unknown) => callRpc("loop.resume", LoopResumeParamsSchema.parse(params), JobReceiptSchema),
  abort: (params: unknown) => callRpc("loop.abort", LoopAbortParamsSchema.parse(params), JobSchema)
};
