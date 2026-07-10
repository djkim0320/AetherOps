import { createId, nowIso } from "../shared/ids.js";
import { describeEngineeringProgramCapabilities, hasExecutableEngineeringTool } from "../tools/engineeringProgramTool.js";
import { LlmTimeoutError, type LlmProvider } from "../providers/llm.js";
import { buildRuntimeToolDiagnostics } from "../tools/runtimeToolDiagnostics.js";
import { orderToolNames } from "../tools/toolRunner.js";
import {
  ENGINEERING_PROGRAM_TOOL,
  clean,
  defaultCandidateTools,
  ensureHintTools,
  executableCandidateTools,
  filterResearchMetadataTool,
  hasExternalEvidenceOrSourceUrl,
  hasPdfFetchTarget,
  hasResearchMetadataIntent,
  hasWebFetchHint,
  normalizedToolSet,
  selectIdsOrText,
  strings,
  withFetchCandidateSources
} from "./plannerToolSelection.js";
import { collectIds, hasNormalizedTool, normalizeProgramRequests, readyProgramRequests } from "./engineeringRequestNormalizer.js";

export { filterResearchMetadataTool } from "./plannerToolSelection.js";
import type { AppSettings, ContinuationDecision, EngineeringProgramRequest, ResearchPlan, ResearchSnapshot, ResearchSpecification } from "../shared/types.js";

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
  programRequests?: EngineeringProgramRequest[];
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
    const expectedSourcesWithFetchCandidates = withFetchCandidateSources(expectedSources, fetchCandidateUrls);
    const runtimeToolDiagnostics = buildRuntimeToolDiagnostics(input.settings);
    const requiredTools = orderToolNames(
      ensureHintTools(filterResearchMetadataTool(strings(response.requiredTools, defaultPlan.requiredTools), input), { ...input, fetchCandidateUrls })
    );
    const programRequests = hasNormalizedTool(requiredTools, ENGINEERING_PROGRAM_TOOL)
      ? readyProgramRequests(normalizeProgramRequests(response.programRequests, []), runtimeToolDiagnostics)
      : undefined;
    if (programRequests && !programRequests.length) {
      throw new Error("EngineeringProgramTool was selected, but the LLM did not produce any ready programRequests.");
    }
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
      fetchCandidateUrls,
      programRequests
    };
  }

  private async requestPlanJson(
    input: {
      snapshot: ResearchSnapshot;
      specification: ResearchSpecification;
      iteration: number;
      settings: AppSettings;
      availableTools: string[];
      continuationDecision?: ContinuationDecision;
    },
    compact: boolean
  ): Promise<PlanLlmResponse> {
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

  private requestPlanJsonOnce(
    input: {
      snapshot: ResearchSnapshot;
      specification: ResearchSpecification;
      iteration: number;
      settings: AppSettings;
      availableTools: string[];
      continuationDecision?: ContinuationDecision;
    },
    compact: boolean
  ): Promise<PlanLlmResponse> {
    const latestContext = input.snapshot.projectContextSnapshots.at(-1);
    const runtimeToolDiagnostics = buildRuntimeToolDiagnostics(input.settings);
    return this.llm!.completeJson<PlanLlmResponse>({
      schemaName: "AetherOpsResearchPlan",
      system: [
        "Create an executable research plan for one iteration.",
        "If previous continuation decision exists, incorporate its planRevisionHints before choosing tools.",
        "Do not claim unavailable sources were collected.",
        "Choose requiredTools only from the provided availableTools list. Return only JSON."
      ].join("\n"),
      user: compact
        ? [
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
            `Latest ProjectContextSnapshot summary: ${JSON.stringify(
              latestContext
                ? {
                    id: latestContext.id,
                    iteration: latestContext.iteration,
                    selectedRecordCount: latestContext.selectedRecordIds.length,
                    selectedSourceCount: latestContext.selectedSourceIds.length,
                    selectedEvidenceCount: latestContext.selectedEvidenceIds.length,
                    citationCount: latestContext.citations.length,
                    citations: latestContext.citations.slice(0, 8)
                  }
                : undefined
            )}`,
            `Settings and executable tools: ${JSON.stringify({
              allowExternalSearch: input.settings.allowExternalSearch,
              allowCodeExecution: input.settings.allowCodeExecution,
              webSearchProvider: input.settings.webSearch.provider,
              researchMetadata: input.settings.researchMetadata,
              engineeringTools: {
                enabled: input.settings.engineeringTools.enabled,
                xfoilConfigured: Boolean(input.settings.engineeringTools.xfoil.enabled && input.settings.engineeringTools.xfoil.command?.trim()),
                xfoilWasmConfigured: Boolean(input.settings.engineeringTools.enabled),
                modelingConfigured: Boolean(input.settings.engineeringTools.modeling.enabled && input.settings.engineeringTools.modeling.artifactRoot?.trim()),
                su2Configured: Boolean(
                  input.settings.engineeringTools.su2.enabled &&
                  input.settings.engineeringTools.su2.command?.trim() &&
                  input.settings.engineeringTools.su2.caseRoot?.trim() &&
                  input.settings.engineeringTools.su2.configFile?.trim()
                ),
                openVspConfigured: Boolean(input.settings.engineeringTools.openVsp.enabled && input.settings.engineeringTools.openVsp.command?.trim()),
                xflr5Configured: Boolean(input.settings.engineeringTools.xflr5.enabled && input.settings.engineeringTools.xflr5.command?.trim()),
                su2: input.settings.engineeringTools.su2,
                openVsp: input.settings.engineeringTools.openVsp,
                xflr5: input.settings.engineeringTools.xflr5,
                capabilities: describeEngineeringProgramCapabilities(input.settings)
              },
              runtimeToolDiagnostics,
              openCodeEnabled: input.settings.openCode.enabled,
              availableTools: input.availableTools
            })}`,
            "Select ResearchMetadataTool only when the specification explicitly needs scholarly paper, literature, DOI, or citation metadata. Do not use it as a prerequisite for engineering program execution or airfoil/CFD coordinate fetching.",
            "If computed aerodynamic/CFD evidence is needed, select EngineeringProgramTool only from runtimeToolDiagnostics.engineeringProgramRequestTemplates with ready=true. Allowed solver targets are xfoil, xfoil-wasm, su2, openvsp, and xflr5 only. Copy template kind and target. Fill cfdRunSpec with geometry, mesh, solver, and flightCondition values; do not emit command, args, scriptPath, caseRoot, configFile, workingDirectory, or runArgsTemplate. Artifact paths inside artifactPath, cfdRunSpec.geometry.artifactPath, and cfdRunSpec.mesh.artifactPath must exactly match ready runtimeToolDiagnostics.engineeringArtifactCandidates; otherwise use configuredCase, a valid NACA code, a public sourceUrl for xfoil-wasm only, or omit EngineeringProgramTool and record the evidence gap. Do not request any engineering program kind or target outside the ready template list.",
            "Return keys: objective, targetQuestions, targetHypotheses, requiredTools, expectedSources, expectedArtifacts, executionSteps, stopCriteria, fetchCandidateUrls, programRequests."
          ].join("\n\n")
        : [
            `Specification: ${JSON.stringify(input.specification)}`,
            `Previous validation: ${JSON.stringify(input.snapshot.validationResults.slice(-8))}`,
            `Previous continuation decision: ${JSON.stringify(input.continuationDecision)}`,
            `Settings and executable tools: ${JSON.stringify({
              allowExternalSearch: input.settings.allowExternalSearch,
              allowCodeExecution: input.settings.allowCodeExecution,
              webSearchProvider: input.settings.webSearch.provider,
              researchMetadata: input.settings.researchMetadata,
              engineeringTools: {
                enabled: input.settings.engineeringTools.enabled,
                xfoilConfigured: Boolean(input.settings.engineeringTools.xfoil.enabled && input.settings.engineeringTools.xfoil.command?.trim()),
                xfoilWasmConfigured: Boolean(input.settings.engineeringTools.enabled),
                modelingConfigured: Boolean(input.settings.engineeringTools.modeling.enabled && input.settings.engineeringTools.modeling.artifactRoot?.trim()),
                su2Configured: Boolean(
                  input.settings.engineeringTools.su2.enabled &&
                  input.settings.engineeringTools.su2.command?.trim() &&
                  input.settings.engineeringTools.su2.caseRoot?.trim() &&
                  input.settings.engineeringTools.su2.configFile?.trim()
                ),
                openVspConfigured: Boolean(input.settings.engineeringTools.openVsp.enabled && input.settings.engineeringTools.openVsp.command?.trim()),
                xflr5Configured: Boolean(input.settings.engineeringTools.xflr5.enabled && input.settings.engineeringTools.xflr5.command?.trim()),
                su2: input.settings.engineeringTools.su2,
                openVsp: input.settings.engineeringTools.openVsp,
                xflr5: input.settings.engineeringTools.xflr5,
                capabilities: describeEngineeringProgramCapabilities(input.settings)
              },
              runtimeToolDiagnostics,
              openCodeEnabled: input.settings.openCode.enabled,
              availableTools: input.availableTools
            })}`,
            "Select ResearchMetadataTool only when the specification explicitly needs scholarly paper, literature, DOI, or citation metadata. Do not use it as a prerequisite for engineering program execution or airfoil/CFD coordinate fetching.",
            "If computed aerodynamic/CFD evidence is needed, select EngineeringProgramTool only from runtimeToolDiagnostics.engineeringProgramRequestTemplates with ready=true. Allowed solver targets are xfoil, xfoil-wasm, su2, openvsp, and xflr5 only. Copy template kind and target. Fill cfdRunSpec with geometry, mesh, solver, and flightCondition values; do not emit command, args, scriptPath, caseRoot, configFile, workingDirectory, or runArgsTemplate. Artifact paths inside artifactPath, cfdRunSpec.geometry.artifactPath, and cfdRunSpec.mesh.artifactPath must exactly match ready runtimeToolDiagnostics.engineeringArtifactCandidates; otherwise use configuredCase, a valid NACA code, a public sourceUrl for xfoil-wasm only, or omit EngineeringProgramTool and record the evidence gap. Do not request any engineering program kind or target outside the ready template list.",
            "Return keys: objective, targetQuestions, targetHypotheses, requiredTools, expectedSources, expectedArtifacts, executionSteps, stopCriteria, fetchCandidateUrls, programRequests."
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
    const available = normalizedToolSet(input.availableTools);
    const fetchCandidateUrls = input.continuationDecision?.fetchCandidateUrls ?? [];
    const hasPdfTargets = hasPdfFetchTarget(fetchCandidateUrls);
    const hasFetchHint = fetchCandidateUrls.length > 0 || hasWebFetchHint(input.continuationDecision?.planRevisionHints);
    const hasExternalUrls = hasExternalEvidenceOrSourceUrl(input.snapshot);
    const externalNetworkReady = input.settings.allowExternalSearch;
    const webSearchReady = input.settings.allowExternalSearch && input.settings.webSearch.provider !== "disabled";
    const candidateTools = defaultCandidateTools(input.settings, {
      available,
      externalNetworkReady,
      hasExternalUrls,
      hasFetchHint,
      hasPdfTargets,
      researchMetadataReady: input.settings.allowExternalSearch && input.settings.researchMetadata.enabled,
      researchMetadataRelevant: hasResearchMetadataIntent(input),
      engineeringProgramReady: input.settings.allowCodeExecution && hasExecutableEngineeringTool(input.settings),
      webSearchReady
    });
    const tools = orderToolNames(executableCandidateTools(candidateTools, available));
    const nextObjective = input.continuationDecision?.nextObjective;
    return {
      id: createId("plan"),
      projectId: input.snapshot.project.id,
      iteration: input.iteration,
      objective:
        nextObjective ||
        `Iteration ${input.iteration}: collect traceable evidence, normalize it, index it, and evaluate priority hypotheses for ${input.snapshot.project.topic}.`,
      targetQuestions: collectIds(input.snapshot.questions),
      targetHypotheses: collectIds(input.snapshot.hypotheses),
      requiredTools: tools,
      expectedSources: input.specification.requiredEvidenceTypes.length
        ? input.specification.requiredEvidenceTypes
        : ["raw source", "artifact", "tool log", "citation"],
      expectedArtifacts: [`artifacts/iteration-${input.iteration}/research-note.md`, `logs/iteration-${input.iteration}.json`],
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
