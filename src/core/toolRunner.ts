import type { AppSettings, OpenCodeRunInput } from "./types.js";
import { createDefaultResearchTools, type ResearchToolResult, type ResearchTool } from "./toolRegistry.js";

export class ToolRunner {
  constructor(private readonly tools: ResearchTool[] = createDefaultResearchTools()) {}

  async runAll(input: OpenCodeRunInput, settings: AppSettings): Promise<ResearchToolResult[]> {
    const results: ResearchToolResult[] = [];
    for (const tool of this.tools) {
      try {
        results.push(await tool.run(input, settings));
      } catch (error) {
        const failed = await this.safeFailure(tool, input, error);
        results.push(failed);
      }
    }
    return results;
  }

  private async safeFailure(tool: ResearchTool, input: OpenCodeRunInput, error: unknown): Promise<ResearchToolResult> {
    const { createId, nowIso } = await import("./ids.js");
    const completedAt = nowIso();
    return {
      toolRun: {
        id: createId("tool"),
        projectId: input.project.id,
        iteration: input.iteration,
        toolName: tool.name,
        input: { tool: tool.name },
        output: { error: error instanceof Error ? error.message : String(error) },
        status: "failed",
        error: "tool_failed",
        startedAt: completedAt,
        completedAt
      },
      evidence: [
        {
          id: createId("evidence"),
          projectId: input.project.id,
          category: "experiment_log",
          title: `${tool.name} failed`,
          summary: error instanceof Error ? error.message : String(error),
          keywords: ["tool_failed", "evidence_gap", tool.name],
          linkedHypothesisIds: input.hypotheses.map((hypothesis) => hypothesis.id),
          reliabilityScore: 0.1,
          relevanceScore: 0.25,
          evidenceStrength: "weak",
          limitations: ["Tool execution failed; this is not substantive research evidence."],
          createdAt: completedAt
        }
      ],
      artifacts: [],
      sources: []
    };
  }
}
