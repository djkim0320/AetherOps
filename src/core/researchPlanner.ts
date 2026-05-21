import { createId, nowIso } from "./ids.js";
import type { LlmProvider } from "./llm.js";
import type {
  AppSettings,
  ContinuationDecision,
  ResearchPlan,
  ResearchSnapshot,
  ResearchSpecification
} from "./types.js";

interface PlanLlmResponse {
  objective?: string;
  targetQuestions?: string[];
  targetHypotheses?: string[];
  requiredTools?: string[];
  expectedSources?: string[];
  expectedArtifacts?: string[];
  executionSteps?: string[];
  stopCriteria?: string[];
}

export class ResearchPlanner {
  constructor(private readonly llm?: LlmProvider) {}

  async plan(input: {
    snapshot: ResearchSnapshot;
    specification: ResearchSpecification;
    iteration: number;
    settings: AppSettings;
    continuationDecision?: ContinuationDecision;
  }): Promise<ResearchPlan> {
    const defaultPlan = this.buildDefaultPlan(input);
    if (!this.llm || !(await this.llm.isAvailable())) {
      return defaultPlan;
    }

    try {
      const response = await this.llm.completeJson<PlanLlmResponse>({
        schemaName: "AetherOpsResearchPlan",
        system: [
          "Create an executable research plan for one iteration.",
          "If previous continuation decision exists, incorporate its planRevisionHints before choosing tools.",
          "Do not claim unavailable sources were collected. Return only JSON."
        ].join("\n"),
        user: [
          `Specification: ${JSON.stringify(input.specification)}`,
          `Previous validation: ${JSON.stringify(input.snapshot.validationResults.slice(-8))}`,
          `Previous continuation decision: ${JSON.stringify(input.continuationDecision)}`,
          `Settings: ${JSON.stringify({
            allowExternalSearch: input.settings.allowExternalSearch,
            allowCodeExecution: input.settings.allowCodeExecution,
            webSearchProvider: input.settings.webSearch.provider,
            openCodeEnabled: input.settings.openCode.enabled
          })}`,
          "Return keys: objective, targetQuestions, targetHypotheses, requiredTools, expectedSources, expectedArtifacts, executionSteps, stopCriteria."
        ].join("\n\n"),
        timeoutMs: 120_000
      });

      return {
        ...defaultPlan,
        objective: clean(response.objective) || defaultPlan.objective,
        targetQuestions: selectIdsOrText(response.targetQuestions, defaultPlan.targetQuestions),
        targetHypotheses: selectIdsOrText(response.targetHypotheses, defaultPlan.targetHypotheses),
        requiredTools: strings(response.requiredTools, defaultPlan.requiredTools),
        expectedSources: strings(response.expectedSources, defaultPlan.expectedSources),
        expectedArtifacts: strings(response.expectedArtifacts, defaultPlan.expectedArtifacts),
        executionSteps: strings(response.executionSteps, defaultPlan.executionSteps),
        steps: strings(response.executionSteps, defaultPlan.executionSteps),
        stopCriteria: strings(response.stopCriteria, defaultPlan.stopCriteria)
      };
    } catch {
      return defaultPlan;
    }
  }

  private buildDefaultPlan(input: {
    snapshot: ResearchSnapshot;
    specification: ResearchSpecification;
    iteration: number;
    settings: AppSettings;
    continuationDecision?: ContinuationDecision;
  }): ResearchPlan {
    const tools = [
      "OpenCodeTool",
      input.settings.allowExternalSearch ? "WebSearchTool" : "WebSearchTool(skipped)",
      "WebFetchTool",
      "PaperMetadataTool",
      input.settings.allowCodeExecution ? "CodeExecutionTool" : "CodeExecutionTool(skipped)",
      "ArtifactWriterTool",
      "DataAnalysisTool"
    ];
    const nextObjective = input.continuationDecision?.nextObjective;
    return {
      id: createId("plan"),
      projectId: input.snapshot.project.id,
      iteration: input.iteration,
      objective:
        nextObjective ||
        `Iteration ${input.iteration}: collect traceable evidence, normalize it, index it, and evaluate priority hypotheses for ${input.snapshot.project.topic}.`,
      targetQuestions: input.snapshot.questions.map((item) => item.id),
      targetHypotheses: input.snapshot.hypotheses.map((item) => item.id),
      requiredTools: tools,
      expectedSources: input.specification.requiredEvidenceTypes.length
        ? input.specification.requiredEvidenceTypes
        : ["raw source", "artifact", "tool log", "citation"],
      expectedArtifacts: [
        `artifacts/iteration-${input.iteration}/research-note.md`,
        `logs/iteration-${input.iteration}.json`
      ],
      executionSteps: [
        "Run configured execution/search/metadata tools.",
        "Record unavailable tools as tool_unavailable and evidence_gap.",
        "Write at least one iteration artifact.",
        "Prepare normalized source, artifact, claim, evidence, observation, and citation records."
      ],
      steps: [
        "Run configured execution/search/metadata tools.",
        "Record unavailable tools as tool_unavailable and evidence_gap.",
        "Write at least one iteration artifact.",
        "Prepare normalized source, artifact, claim, evidence, observation, and citation records."
      ],
      stopCriteria: [
        "No priority hypothesis remains inconclusive due to fixable evidence gaps.",
        "No new evidence/artifact/chunk/entity/relation is produced.",
        "maxLoopIterations is reached."
      ],
      createdAt: nowIso()
    };
  }
}

function clean(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function strings(value: unknown, defaultValue: string[]): string[] {
  const normalized = Array.isArray(value) ? value.map(clean).filter(Boolean) : [];
  return normalized.length ? normalized.slice(0, 12) : defaultValue;
}

function selectIdsOrText(value: unknown, defaultValue: string[]): string[] {
  return strings(value, defaultValue);
}
