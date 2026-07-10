import { CodexAuthStatusResponseSchema, LlmStatusResponseSchema, ToolsDiagnosticsResponseSchema } from "../../contracts/api-v2/diagnostics.js";
import { SettingsResponseSchema, SettingsSaveParamsSchema } from "../../contracts/api-v2/settings.js";
import { callRpc } from "../platform/rpcTransport.js";

export const settingsApi = {
  get: () => callRpc("settings.get", {}, SettingsResponseSchema),
  save: (params: unknown) => callRpc("settings.save", SettingsSaveParamsSchema.parse(params), SettingsResponseSchema),
  codexStatus: () => callRpc("auth.codexStatus", {}, CodexAuthStatusResponseSchema),
  llmStatus: () => callRpc("llm.status", {}, LlmStatusResponseSchema),
  tools: () => callRpc("tools.diagnostics", {}, ToolsDiagnosticsResponseSchema)
};
