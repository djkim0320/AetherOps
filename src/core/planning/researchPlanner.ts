import { createId, nowIso } from "../shared/ids.js";
import { describeEngineeringProgramCapabilities } from "../tools/engineeringProgramTool.js";
import { completeValidatedJson, invocationMetadataFromError, LlmTimeoutError, type LlmInvocationMetadata, type LlmProvider } from "../providers/llm.js";
import { buildRuntimeToolDiagnostics } from "../tools/runtimeToolDiagnostics.js";
import { orderToolNames } from "../tools/toolRunner.js";
import { ENGINEERING_PROGRAM_TOOL, withFetchCandidateSources } from "./plannerToolSelection.js";
import { collectIds, hasNormalizedTool, normalizeProgramRequests, readyProgramRequests } from "./engineeringRequestNormalizer.js";
import { plannerToolDescriptors, type ToolDescriptor } from "../tools/toolDescriptors.js";
import { createResearchPlanLlmOutputSchema, type PlannerToolIntent, type ResearchPlanLlmOutput } from "./researchPlanSchema.js";
import type { CapabilityPolicy } from "../domain/capabilities/types.js";
import type { ToolExecutionContext } from "../tools/researchToolTypes.js";
import { detectExplicitEngineeringTarget, requestMatchesExplicitTarget } from "./explicitEngineeringTargetPolicy.js";

