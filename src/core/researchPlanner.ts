import { createId, nowIso } from "./ids.js";
import { LlmTimeoutError, type LlmProvider } from "./llm.js";
import { normalizeToolName, orderToolNames } from "./toolRunner.js";
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
  fetchCandidateUrls?: string[];
}

export class ResearchPlanner {
  constructor(
    private readonly llm?: LlmProvider,
    private readonly onTimeout?: (projectId: string, error: LlmTimeoutError, retryAttempt: number) => void | Promise<void>
  ) {}

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

    const response = await this.requestPlanJson(input, false);

    const fetchCandidateUrls = strings(response.fetchCandidateUrls, defaultPlan.fetchCandidateUrls ?? []);
    const expectedSources = strings(response.expectedSources, defaultPlan.expectedSources);
    const expectedSourcesWithFetchCandidates = fetchCandidateUrls.length
      ? [...new Set([...expectedSources, ...fetchCandidateUrls.map((url) => `Fetch candidate URL: ${url}`)])]
      : expectedSources;
    const requiredTools = orderToolNames(ensureHintTools(strings(response.requiredTools, defaultPlan.requiredTools), { ...input, fetchCandidateUrls }));
    return {
      ...defaultPlan,
      objective: clean(response.objective) || defaultPlan.objective,
      targetQuestions: selectIdsOrText(response.targetQuestions, defaultPlan.targetQuestions),
      targetHypotheses: selectIdsOrText(response.targetHypotheses, defaultPlan.targetHypotheses),
      requiredTools,
      expectedSources: expectedSourcesWithFetchCandidates,
      expectedArtifacts: strings(response.expectedArtifacts, defaultPlan.expectedArtifacts),
      executionSteps: strings(response.executionSteps, defaultPlan.executionSteps),
      steps: strings(response.executionSteps, defaultPlan.executionSteps),
      stopCriteria: strings(response.stopCriteria, defaultPlan.stopCriteria),
      fetchCandidateUrls
    };
  }

  private async requestPlanJson(input: {
    snapshot: ResearchSnapshot;
    specification: ResearchSpecification;
    iteration: number;
    settings: AppSettings;
    availableTools: string[];
    continuationDecision?: ContinuationDecision;
  }, compact: boolean): Promise<PlanLlmResponse> {
    try {
      return await this.requestPlanJsonOnce(input, compact);
    } catch (error) {
      if (!compact && error instanceof LlmTimeoutError) {
        await this.onTimeout?.(input.snapshot.project.id, error, 0);
        return this.requestPlanJson(input, true);
      }
      if (compact && error instanceof LlmTimeoutError) {
        const retryError = new LlmTimeoutError(error.message, { ...error.metadata, retryAttempt: 1 });
        await this.onTimeout?.(input.snapshot.project.id, retryError, 1);
        throw retryError;
      }
      throw error;
    }
  }

  private requestPlanJsonOnce(input: {
    snapshot: ResearchSnapshot;
    specification: ResearchSpecification;
    iteration: number;
    settings: AppSettings;
    availableTools: string[];
    continuationDecision?: ContinuationDecision;
  }, compact: boolean): Promise<PlanLlmResponse> {
    const latestContext = input.snapshot.projectContextSnapshots.at(-1);
    return this.llm!.completeJson<PlanLlmResponse>({
      schemaName: "AetherOpsResearchPlan",
      system: [
        "Create an executable research plan for one iteration.",
        "If previous continuation decision exists, incorporate its planRevisionHints before choosing tools.",
        "Do not claim unavailable sources were collected.",
        "Choose requiredTools only from the provided availableTools list. Return only JSON."
      ].join("\n"),
      user: compact ? [
        "The previous planning request timed out. Produce a compact executable plan.",
        `Specification summary: ${JSON.stringify({
          researchQuestions: input.specification.researchQuestions.slice(0, 5),
          refinedHypotheses: input.specification.refinedHypotheses.slice(0, 5),
          requiredEvidenceTypes: input.specification.requiredEvidenceTypes.slice(0, 6),
          evaluationMetrics: input.specification.evaluationMetrics.slice(0, 6)
        })}`,
        `Previous continuation decision: ${JSON.stringify({
          nextObjective: input.continuationDecision?.nextObjective,
          evidenceGaps: input.continuationDecision?.evidenceGaps?.slice(0, 8),
          planRevisionHints: input.continuationDecision?.planRevisionHints?.slice(0, 8),
          fetchCandidateUrls: input.continuationDecision?.fetchCandidateUrls?.slice(0, 8)
        })}`,
        `Latest ProjectContextSnapshot summary: ${JSON.stringify(latestContext ? {
          id: latestContext.id,
          iteration: latestContext.iteration,
          selectedRecordCount: latestContext.selectedRecordIds.length,
          selectedSourceCount: latestContext.selectedSourceIds.length,
          selectedEvidenceCount: latestContext.selectedEvidenceIds.length,
          citationCount: latestContext.citations.length,
          citations: latestContext.citations.slice(0, 8)
        } : undefined)}`,
        `Settings and executable tools: ${JSON.stringify({
          allowExternalSearch: input.settings.allowExternalSearch,
          allowCodeExecution: input.settings.allowCodeExecution,
          webSearchProvider: input.settings.webSearch.provider,
          openCodeEnabled: input.settings.openCode.enabled,
          availableTools: input.availableTools
        })}`,
        "Return keys: objective, targetQuestions, targetHypotheses, requiredTools, expectedSources, expectedArtifacts, executionSteps, stopCriteria, fetchCandidateUrls."
      ].join("\n\n") : [
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
        "Return keys: objective, targetQuestions, targetHypotheses, requiredTools, expectedSources, expectedArtifacts, executionSteps, stopCriteria, fetchCandidateUrls."
      ].join("\n\n"),
      timeoutMs: 120_000
    });
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
    const fetchCandidateUrls = input.continuationDecision?.fetchCandidateUrls ?? [];
    const hasPdfTargets = fetchCandidateUrls.some((url) => /\.pdf($|[?#])/i.test(url) || /arxiv\.org\/abs\//i.test(url));
    const hasFetchHint = fetchCandidateUrls.length > 0 || (input.continuationDecision?.planRevisionHints ?? []).some((hint) => /webfetchtool|fetch selected source urls/i.test(hint));
    const hasExternalUrls =
      input.snapshot.evidence.some((item) => typeof item.sourceUri === "string" && /^https?:\/\//i.test(item.sourceUri)) ||
      input.snapshot.sources.some((source) => typeof source.url === "string" && /^https?:\/\//i.test(source.url));
    const externalNetworkReady = input.settings.allowExternalSearch;
    const webSearchReady = input.settings.allowExternalSearch && input.settings.webSearch.provider !== "disabled";
    const candidateTools = [
      "OpenCodeTool",
      ...(webSearchReady ? ["WebSearchTool"] : []),
      ...(externalNetworkReady && (hasFetchHint || hasExternalUrls || available.has(normalizeToolName("WebSearchTool"))) ? ["WebFetchTool"] : []),
      ...(hasPdfTargets ? ["PdfIngestionTool"] : []),
      ...(input.settings.browserUse.enabled && input.settings.allowExternalSearch ? ["BackgroundBrowserTool"] : []),
      ...(input.settings.allowCodeExecution ? ["CodeExecutionTool"] : []),
      "ArtifactWriterTool",
      "DataAnalysisTool"
    ];
    const tools = orderToolNames(candidateTools.filter((tool) => tool === "OpenCodeTool" || available.has(normalizeToolName(tool))));
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
      fetchCandidateUrls,
      createdAt: nowIso()
    };
  }
}

function ensureHintTools(
  tools: string[],
  input: {
    availableTools: string[];
    continuationDecision?: ContinuationDecision;
    fetchCandidateUrls?: string[];
  }
): string[] {
  const available = new Set(input.availableTools.map(normalizeToolName));
  const needsFetch = Boolean(input.fetchCandidateUrls?.length) || (input.continuationDecision?.planRevisionHints ?? []).some((hint) => /webfetchtool|fetch selected source urls/i.test(hint));
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
