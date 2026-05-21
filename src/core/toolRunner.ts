import type { AppSettings, OpenCodeRunInput } from "./types.js";
import { createDefaultResearchTools, type ResearchToolResult, type ResearchTool } from "./toolRegistry.js";

export class ToolRunner {
  constructor(private readonly tools: ResearchTool[] = createDefaultResearchTools()) {}

  async runAll(input: OpenCodeRunInput, settings: AppSettings): Promise<ResearchToolResult[]> {
    const results: ResearchToolResult[] = [];
    const toolMap = new Map(this.tools.map((tool) => [normalizeToolName(tool.name), tool]));
    const requiredTools = (input.researchPlan?.requiredTools ?? [])
      .map(normalizeToolName)
      .filter((toolName) => toolName && toolName !== "opencodetool");

    for (const toolName of requiredTools) {
      const tool = toolMap.get(toolName);
      if (!tool) {
        throw new Error(`Required research tool is not registered: ${toolName}`);
      }
      const result = await tool.run(input, settings);
      if (result.toolRun.status !== "completed") {
        throw new Error(`${tool.name} did not complete successfully: ${result.toolRun.error ?? JSON.stringify(result.toolRun.output)}`);
      }
      results.push(result);
    }
    return results;
  }
}

function normalizeToolName(value: string): string {
  return value.replace(/\(.*?\)/g, "").replace(/\s+/g, "").trim().toLowerCase();
}
