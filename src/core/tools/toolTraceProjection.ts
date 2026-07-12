import type { ResearchToolResult, ToolExecutionStatusEvent } from "./researchToolTypes.js";

export function codexTraceEvent(result: ResearchToolResult): Pick<ToolExecutionStatusEvent, "codexCliTrace"> {
  if (result.toolRun.toolName !== "CodexCliTool" || !result.toolRun.output || typeof result.toolRun.output !== "object") return {};
  const trace = (result.toolRun.output as Record<string, unknown>).codexCliTrace;
  if (!trace || typeof trace !== "object" || Array.isArray(trace)) return {};
  return { codexCliTrace: trace as NonNullable<ToolExecutionStatusEvent["codexCliTrace"]> };
}
