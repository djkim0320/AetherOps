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
    availableTools: string[];
    continuationDecision?: ContinuationDecision;
  }): Promise<ResearchPlan> {
    const defaultPlan = this.buildDefaultPlan(input);
    if (!this.llm || !(await this.llm.isAvailable())) {
      throw new Error("LLM provider is required to create a research plan.");
    }

    const response = await this.llm.completeJson<PlanLlmResponse>({
      schemaName: "AetherOpsResearchPlan",
      system: [
        "Create an executable research plan for one iteration.",
        "If previous continuation decision exists, incorporate its planRevisionHints before choosing tools.",
        "Do not claim unavailable sources were collected.",
        "Choose requiredTools only from the provided availableTools list. Return only JSON."
      ].join("\n"),
      user: [
        `Specification: ${JSON.stringify(input.specification)}`,
        `Previous validation: ${JSON.stringify(input.snapshot.validationResults.slice(-8))}`,
        `Previous continuation decision: ${JSON.stringify(input.continuationDecision)}`,
        `Settings and executable tools: ${JSON.stringify({
          allowExternalSearch: input.settings.allowExternalSearch,
          allowCodeExecution: input.settings.allowCodeExecution,
          webSearchProvider: input.settings.webSearch.provider,
          openCodeEnabled: input.settings.openCode.enabled,
          availableTools: input.availableTools
        })}`,
        "Return keys: objective, targetQuestions, targetHypotheses, requiredTools, expectedSources, expectedArtifacts, executionSteps, stopCriteria."
      ].join("\n\n"),
      timeoutMs: 120_000
    });

    const requiredTools = ensureHintTools(strings(response.requiredTools, defaultPlan.requiredTools), input);
    return {
      ...defaultPlan,
      objective: clean(response.objective) || defaultPlan.objective,
      targetQuestions: selectIdsOrText(response.targetQuestions, defaultPlan.targetQuestions),
      targetHypotheses: selectIdsOrText(response.targetHypotheses, defaultPlan.targetHypotheses),
      requiredTools,
      expectedSources: strings(response.expectedSources, defaultPlan.expectedSources),
      expectedArtifacts: strings(response.expectedArtifacts, defaultPlan.expectedArtifacts),
      executionSteps: strings(response.executionSteps, defaultPlan.executionSteps),
      steps: strings(response.executionSteps, defaultPlan.executionSteps),
      stopCriteria: strings(response.stopCriteria, defaultPlan.stopCriteria)
    };
  }

  private buildDefaultPlan(input: {
    snapshot: ResearchSnapshot;
    specification: ResearchSpecification;
    iteration: number;
    settings: AppSettings;
    availableTools: string[];
    continuationDecision?: ContinuationDecision;
  }): ResearchPlan {
    const available = new Set(input.availableTools.map(normalizeToolName));
    const hasFetchHint = (input.continuationDecision?.planRevisionHints ?? []).some((hint) => /webfetchtool|fetch selected source urls/i.test(hint));
    const hasExternalUrls =
      input.snapshot.evidence.some((item) => typeof item.sourceUri === "string" && /^https?:\/\//i.test(item.sourceUri)) ||
      input.snapshot.sources.some((source) => typeof source.url === "string" && /^https?:\/\//i.test(source.url));
    const externalSearchReady = input.settings.allowExternalSearch && input.settings.webSearch.provider !== "disabled";
    const candidateTools = [
      "OpenCodeTool",
      ...(externalSearchReady ? ["WebSearchTool"] : []),
      ...(externalSearchReady && (hasFetchHint || hasExternalUrls || available.has(normalizeToolName("WebSearchTool"))) ? ["WebFetchTool"] : []),
      ...(input.settings.browserUse.enabled && input.settings.allowExternalSearch ? ["BackgroundBrowserTool"] : []),
      ...(input.settings.allowCodeExecution ? ["CodeExecutionTool"] : []),
      "ArtifactWriterTool",
      "DataAnalysisTool"
    ];
    const tools = candidateTools.filter((tool) => tool === "OpenCodeTool" || available.has(normalizeToolName(tool)));
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
        "Stop with a structured blocked/failed state if a required tool is unavailable.",
        "Write at least one iteration artifact.",
        "Prepare normalized source, artifact, claim, evidence, observation, and citation records."
      ],
      steps: [
        "Run configured execution/search/metadata tools.",
        "Stop with a structured blocked/failed state if a required tool is unavailable.",
        "Write at least one iteration artifact.",
        "Prepare normalized source, artifact, claim, evidence, observation, and citation records."
      ],
      stopCriteria: [
        "No priority hypothesis remains inconclusive due to fixable evidence gaps.",
        "No new evidence/artifact/chunk/entity/relation is produced.",
        "The internal runaway-prevention safety cap is reached."
      ],
      createdAt: nowIso()
    };
  }
}

function ensureHintTools(
  tools: string[],
  input: {
    availableTools: string[];
    continuationDecision?: ContinuationDecision;
  }
): string[] {
  const available = new Set(input.availableTools.map(normalizeToolName));
  const needsFetch = (input.continuationDecision?.planRevisionHints ?? []).some((hint) => /webfetchtool|fetch selected source urls/i.test(hint));
  const result = [...tools];
  if (needsFetch && available.has(normalizeToolName("WebFetchTool")) && !result.some((tool) => normalizeToolName(tool) === normalizeToolName("WebFetchTool"))) {
    result.push("WebFetchTool");
  }
  return result;
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

function normalizeToolName(value: string): string {
  return value.replace(/\(.*?\)/g, "").replace(/\s+/g, "").trim().toLowerCase();
}
