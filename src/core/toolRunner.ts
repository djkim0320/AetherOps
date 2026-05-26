import type { AppSettings, OpenCodeRunInput, ToolRun } from "./types.js";
import { createDefaultResearchTools, type ResearchToolResult, type ResearchTool } from "./toolRegistry.js";

type RollingOpenCodeRunInput = OpenCodeRunInput & { toolRuns?: ToolRun[] };

export interface ToolRunnerResult {
  completedResults: ResearchToolResult[];
  failedResult?: ResearchToolResult;
  failure?: Error;
  rollingInput: OpenCodeRunInput;
}

export class ToolRunnerError extends Error {
  readonly partialResults: ResearchToolResult[];
  readonly failedResult?: ResearchToolResult;
  readonly rollingInput: OpenCodeRunInput;
  readonly failure?: Error;

  constructor(message: string, result: ToolRunnerResult) {
    super(message);
    this.name = "ToolRunnerError";
    this.partialResults = result.completedResults;
    this.failedResult = result.failedResult;
    this.rollingInput = result.rollingInput;
    this.failure = result.failure;
  }
}

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
      toolRuns: [...(input.toolRuns ?? [])]
    };
    const toolMap = new Map(this.tools.map((tool) => [normalizeToolName(tool.name), tool]));
    const requiredTools = orderToolNames(input.researchPlan?.requiredTools ?? [])
      .map(normalizeToolName)
      .filter((toolName) => toolName && toolName !== "opencodetool");

    for (const toolName of requiredTools) {
      const tool = toolMap.get(toolName);
      if (!tool) {
        throw new ToolRunnerError(`Required research tool is not registered: ${toolName}`, {
          completedResults: results,
          rollingInput
        });
      }
      const currentInput: RollingOpenCodeRunInput = {
        ...rollingInput,
        evidence: [...(rollingInput.evidence ?? [])],
        artifacts: [...(rollingInput.artifacts ?? [])],
        sources: [...(rollingInput.sources ?? [])],
        toolRuns: [...(rollingInput.toolRuns ?? [])]
      };
      let result: ResearchToolResult;
      try {
        result = await tool.run(currentInput, settings);
      } catch (error) {
        const failure = error instanceof Error ? error : new Error(String(error));
        throw new ToolRunnerError(`${tool.name} failed before returning a tool result: ${failure.message}`, {
          completedResults: results,
          failure,
          rollingInput
        });
      }
      if (result.toolRun.status !== "completed") {
        throw new ToolRunnerError(`${tool.name} did not complete successfully: ${result.toolRun.error ?? JSON.stringify(result.toolRun.output)}`, {
          completedResults: results,
          failedResult: result,
          rollingInput: accumulateToolResult(rollingInput, result)
        });
      }
      results.push(result);
      rollingInput = accumulateToolResult(rollingInput, result);
    }
    return results;
  }
}

function accumulateToolResult(input: RollingOpenCodeRunInput, result: ResearchToolResult): RollingOpenCodeRunInput {
  return {
    ...input,
    evidence: [...(input.evidence ?? []), ...result.evidence],
    artifacts: [...(input.artifacts ?? []), ...result.artifacts],
    sources: [...(input.sources ?? []), ...result.sources],
    toolRuns: [...(input.toolRuns ?? []), result.toolRun]
  };
}

export function normalizeToolName(value: string): string {
  return value.replace(/\(.*?\)/g, "").replace(/\s+/g, "").trim().toLowerCase();
}

const canonicalToolOrder = [
  "opencodetool",
  "websearchtool",
  "backgroundbrowsertool",
  "webfetchtool",
  "papermetadatatool",
  "pdfingestiontool",
  "codeexecutiontool",
  "artifactwritertool",
  "dataanalysistool"
];

export function orderToolNames(values: string[]): string[] {
  const firstSeen = new Map<string, string>();
  for (const value of values) {
    const normalized = normalizeToolName(value);
    if (normalized && !firstSeen.has(normalized)) {
      firstSeen.set(normalized, value);
    }
  }
  return [...firstSeen.entries()]
    .sort(([left], [right]) => {
      const leftIndex = canonicalToolOrder.indexOf(left);
      const rightIndex = canonicalToolOrder.indexOf(right);
      if (leftIndex === -1 && rightIndex === -1) return 0;
      if (leftIndex === -1) return 1;
      if (rightIndex === -1) return -1;
      return leftIndex - rightIndex;
    })
    .map(([, value]) => value);
}

export function dedupeResearchTools(tools: ResearchTool[]): ResearchTool[] {
  const map = new Map<string, ResearchTool>();
  for (const tool of tools) {
    map.set(normalizeToolName(tool.name), tool);
  }
  return [...map.values()];
}
