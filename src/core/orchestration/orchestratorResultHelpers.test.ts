import { describe, expect, it } from "vitest";
import type { ResearchToolInput } from "../shared/types.js";
import { ToolRunnerError } from "../tools/toolRunner.js";
import { formatError } from "./orchestratorResultHelpers.js";

describe("orchestrator durable error boundary", () => {
  it("classifies a tool failure without copying raw stdout or stderr into project failure state", () => {
    const failure = new ToolRunnerError("WebSearchTool failed: stderr=RAW_TOOL_OUTPUT_CANARY", {
      completedResults: [],
      failure: new Error("stderr=RAW_TOOL_OUTPUT_CANARY"),
      rollingInput: {} as ResearchToolInput,
      toolName: "WebSearchTool"
    });

    expect(formatError(failure)).toBe("TOOL_EXECUTION_FAILED");
    expect(formatError(failure)).not.toContain("RAW_TOOL_OUTPUT_CANARY");
  });
});
