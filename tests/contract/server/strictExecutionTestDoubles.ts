import type { LlmJsonRequest } from "../../../src/core/providers/llm.js";
import { DeterministicLlmProvider } from "../../../src/core/testing/orchestratorTestHarness.js";
import type { CodexCliAdapter } from "../../../src/core/shared/types.js";

export class UnregisteredToolPlanner extends DeterministicLlmProvider {
  override async completeJson<T>(request: LlmJsonRequest): Promise<T> {
    if (request.schemaName === "AetherOpsResearchPlan") {
      return {
        objective: "Request an unavailable tool.",
        targetQuestions: ["q1"],
        targetHypotheses: ["h1"],
        toolRequests: [
          {
            intentId: "unknown-tool",
            toolName: "UnavailableTool",
            purpose: "Verify unknown tool validation.",
            expectedOutcome: "Planning fails before execution.",
            inputs: {}
          }
        ],
        expectedSources: ["tool log"],
        expectedArtifacts: ["research-note.md"],
        executionSteps: ["Run unavailable tool"],
        stopCriteria: ["Planning fails when the tool is unregistered."],
        fetchCandidateUrls: []
      } as T;
    }
    return super.completeJson<T>(request);
  }
}

export function failingAdapter(): CodexCliAdapter {
  return {
    run: async () => {
      throw new Error("configured Codex CLI execution failed");
    }
  };
}
