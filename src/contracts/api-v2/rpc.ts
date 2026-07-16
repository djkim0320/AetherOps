import { z } from "zod";

import { CodexAuthStatusRequestSchema, LlmStatusRequestSchema, ToolsDiagnosticsRequestSchema } from "./diagnostics.js";
import {
  EngineeringArtifactReadRequestSchema,
  EngineeringBaselineActivateRequestSchema,
  EngineeringBaselineGetRequestSchema,
  EngineeringBaselineListRequestSchema,
  EngineeringEnqueueRequestSchema,
  EngineeringPreflightRequestSchema
} from "./engineering.js";
import {
  ChatEnqueueRequestSchema,
  JobsGetRequestSchema,
  JobsListRequestSchema,
  LoopAbortRequestSchema,
  LoopPauseRequestSchema,
  LoopResumeRequestSchema,
  LoopStartRequestSchema
} from "./jobs.js";
import {
  ProjectsCreateRequestSchema,
  ProjectsGetRequestSchema,
  ProjectsListRequestSchema,
  ProjectsUpdateRequestSchema,
  SessionsCreateRequestSchema,
  SessionsDeleteRequestSchema
} from "./projects.js";
import { SettingsGetRequestSchema, SettingsSaveRequestSchema } from "./settings.js";
import { SnapshotGetRequestSchema } from "./snapshots.js";

export const API_V2_METHODS = [
  "projects.create",
  "projects.update",
  "projects.get",
  "projects.list",
  "sessions.create",
  "sessions.delete",
  "chat.enqueue",
  "loop.start",
  "loop.pause",
  "loop.resume",
  "loop.abort",
  "jobs.get",
  "jobs.list",
  "engineering.enqueue",
  "engineering.preflight",
  "engineering.baseline.activate",
  "engineering.baseline.get",
  "engineering.baseline.list",
  "engineering.artifact.read",
  "snapshots.get",
  "settings.get",
  "settings.save",
  "tools.diagnostics",
  "auth.codexStatus",
  "llm.status"
] as const;

export const ApiV2MethodSchema = z.enum(API_V2_METHODS);

export const ApiV2RpcRequestSchema = z.discriminatedUnion("method", [
  ProjectsCreateRequestSchema,
  ProjectsUpdateRequestSchema,
  ProjectsGetRequestSchema,
  ProjectsListRequestSchema,
  SessionsCreateRequestSchema,
  SessionsDeleteRequestSchema,
  ChatEnqueueRequestSchema,
  LoopStartRequestSchema,
  LoopPauseRequestSchema,
  LoopResumeRequestSchema,
  LoopAbortRequestSchema,
  JobsGetRequestSchema,
  JobsListRequestSchema,
  EngineeringEnqueueRequestSchema,
  EngineeringPreflightRequestSchema,
  EngineeringBaselineActivateRequestSchema,
  EngineeringBaselineGetRequestSchema,
  EngineeringBaselineListRequestSchema,
  EngineeringArtifactReadRequestSchema,
  SnapshotGetRequestSchema,
  SettingsGetRequestSchema,
  SettingsSaveRequestSchema,
  ToolsDiagnosticsRequestSchema,
  CodexAuthStatusRequestSchema,
  LlmStatusRequestSchema
]);

export type ApiV2Method = z.infer<typeof ApiV2MethodSchema>;
export type ApiV2RpcRequest = z.infer<typeof ApiV2RpcRequestSchema>;