import type { AppSettings, ContinuationDecision, ResearchPlan, ResearchSnapshot, ResearchSpecification, RuntimeToolDiagnostics } from "../shared/types.js";

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
    toolPolicy?: ToolExecutionContext["toolPolicy"];
    effectiveCapabilities?: CapabilityPolicy;
    runtimeToolDiagnostics?: RuntimeToolDiagnostics;
    onLlmInvocation?: (metadata: LlmInvocationMetadata) => void | Promise<void>;
  }): Promise<ResearchPlan> {
    const defaultPlan = this.buildDefaultPlan(input);
    if (!this.llm || !(await this.llm.isAvailable())) {
      throw new Error("LLM provider is required to create a research plan.");
    }

    const descriptors = this.selectPlannerDescriptors(input);
    if (!descriptors.length) throw new Error("No policy-allowed tools are available to the research planner.");
    const response = await this.requestPlanJson(input, false, descriptors);

    const fetchCandidateUrls = response.fetchCandidateUrls;
    const expectedSources = response.expectedSources;
    const expectedSourcesWithFetchCandidates = withFetchCandidateSources(expectedSources, fetchCandidateUrls);
    const runtimeToolDiagnostics = input.runtimeToolDiagnostics ?? buildRuntimeToolDiagnostics(input.settings);
    const requiredTools = orderToolNames(response.toolRequests.map((request) => request.toolName));
    const rawProgramRequests = programRequestsFromToolIntents(response.toolRequests);
    const normalizedProgramRequests = normalizeProgramRequests(rawProgramRequests, []);
    const explicitEngineeringTarget = detectExplicitEngineeringTarget(input.snapshot.project);
    if (explicitEngineeringTarget && normalizedProgramRequests.some((request) => !requestMatchesExplicitTarget(request, explicitEngineeringTarget))) {
      throw new Error(`Explicit engineering target ${explicitEngineeringTarget} cannot be replaced by another solver or target=all.`);
    }
    const programRequests = hasNormalizedTool(requiredTools, ENGINEERING_PROGRAM_TOOL)
      ? readyProgramRequests(normalizedProgramRequests, runtimeToolDiagnostics)
      : undefined;
    if (programRequests && !programRequests.length) {
      throw new Error(
        explicitEngineeringTarget
          ? `Explicit engineering target ${explicitEngineeringTarget} is unavailable or not ready; solver fallback is forbidden.`
          : "EngineeringProgramTool was selected, but the LLM did not produce any ready programRequests."
      );
    }
    return {
      ...defaultPlan,
      objective: response.objective,
      targetQuestions: response.targetQuestions,
      targetHypotheses: response.targetHypotheses,
      requiredTools,
      toolRequests: response.toolRequests,
      expectedSources: expectedSourcesWithFetchCandidates,
      expectedArtifacts: response.expectedArtifacts,
      executionSteps: response.executionSteps,
      steps: response.executionSteps,
      stopCriteria: response.stopCriteria,
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
      toolPolicy?: ToolExecutionContext["toolPolicy"];
      effectiveCapabilities?: CapabilityPolicy;
      runtimeToolDiagnostics?: RuntimeToolDiagnostics;
      onLlmInvocation?: (metadata: LlmInvocationMetadata) => void | Promise<void>;
    },
    compact: boolean,
    descriptors: ToolDescriptor[]
  ): Promise<ResearchPlanLlmOutput> {
    try {
      return await this.requestPlanJsonOnce(input, compact, descriptors);
    } catch (error) {
      if (!compact && error instanceof LlmTimeoutError) {
        await this.onTimeout?.(input.snapshot.project.id, error, 0);
        return this.requestPlanJson(input, true, descriptors);
      }
      if (compact && error instanceof LlmTimeoutError) {
        const retryError = new LlmTimeoutError(error.message, { ...error.metadata, retryAttempt: 1 });
        await this.onTimeout?.(input.snapshot.project.id, retryError, 1);
        throw retryError;
      }
      throw error;
    }
  }

  private async requestPlanJsonOnce(
    input: {
      snapshot: ResearchSnapshot;
      specification: ResearchSpecification;
      iteration: number;
      settings: AppSettings;
      availableTools: string[];
      continuationDecision?: ContinuationDecision;
      toolPolicy?: ToolExecutionContext["toolPolicy"];
      effectiveCapabilities?: CapabilityPolicy;
      runtimeToolDiagnostics?: RuntimeToolDiagnostics;
      onLlmInvocation?: (metadata: LlmInvocationMetadata) => void | Promise<void>;
    },
    compact: boolean,
    descriptors: ToolDescriptor[]
  ): Promise<ResearchPlanLlmOutput> {
    const latestContext = input.snapshot.projectContextSnapshots.at(-1);
    const runtimeToolDiagnostics = input.runtimeToolDiagnostics ?? buildRuntimeToolDiagnostics(input.settings);
    const explicitEngineeringTarget = detectExplicitEngineeringTarget(input.snapshot.project);
    const schema = createResearchPlanLlmOutputSchema(
      descriptors,
      input.toolPolicy?.sourceAccess,
      explicitEngineeringTarget,
      requiredToolsForExplicitResources(descriptors, input.toolPolicy?.sourceAccess)
    );
    let completion;
    try {
      completion = await completeValidatedJson(this.llm!, {
        schemaName: "AetherOpsResearchPlan",
        promptVersion: "research-plan-v2",
        schemaVersion: "research-plan-strict-v1",
        schema,
        system: [
          "Create an executable research plan for one iteration.",
          "If previous continuation decision exists, incorporate its planRevisionHints before choosing tools.",
          "Do not claim unavailable sources were collected.",
          "Choose toolRequests only from the provided toolDescriptors list.",
          "Every tool request needs a unique intentId, purpose, expectedOutcome, and schema-valid inputs.",
          "Every required enum and string field must contain a concrete allowed value; never put null in a required tool input.",
          "Do not add substitute tools or change an explicitly requested engineering solver.",
          explicitEngineeringTarget
            ? `The user explicitly pinned engineering target ${explicitEngineeringTarget}. Reject every other target, including target=all.`
            : "No single engineering target was inferred from the user's goal.",
          "When the specification supplies a PDF URL and both descriptors are available, request WebFetchTool followed by PdfIngestionTool; fetching the URL does not replace PDF ingestion.",
          "Return only JSON."
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
                  enabled: input.settings.allowCodeExecution,
                  externalToolsEnabled: input.settings.engineeringTools.enabled,
                  xfoilConfigured: Boolean(input.settings.engineeringTools.xfoil.enabled && input.settings.engineeringTools.xfoil.command?.trim()),
                  xfoilWasmConfigured: Boolean(input.settings.allowCodeExecution),
                  modelingConfigured: Boolean(
                    input.settings.engineeringTools.modeling.enabled && input.settings.engineeringTools.modeling.artifactRoot?.trim()
                  ),
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
                codexCliEnabled: input.toolPolicy?.allowCodexCli === true,
                toolDescriptors: plannerDescriptorPromptRows(descriptors)
              })}`,
              "Select ResearchMetadataTool only when the specification explicitly needs scholarly paper, literature, DOI, or citation metadata. Do not use it as a prerequisite for engineering program execution or airfoil/CFD coordinate fetching.",
              "If computed aerodynamic/CFD evidence is needed, select EngineeringProgramTool only from runtimeToolDiagnostics.engineeringProgramRequestTemplates with ready=true. Allowed solver targets are xfoil, xfoil-wasm, su2, openvsp, and xflr5 only. Copy template kind and target. Fill cfdRunSpec with geometry, mesh, solver, and flightCondition values; do not emit command, args, scriptPath, caseRoot, configFile, workingDirectory, or runArgsTemplate. Artifact paths inside artifactPath, cfdRunSpec.geometry.artifactPath, and cfdRunSpec.mesh.artifactPath must exactly match ready runtimeToolDiagnostics.engineeringArtifactCandidates; otherwise use configuredCase, a valid NACA code, a public sourceUrl for xfoil-wasm only, or omit EngineeringProgramTool and record the evidence gap. Do not request any engineering program kind or target outside the ready template list.",
              plannerResponseContract()
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
                  enabled: input.settings.allowCodeExecution,
                  externalToolsEnabled: input.settings.engineeringTools.enabled,
                  xfoilConfigured: Boolean(input.settings.engineeringTools.xfoil.enabled && input.settings.engineeringTools.xfoil.command?.trim()),
                  xfoilWasmConfigured: Boolean(input.settings.allowCodeExecution),
                  modelingConfigured: Boolean(
                    input.settings.engineeringTools.modeling.enabled && input.settings.engineeringTools.modeling.artifactRoot?.trim()
                  ),
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
                codexCliEnabled: input.toolPolicy?.allowCodexCli === true,
                toolDescriptors: plannerDescriptorPromptRows(descriptors)
              })}`,
              "Select ResearchMetadataTool only when the specification explicitly needs scholarly paper, literature, DOI, or citation metadata. Do not use it as a prerequisite for engineering program execution or airfoil/CFD coordinate fetching.",
              "If computed aerodynamic/CFD evidence is needed, select EngineeringProgramTool only from runtimeToolDiagnostics.engineeringProgramRequestTemplates with ready=true. Allowed solver targets are xfoil, xfoil-wasm, su2, openvsp, and xflr5 only. Copy template kind and target. Fill cfdRunSpec with geometry, mesh, solver, and flightCondition values; do not emit command, args, scriptPath, caseRoot, configFile, workingDirectory, or runArgsTemplate. Artifact paths inside artifactPath, cfdRunSpec.geometry.artifactPath, and cfdRunSpec.mesh.artifactPath must exactly match ready runtimeToolDiagnostics.engineeringArtifactCandidates; otherwise use configuredCase, a valid NACA code, a public sourceUrl for xfoil-wasm only, or omit EngineeringProgramTool and record the evidence gap. Do not request any engineering program kind or target outside the ready template list.",
              plannerResponseContract()
            ].join("\n\n"),
        timeoutMs: 120_000
      });
    } catch (error) {
      const metadata = invocationMetadataFromError(error);
      if (metadata) await input.onLlmInvocation?.(metadata);
      throw error;
    }
    await input.onLlmInvocation?.(completion.metadata);
    return completion.value;
  }

  private buildDefaultPlan(input: {
    snapshot: ResearchSnapshot;
    specification: ResearchSpecification;
    iteration: number;
    settings: AppSettings;
    availableTools: string[];
    continuationDecision?: ContinuationDecision;
    toolPolicy?: ToolExecutionContext["toolPolicy"];
    effectiveCapabilities?: CapabilityPolicy;
    onLlmInvocation?: (metadata: LlmInvocationMetadata) => void | Promise<void>;
  }): ResearchPlan {
    const fetchCandidateUrls = input.continuationDecision?.fetchCandidateUrls ?? [];
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
      requiredTools: [],
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

  private selectPlannerDescriptors(input: {
    snapshot: ResearchSnapshot;
    specification: ResearchSpecification;
    availableTools: string[];
    continuationDecision?: ContinuationDecision;
    toolPolicy?: ToolExecutionContext["toolPolicy"];
    effectiveCapabilities?: CapabilityPolicy;
  }): ToolDescriptor[] {
    return plannerToolDescriptors(input.availableTools, { allowCodexCli: input.toolPolicy?.allowCodexCli === true }).filter(
      (descriptor) =>
        descriptor.requiredCapabilities.every((capability) => input.effectiveCapabilities?.[capability] !== false) &&
        !(input.toolPolicy?.sourceAccess?.mode === "offline" && descriptor.sideEffects.includes("network")) &&
        !(input.toolPolicy?.sourceAccess?.mode === "allowlist" && (descriptor.name === "WebSearchTool" || descriptor.name === "ResearchMetadataTool"))
    );
  }
}

