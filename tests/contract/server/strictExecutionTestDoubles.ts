import type { LlmJsonRequest } from "../../../src/core/providers/llm.js";
import { DeterministicLlmProvider } from "../../../src/core/testing/orchestratorTestHarness.js";
import type { OpenCodeAdapter } from "../../../src/core/shared/types.js";

export class UnregisteredToolPlanner extends DeterministicLlmProvider {
  override async completeJson<T>(request: LlmJsonRequest): Promise<T> {
    if (request.schemaName === "AetherOpsResearchPlan") {
      return {
        objective: "Request an unavailable tool.",
        targetQuestions: ["q1"],
        targetHypotheses: ["h1"],
        requiredTools: ["OpenCodeTool", "UnavailableTool"],
        expectedSources: ["tool log"],
        expectedArtifacts: ["research-note.md"],
        executionSteps: ["Run unavailable tool"],
        stopCriteria: ["blocked when unavailable"]
      } as T;
    }
    return super.completeJson<T>(request);
  }
}

export function failingAdapter(): OpenCodeAdapter {
  return {
    run: async () => {
      throw new Error("configured OpenCode execution failed");
    }
  };
}
