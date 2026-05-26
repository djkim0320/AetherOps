import type { AppSettings, OpenCodeRunInput, ToolRun } from "./types.js";
import { createDefaultResearchTools, type ResearchToolResult, type ResearchTool } from "./toolRegistry.js";

type RollingOpenCodeRunInput = OpenCodeRunInput & { toolRuns?: ToolRun[] };

export class ToolRunner {
  constructor(private readonly tools: ResearchTool[] = createDefaultResearchTools()) {}

  listToolNames(): string[] {
    return [...new Set(this.tools.map((tool) => tool.name))];
  }

  hasTool(name: string): boolean {
    const normalized = normalizeToolName(name);
    return this.tools.some((tool) => normalizeToolName(tool.name) === normalized);
  }

  async runAll(input: OpenCodeRunInput, settings: AppSettings): Promise<ResearchToolResult[]> {
    const results: ResearchToolResult[] = [];
    let rollingInput: RollingOpenCodeRunInput = {
      ...input,
      evidence: [...(input.evidence ?? [])],
      artifacts: [...(input.artifacts ?? [])],
      sources: [...(input.sources ?? [])],
      toolRuns: []
    };
    const toolMap = new Map(this.tools.map((tool) => [normalizeToolName(tool.name), tool]));
    const requiredTools = (input.researchPlan?.requiredTools ?? [])
      .map(normalizeToolName)
      .filter((toolName) => toolName && toolName !== "opencodetool");

    for (const toolName of requiredTools) {
      const tool = toolMap.get(toolName);
      if (!tool) {
        throw new Error(`Required research tool is not registered: ${toolName}`);
      }
      const currentInput: RollingOpenCodeRunInput = {
        ...rollingInput,
        evidence: [...(rollingInput.evidence ?? [])],
        artifacts: [...(rollingInput.artifacts ?? [])],
        sources: [...(rollingInput.sources ?? [])],
        toolRuns: [...(rollingInput.toolRuns ?? [])]
      };
      const result = await tool.run(currentInput, settings);
      if (result.toolRun.status !== "completed") {
        throw new Error(`${tool.name} did not complete successfully: ${result.toolRun.error ?? JSON.stringify(result.toolRun.output)}`);
      }
      results.push(result);
      rollingInput = {
        ...rollingInput,
        evidence: [...(rollingInput.evidence ?? []), ...result.evidence],
        artifacts: [...(rollingInput.artifacts ?? []), ...result.artifacts],
        sources: [...(rollingInput.sources ?? []), ...result.sources],
        toolRuns: [...(rollingInput.toolRuns ?? []), result.toolRun]
      };
    }
    return results;
  }
}

export function normalizeToolName(value: string): string {
  return value.replace(/\(.*?\)/g, "").replace(/\s+/g, "").trim().toLowerCase();
}

export function dedupeResearchTools(tools: ResearchTool[]): ResearchTool[] {
  const map = new Map<string, ResearchTool>();
  for (const tool of tools) {
    map.set(normalizeToolName(tool.name), tool);
  }
  return [...map.values()];
}