function programRequestsFromToolIntents(intents: PlannerToolIntent[]): unknown {
  for (const intent of intents) {
    if (intent.toolName.replace(/\s+/g, "").toLowerCase() !== ENGINEERING_PROGRAM_TOOL) continue;
    return intent.inputs.programRequests;
  }
  return undefined;
}

function plannerDescriptorPromptRows(descriptors: ToolDescriptor[]): Array<Record<string, unknown>> {
  return descriptors.map((descriptor) => ({
    name: descriptor.name,
    version: descriptor.version,
    phase: descriptor.phase,
    requiredCapabilities: descriptor.requiredCapabilities,
    dependencies: descriptor.dependencies,
    repeatable: descriptor.repeatable,
    description: descriptor.description,
    inputContract: inputContract(descriptor.name)
  }));
}

function requiredToolsForExplicitResources(
  descriptors: ToolDescriptor[],
  sourcePolicy?: NonNullable<ToolExecutionContext["toolPolicy"]>["sourceAccess"]
): string[] {
  if (sourcePolicy?.mode !== "allowlist" || !sourcePolicy.urls.some(isPdfResourceUrl)) return [];
  const available = new Set(descriptors.map((descriptor) => descriptor.name));
  return ["WebFetchTool", "PdfIngestionTool"].filter((toolName) => available.has(toolName));
}

