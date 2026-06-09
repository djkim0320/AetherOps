import { createId, nowIso } from "../shared/ids.js";
import { describeEngineeringProgramCapabilities, hasExecutableEngineeringTool } from "../tools/engineeringProgramTool.js";
import { LlmTimeoutError, type LlmProvider } from "../providers/llm.js";
import { buildRuntimeToolDiagnostics } from "../tools/runtimeToolDiagnostics.js";
import { normalizeToolName, orderToolNames } from "../tools/toolRunner.js";
import type {
  AppSettings,
  CfdRunSpec,
  ContinuationDecision,
  EngineeringProgramRequest,
  ResearchPlan,
  ResearchSnapshot,
  ResearchSpecification,
  RuntimeToolDiagnostics
} from "../shared/types.js";

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

const WEB_SEARCH_TOOL = normalizeToolName("WebSearchTool");
const WEB_FETCH_TOOL = normalizeToolName("WebFetchTool");
const OPEN_CODE_TOOL = normalizeToolName("OpenCodeTool");
const ENGINEERING_PROGRAM_TOOL = normalizeToolName("EngineeringProgramTool");
const RESEARCH_METADATA_TOOL = normalizeToolName("ResearchMetadataTool");
const PDF_URL_PATTERN = /\.pdf($|[?#])/i;
const ARXIV_ABS_URL_PATTERN = /arxiv\.org\/abs\//i;
const HTTP_URL_PATTERN = /^https?:\/\//i;
const WEB_FETCH_HINT_PATTERN = /webfetchtool|fetch selected source urls/i;
const RESEARCH_METADATA_INTENT_PATTERN =
  /\b(openalex|research metadata|paper metadata|scholarly metadata|citation metadata|literature review|systematic review|related work|scholarly|peer[-\s]?reviewed|academic paper|journal article|conference paper|publication|publications|doi|bibliograph|arxiv|pubmed|semantic scholar)\b/i;

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
    let requiredTools = orderToolNames(ensureHintTools(
      filterResearchMetadataTool(strings(response.requiredTools, defaultPlan.requiredTools), input),
      { ...input, fetchCandidateUrls }
    ));
    let programRequests = hasNormalizedTool(requiredTools, ENGINEERING_PROGRAM_TOOL)
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
    const runtimeToolDiagnostics = buildRuntimeToolDiagnostics(input.settings);
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
          researchMetadata: input.settings.researchMetadata,
          engineeringTools: {
            enabled: input.settings.engineeringTools.enabled,
            xfoilConfigured: Boolean(input.settings.engineeringTools.xfoil.enabled && input.settings.engineeringTools.xfoil.command?.trim()),
            xfoilWasmConfigured: Boolean(input.settings.engineeringTools.enabled),
            modelingConfigured: Boolean(input.settings.engineeringTools.modeling.enabled && input.settings.engineeringTools.modeling.artifactRoot?.trim()),
            su2Configured: Boolean(input.settings.engineeringTools.su2.enabled && input.settings.engineeringTools.su2.command?.trim() && input.settings.engineeringTools.su2.caseRoot?.trim() && input.settings.engineeringTools.su2.configFile?.trim()),
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
      ].join("\n\n") : [
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
            su2Configured: Boolean(input.settings.engineeringTools.su2.enabled && input.settings.engineeringTools.su2.command?.trim() && input.settings.engineeringTools.su2.caseRoot?.trim() && input.settings.engineeringTools.su2.configFile?.trim()),
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
  const available = normalizedToolSet(input.availableTools);
  const needsFetch = Boolean(input.fetchCandidateUrls?.length) || hasWebFetchHint(input.continuationDecision?.planRevisionHints);
  const result = copyStrings(tools);
  if (needsFetch && available.has(WEB_FETCH_TOOL) && !hasNormalizedTool(result, WEB_FETCH_TOOL)) {
    result.push("WebFetchTool");
  }
  return result;
}

export function filterResearchMetadataTool(
  tools: string[],
  input: {
    snapshot: ResearchSnapshot;
    specification: ResearchSpecification;
    continuationDecision?: ContinuationDecision;
  }
): string[] {
  if (hasResearchMetadataIntent(input)) return tools;
  return tools.filter((tool) => normalizeToolName(tool) !== RESEARCH_METADATA_TOOL);
}

function clean(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function strings(value: unknown, defaultValue: string[]): string[] {
  if (!Array.isArray(value)) return defaultValue;
  const normalized: string[] = [];
  for (const item of value) {
    const cleaned = clean(item);
    if (!cleaned) continue;
    normalized.push(cleaned);
    if (normalized.length >= 12) break;
  }
  return normalized.length ? normalized : defaultValue;
}

function selectIdsOrText(value: unknown, defaultValue: string[]): string[] {
  return strings(value, defaultValue);
}

function withFetchCandidateSources(expectedSources: string[], fetchCandidateUrls: string[]): string[] {
  if (!fetchCandidateUrls.length) return expectedSources;
  const output: string[] = [];
  const seen = new Set<string>();
  for (const source of expectedSources) pushUnique(output, seen, source);
  for (const url of fetchCandidateUrls) pushUnique(output, seen, `Fetch candidate URL: ${url}`);
  return output;
}

function pushUnique(output: string[], seen: Set<string>, value: string): void {
  if (seen.has(value)) return;
  seen.add(value);
  output.push(value);
}

function normalizedToolSet(tools: string[]): Set<string> {
  const normalized = new Set<string>();
  for (const tool of tools) {
    const name = normalizeToolName(tool);
    if (name) normalized.add(name);
  }
  return normalized;
}

function hasPdfFetchTarget(urls: string[]): boolean {
  for (const url of urls) {
    if (PDF_URL_PATTERN.test(url) || ARXIV_ABS_URL_PATTERN.test(url)) return true;
  }
  return false;
}

function hasWebFetchHint(hints: string[] | undefined): boolean {
  for (const hint of hints ?? []) {
    if (WEB_FETCH_HINT_PATTERN.test(hint)) return true;
  }
  return false;
}

function hasExternalEvidenceOrSourceUrl(snapshot: ResearchSnapshot): boolean {
  for (const item of snapshot.evidence) {
    if (typeof item.sourceUri === "string" && HTTP_URL_PATTERN.test(item.sourceUri)) return true;
  }
  for (const source of snapshot.sources) {
    if (typeof source.url === "string" && HTTP_URL_PATTERN.test(source.url)) return true;
  }
  return false;
}

function defaultCandidateTools(
  settings: AppSettings,
  state: {
    available: Set<string>;
    externalNetworkReady: boolean;
    hasExternalUrls: boolean;
    hasFetchHint: boolean;
    hasPdfTargets: boolean;
    researchMetadataReady: boolean;
    researchMetadataRelevant: boolean;
    engineeringProgramReady: boolean;
    webSearchReady: boolean;
  }
): string[] {
  const tools: string[] = [];
  if (settings.openCode.enabled && settings.openCode.command?.trim() && state.available.has(OPEN_CODE_TOOL)) tools.push("OpenCodeTool");
  if (state.webSearchReady) tools.push("WebSearchTool");
  if (state.researchMetadataReady && state.researchMetadataRelevant) tools.push("ResearchMetadataTool");
  if (state.externalNetworkReady && (state.hasFetchHint || state.hasExternalUrls || state.available.has(WEB_SEARCH_TOOL))) {
    tools.push("WebFetchTool");
  }
  if (state.hasPdfTargets) tools.push("PdfIngestionTool");
  if (settings.browserUse.enabled && settings.allowExternalSearch) tools.push("BackgroundBrowserTool");
  if (settings.allowCodeExecution) tools.push("CodeExecutionTool");
  if (state.engineeringProgramReady) tools.push("EngineeringProgramTool");
  tools.push("ArtifactWriterTool", "DataAnalysisTool");
  return tools;
}

export function hasResearchMetadataIntent(input: {
  snapshot: ResearchSnapshot;
  specification: ResearchSpecification;
  continuationDecision?: ContinuationDecision;
}): boolean {
  const parts: string[] = [
    input.snapshot.project.topic,
    input.snapshot.project.goal,
    input.snapshot.project.scope,
    input.specification.scope,
    ...input.snapshot.questions.map((question) => question.text),
    ...input.snapshot.hypotheses.map((hypothesis) => hypothesis.statement),
    ...input.snapshot.researchInputs.map((researchInput) => researchInput.researchQuestion),
    ...input.specification.researchQuestions,
    ...input.specification.initialHypotheses,
    ...input.specification.refinedHypotheses,
    ...input.specification.assumptions,
    ...input.specification.constraints,
    ...input.specification.successCriteria,
    ...input.specification.requiredEvidenceTypes,
    ...input.specification.competencyQuestions,
    ...input.specification.evaluationMetrics,
    input.continuationDecision?.nextObjective ?? "",
    ...(input.continuationDecision?.nextQuestions ?? []),
    ...(input.continuationDecision?.evidenceGaps ?? []),
    ...(input.continuationDecision?.planRevisionHints ?? [])
  ];
  return RESEARCH_METADATA_INTENT_PATTERN.test(parts.filter(Boolean).join("\n"));
}

function executableCandidateTools(candidateTools: string[], available: Set<string>): string[] {
  const tools: string[] = [];
  for (const tool of candidateTools) {
    if (tool === "OpenCodeTool" || available.has(normalizeToolName(tool))) tools.push(tool);
  }
  return tools;
}

function normalizeProgramRequests(value: unknown, defaultValue: EngineeringProgramRequest[]): EngineeringProgramRequest[] {
  if (!Array.isArray(value)) return defaultValue;
  const requests: EngineeringProgramRequest[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const request = item as Partial<EngineeringProgramRequest>;
    if (
      request.kind !== "toolchain-check" &&
      request.kind !== "mesh-inspect" &&
      request.kind !== "xfoil-polar" &&
      request.kind !== "xfoil-wasm-polar" &&
      request.kind !== "su2-case-run" &&
      request.kind !== "openvsp-analysis-run" &&
      request.kind !== "xflr5-analysis-run"
    ) continue;
    const normalized: EngineeringProgramRequest = { kind: request.kind };
    if (
      request.target === "all" ||
      request.target === "xfoil" ||
      request.target === "xfoil-wasm" ||
      request.target === "modeling" ||
      request.target === "su2" ||
      request.target === "openvsp" ||
      request.target === "xflr5"
    ) {
      normalized.target = request.target;
    }
    const cfdRunSpec = normalizeCfdRunSpec(request.cfdRunSpec);
    if (cfdRunSpec) normalized.cfdRunSpec = cfdRunSpec;
    if (typeof request.artifactPath === "string" && request.artifactPath.trim()) {
      normalized.artifactPath = request.artifactPath.trim();
    }
    if (typeof request.sourceUrl === "string" && /^https?:\/\//i.test(request.sourceUrl.trim())) {
      normalized.sourceUrl = request.sourceUrl.trim();
    }
    if (typeof request.outputFileName === "string" && request.outputFileName.trim()) {
      normalized.outputFileName = request.outputFileName.trim();
    }
    if (typeof request.naca === "string" && request.naca.trim()) {
      normalized.naca = request.naca.trim();
    }
    if (typeof request.reynolds === "number" && Number.isFinite(request.reynolds)) normalized.reynolds = request.reynolds;
    if (typeof request.mach === "number" && Number.isFinite(request.mach)) normalized.mach = request.mach;
    if (typeof request.alphaStart === "number" && Number.isFinite(request.alphaStart)) normalized.alphaStart = request.alphaStart;
    if (typeof request.alphaEnd === "number" && Number.isFinite(request.alphaEnd)) normalized.alphaEnd = request.alphaEnd;
    if (typeof request.alphaStep === "number" && Number.isFinite(request.alphaStep)) normalized.alphaStep = request.alphaStep;
    if (typeof request.reason === "string" && request.reason.trim()) {
      normalized.reason = request.reason.trim();
    }
    requests.push(normalized);
    if (requests.length >= 4) break;
  }
  return requests.length ? requests : defaultValue;
}

function normalizeCfdRunSpec(value: unknown): CfdRunSpec | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Partial<CfdRunSpec>;
  const geometry = record.geometry && typeof record.geometry === "object" ? record.geometry : undefined;
  const solver = record.solver && typeof record.solver === "object" ? record.solver : undefined;
  if (!geometry || !solver) return undefined;
  if (record.target !== "xfoil" && record.target !== "xfoil-wasm" && record.target !== "su2" && record.target !== "openvsp" && record.target !== "xflr5") return undefined;
  if (geometry.source !== "artifact" && geometry.source !== "sourceUrl" && geometry.source !== "naca" && geometry.source !== "configuredCase") return undefined;
  if (solver.name !== "xfoil" && solver.name !== "webxfoil-wasm" && solver.name !== "su2" && solver.name !== "openvsp-vspaero" && solver.name !== "xflr5") return undefined;
  const flight = record.flightCondition && typeof record.flightCondition === "object" ? record.flightCondition : {};
  const spec: CfdRunSpec = {
    target: record.target,
    geometry: {
      source: geometry.source,
      artifactPath: clean(geometry.artifactPath),
      sourceUrl: clean(geometry.sourceUrl),
      naca: clean(geometry.naca),
      description: clean(geometry.description)
    },
    flightCondition: {
      reynolds: finiteNumberValue(flight.reynolds),
      mach: finiteNumberValue(flight.mach),
      alphaStart: finiteNumberValue(flight.alphaStart),
      alphaEnd: finiteNumberValue(flight.alphaEnd),
      alphaStep: finiteNumberValue(flight.alphaStep),
      velocity: finiteNumberValue(flight.velocity),
      density: finiteNumberValue(flight.density),
      viscosity: finiteNumberValue(flight.viscosity)
    },
    solver: {
      name: solver.name,
      model:
        solver.model === "inviscid" || solver.model === "euler" || solver.model === "rans" || solver.model === "panel" || solver.model === "viscous-panel"
          ? solver.model
          : undefined,
      turbulenceModel:
        solver.turbulenceModel === "sa" || solver.turbulenceModel === "sst" || solver.turbulenceModel === "kepsilon" || solver.turbulenceModel === "none"
          ? solver.turbulenceModel
          : undefined,
      maxIterations: finiteNumberValue(solver.maxIterations),
      convergenceTolerance: finiteNumberValue(solver.convergenceTolerance),
      configOverrides: normalizeConfigOverrides(solver.configOverrides)
    },
    rationale: clean(record.rationale)
  };
  if (record.mesh && typeof record.mesh === "object") {
    const mesh = record.mesh;
    spec.mesh = {
      strategy: mesh.strategy === "existing" || mesh.strategy === "toolGenerated" || mesh.strategy === "caseGenerated" ? mesh.strategy : "caseGenerated",
      artifactPath: clean(mesh.artifactPath),
      maxCells: finiteNumberValue(mesh.maxCells),
      boundaryLayer: typeof mesh.boundaryLayer === "boolean" ? mesh.boundaryLayer : undefined,
      yPlusTarget: finiteNumberValue(mesh.yPlusTarget),
      notes: clean(mesh.notes)
    };
  }
  if (record.output && typeof record.output === "object") {
    const output = record.output;
    spec.output = {
      forceCoefficients: typeof output.forceCoefficients === "boolean" ? output.forceCoefficients : undefined,
      polar: typeof output.polar === "boolean" ? output.polar : undefined,
      pressureField: typeof output.pressureField === "boolean" ? output.pressureField : undefined,
      mesh: typeof output.mesh === "boolean" ? output.mesh : undefined
    };
  }
  return spec;
}

function normalizeConfigOverrides(value: unknown): Record<string, string | number | boolean> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const output: Record<string, string | number | boolean> = {};
  for (const [key, rawValue] of Object.entries(value).slice(0, 24)) {
    if (!/^[A-Za-z0-9_]{2,80}$/.test(key)) continue;
    if (typeof rawValue === "string" || typeof rawValue === "number" || typeof rawValue === "boolean") output[key] = rawValue;
  }
  return Object.keys(output).length ? output : undefined;
}

function finiteNumberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function readyProgramRequests(requests: EngineeringProgramRequest[], diagnostics: RuntimeToolDiagnostics): EngineeringProgramRequest[] {
  const readyTemplates = new Map(
    diagnostics.engineeringProgramRequestTemplates
      .filter((template) => template.ready)
      .map((template) => [`${template.request.kind}:${template.request.target}`, template.request] as const)
  );
  const readyArtifacts = new Set(
    diagnostics.engineeringArtifactCandidates
      .filter((candidate) => candidate.ready)
      .map((candidate) => candidate.relativePath)
  );
  const readyArtifactsByFormat = new Map(
    diagnostics.engineeringArtifactCandidates
      .filter((candidate) => candidate.ready)
      .map((candidate) => [candidate.relativePath, candidate.format] as const)
  );
  const filtered: EngineeringProgramRequest[] = [];
  for (const request of requests) {
    const target = request.target ?? (targetRequiredForKind(request.kind) ? undefined : defaultTargetForKind(request.kind));
    if (!target) continue;
    const templateRequest = readyTemplates.get(`${request.kind}:${target}`);
    if (!templateRequest) continue;
    const safeRequest = mergeWithReadyProgramTemplate(templateRequest, request, readyArtifacts, readyArtifactsByFormat);
    if (!safeRequest) continue;
    filtered.push(safeRequest);
    if (filtered.length >= 4) break;
  }
  return filtered;
}

function mergeWithReadyProgramTemplate(
  templateRequest: EngineeringProgramRequest,
  request: EngineeringProgramRequest,
  readyArtifacts: Set<string>,
  readyArtifactsByFormat: Map<string, "obj" | "stl" | "vsp3" | "airfoil-coordinate">
): EngineeringProgramRequest | undefined {
  const safeRequest: EngineeringProgramRequest = { ...templateRequest };
  if (request.outputFileName?.trim()) safeRequest.outputFileName = request.outputFileName.trim();
  if (request.reason?.trim()) safeRequest.reason = request.reason.trim();
  if (request.naca?.trim()) safeRequest.naca = request.naca.trim();
  if (request.sourceUrl?.trim() && /^https?:\/\//i.test(request.sourceUrl.trim())) safeRequest.sourceUrl = request.sourceUrl.trim();
  if (request.reynolds !== undefined) safeRequest.reynolds = request.reynolds;
  if (request.mach !== undefined) safeRequest.mach = request.mach;
  if (request.alphaStart !== undefined) safeRequest.alphaStart = request.alphaStart;
  if (request.alphaEnd !== undefined) safeRequest.alphaEnd = request.alphaEnd;
  if (request.alphaStep !== undefined) safeRequest.alphaStep = request.alphaStep;
  if (request.cfdRunSpec) {
    const safeSpec = mergeCfdRunSpecWithReadyArtifacts(safeRequest, request.cfdRunSpec, readyArtifacts, readyArtifactsByFormat);
    if (!safeSpec) return undefined;
    safeRequest.cfdRunSpec = safeSpec;
  }
  if (request.artifactPath?.trim() && readyArtifacts.has(request.artifactPath.trim())) {
    const artifactPath = request.artifactPath.trim();
    const format = readyArtifactsByFormat.get(artifactPath);
    if (artifactFormatAllowedForRequest(safeRequest.kind, format)) safeRequest.artifactPath = artifactPath;
  }
  if ((safeRequest.kind === "xfoil-polar" || safeRequest.kind === "xfoil-wasm-polar") && (safeRequest.artifactPath || safeRequest.sourceUrl)) {
    delete safeRequest.naca;
  }
  if (safeRequest.kind === "mesh-inspect" && !safeRequest.artifactPath) return undefined;
  if (safeRequest.kind === "xfoil-wasm-polar" && !safeRequest.naca && !safeRequest.artifactPath && !safeRequest.sourceUrl) return undefined;
  if ((safeRequest.kind === "su2-case-run" || safeRequest.kind === "openvsp-analysis-run" || safeRequest.kind === "xflr5-analysis-run") && !safeRequest.cfdRunSpec) return undefined;
  return safeRequest;
}

function mergeCfdRunSpecWithReadyArtifacts(
  request: EngineeringProgramRequest,
  spec: CfdRunSpec,
  readyArtifacts: Set<string>,
  readyArtifactsByFormat: Map<string, "obj" | "stl" | "vsp3" | "airfoil-coordinate">
): CfdRunSpec | undefined {
  const target = request.target ?? defaultTargetForKind(request.kind);
  if (!target || spec.target !== target) return undefined;
  const safeSpec: CfdRunSpec = JSON.parse(JSON.stringify(spec)) as CfdRunSpec;
  const geometryArtifact = safeSpec.geometry.artifactPath?.trim();
  if (geometryArtifact) {
    if (!readyArtifacts.has(geometryArtifact)) return undefined;
    const format = readyArtifactsByFormat.get(geometryArtifact);
    if (!artifactFormatAllowedForRequest(request.kind, format)) return undefined;
    safeSpec.geometry.artifactPath = geometryArtifact;
  }
  const meshArtifact = safeSpec.mesh?.artifactPath?.trim();
  if (meshArtifact) {
    if (!readyArtifacts.has(meshArtifact)) return undefined;
    const format = readyArtifactsByFormat.get(meshArtifact);
    if (format !== "obj" && format !== "stl" && format !== "vsp3") return undefined;
    safeSpec.mesh = { strategy: safeSpec.mesh?.strategy ?? "existing", ...safeSpec.mesh, artifactPath: meshArtifact };
  }
  return safeSpec;
}

function artifactFormatAllowedForRequest(kind: EngineeringProgramRequest["kind"], format: "obj" | "stl" | "vsp3" | "airfoil-coordinate" | undefined): boolean {
  if (!format) return false;
  if (kind === "xfoil-polar" || kind === "xfoil-wasm-polar") return format === "airfoil-coordinate";
  if (kind === "mesh-inspect") return format === "obj" || format === "stl";
  if (kind === "openvsp-analysis-run") return format === "obj" || format === "stl" || format === "vsp3" || format === "airfoil-coordinate";
  if (kind === "xflr5-analysis-run") return format === "airfoil-coordinate" || format === "obj" || format === "stl";
  if (kind === "su2-case-run") return format === "obj" || format === "stl";
  return true;
}

function defaultTargetForKind(kind: EngineeringProgramRequest["kind"]): EngineeringProgramRequest["target"] | undefined {
  if (kind === "toolchain-check") return "all";
  if (kind === "mesh-inspect") return "modeling";
  if (kind === "xfoil-polar") return "xfoil";
  if (kind === "xfoil-wasm-polar") return "xfoil-wasm";
  if (kind === "su2-case-run") return "su2";
  if (kind === "openvsp-analysis-run") return "openvsp";
  if (kind === "xflr5-analysis-run") return "xflr5";
  return undefined;
}

function targetRequiredForKind(kind: EngineeringProgramRequest["kind"]): boolean {
  return (
    kind === "su2-case-run" ||
    kind === "openvsp-analysis-run" ||
    kind === "xflr5-analysis-run"
  );
}

function collectIds(items: Array<{ id: string }>): string[] {
  const ids: string[] = [];
  for (const item of items) ids.push(item.id);
  return ids;
}

function copyStrings(values: string[]): string[] {
  const copy: string[] = [];
  for (const value of values) copy.push(value);
  return copy;
}

function hasNormalizedTool(tools: string[], normalizedTarget: string): boolean {
  for (const tool of tools) {
    if (normalizeToolName(tool) === normalizedTarget) return true;
  }
  return false;
}