function isPdfResourceUrl(value: string): boolean {
  try {
    const path = new URL(value).pathname.toLowerCase();
    return path.endsWith(".pdf") || path.includes("/pdf/");
  } catch {
    return false;
  }
}

function inputContract(toolName: string): string {
  const contracts: Record<string, string> = {
    WebSearchTool: "{ query: non-empty string }",
    BackgroundBrowserTool: "{ query?: non-empty string, urls?: 1-8 HTTP(S) URLs }; at least one is required",
    WebFetchTool: "{ urls: 1-8 HTTP(S) URLs }",
    ResearchMetadataTool: "{ query: non-empty string }",
    PdfIngestionTool: "{ urls: 1-8 HTTP(S) URLs }",
    EngineeringProgramTool:
      '{ programRequests: 1-4 objects }; each requires kind and a matching target; WebXFOIL uses kind="xfoil-wasm-polar", target="xfoil-wasm", coordinateBindingId after fetch, and numeric reynolds/mach/alphaStart/alphaEnd/alphaStep',
    CodexCliTool:
      '{ task: non-empty string, inputArtifactIds: 0-32 promoted artifact IDs, outputs: 1-8 { relativePath, kind } }; kind must be exactly "code", "report", or "data"',
    DataAnalysisTool:
      '{ checks: 1-6 unique values from "source_scope", "evidence_coverage", "question_coverage", "hypothesis_coverage", "engineering_fidelity", "artifact_completeness" }',
    ArtifactWriterTool:
      '{ artifacts: 1-8 { relativePath, kind, format } }; format must be exactly "markdown" or "json" and match .md/.json; kind must be one of "research_report", "evidence_index", "hypothesis_assessment", "plan_revision_hints", "source_inventory", "engineering_result"'
  };
  return contracts[toolName] ?? "JSON object accepted by the registered custom tool";
}

function plannerResponseContract(): string {
  return [
    "Return keys: objective, targetQuestions, targetHypotheses, toolRequests, expectedSources, expectedArtifacts, executionSteps, stopCriteria, fetchCandidateUrls.",
    "toolRequests is required and non-empty. EngineeringProgramTool inputs must contain programRequests; do not return a top-level programRequests key."
  ].join(" ");
}
