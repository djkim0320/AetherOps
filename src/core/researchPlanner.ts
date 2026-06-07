import { createId, nowIso } from "./ids.js";
import { describeEngineeringProgramCapabilities, hasExecutableEngineeringTool } from "./engineeringProgramTool.js";
import { LlmTimeoutError, type LlmProvider } from "./llm.js";
import { buildRuntimeToolDiagnostics } from "./runtimeToolDiagnostics.js";
import { normalizeToolName, orderToolNames } from "./toolRunner.js";
import type {
  AppSettings,
  ContinuationDecision,
  EngineeringProgramRequest,
  ResearchPlan,
  ResearchSnapshot,
  ResearchSpecification,
  RuntimeToolDiagnostics
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
  programRequests?: EngineeringProgramRequest[];
}

const WEB_SEARCH_TOOL = normalizeToolName("WebSearchTool");
const WEB_FETCH_TOOL = normalizeToolName("WebFetchTool");
const ENGINEERING_PROGRAM_TOOL = normalizeToolName("EngineeringProgramTool");
const PDF_URL_PATTERN = /\.pdf($|[?#])/i;
const ARXIV_ABS_URL_PATTERN = /arxiv\.org\/abs\//i;
const HTTP_URL_PATTERN = /^https?:\/\//i;
const WEB_FETCH_HINT_PATTERN = /webfetchtool|fetch selected source urls/i;

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
    let requiredTools = orderToolNames(ensureHintTools(strings(response.requiredTools, defaultPlan.requiredTools), { ...input, fetchCandidateUrls }));
    let programRequests = hasNormalizedTool(requiredTools, ENGINEERING_PROGRAM_TOOL)
      ? readyProgramRequests(normalizeProgramRequests(response.programRequests, defaultPlan.programRequests ?? defaultEngineeringProgramRequests()), runtimeToolDiagnostics)
      : undefined;
    if (programRequests && !programRequests.length) {
      requiredTools = requiredTools.filter((tool) => normalizeToolName(tool) !== ENGINEERING_PROGRAM_TOOL);
      programRequests = undefined;
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
            modelingConfigured: Boolean(input.settings.engineeringTools.modeling.enabled && input.settings.engineeringTools.modeling.artifactRoot?.trim()),
            openFoamConfigured: Boolean(input.settings.engineeringTools.openFoam.enabled && input.settings.engineeringTools.openFoam.command?.trim() && input.settings.engineeringTools.openFoam.caseRoot?.trim()),
            su2Configured: Boolean(input.settings.engineeringTools.su2.enabled && input.settings.engineeringTools.su2.command?.trim() && input.settings.engineeringTools.su2.caseRoot?.trim() && input.settings.engineeringTools.su2.configFile?.trim()),
            freeCadConfigured: Boolean(input.settings.engineeringTools.freeCad.enabled && input.settings.engineeringTools.freeCad.command?.trim() && input.settings.engineeringTools.freeCad.scriptPath?.trim()),
            openVspConfigured: Boolean(input.settings.engineeringTools.openVsp.enabled && input.settings.engineeringTools.openVsp.command?.trim() && input.settings.engineeringTools.openVsp.scriptPath?.trim()),
            openFoam: input.settings.engineeringTools.openFoam,
            su2: input.settings.engineeringTools.su2,
            freeCad: input.settings.engineeringTools.freeCad,
            openVsp: input.settings.engineeringTools.openVsp,
            commercialCfd: input.settings.engineeringTools.commercialCfd,
            capabilities: describeEngineeringProgramCapabilities(input.settings)
          },
          runtimeToolDiagnostics,
          openCodeEnabled: input.settings.openCode.enabled,
          availableTools: input.availableTools
        })}`,
        "If EngineeringProgramTool is selected, build programRequests from runtimeToolDiagnostics.engineeringProgramRequestTemplates. Use only templates marked ready=true. For artifactPath, use only runtimeToolDiagnostics.engineeringArtifactCandidates entries marked ready=true; do not invent paths. If no engineering template is ready, do not request EngineeringProgramTool.",
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
            modelingConfigured: Boolean(input.settings.engineeringTools.modeling.enabled && input.settings.engineeringTools.modeling.artifactRoot?.trim()),
            openFoamConfigured: Boolean(input.settings.engineeringTools.openFoam.enabled && input.settings.engineeringTools.openFoam.command?.trim() && input.settings.engineeringTools.openFoam.caseRoot?.trim()),
            su2Configured: Boolean(input.settings.engineeringTools.su2.enabled && input.settings.engineeringTools.su2.command?.trim() && input.settings.engineeringTools.su2.caseRoot?.trim() && input.settings.engineeringTools.su2.configFile?.trim()),
            freeCadConfigured: Boolean(input.settings.engineeringTools.freeCad.enabled && input.settings.engineeringTools.freeCad.command?.trim() && input.settings.engineeringTools.freeCad.scriptPath?.trim()),
            openVspConfigured: Boolean(input.settings.engineeringTools.openVsp.enabled && input.settings.engineeringTools.openVsp.command?.trim() && input.settings.engineeringTools.openVsp.scriptPath?.trim()),
            openFoam: input.settings.engineeringTools.openFoam,
            su2: input.settings.engineeringTools.su2,
            freeCad: input.settings.engineeringTools.freeCad,
            openVsp: input.settings.engineeringTools.openVsp,
            commercialCfd: input.settings.engineeringTools.commercialCfd,
            capabilities: describeEngineeringProgramCapabilities(input.settings)
          },
          runtimeToolDiagnostics,
          openCodeEnabled: input.settings.openCode.enabled,
          availableTools: input.availableTools
        })}`,
        "If EngineeringProgramTool is selected, build programRequests from runtimeToolDiagnostics.engineeringProgramRequestTemplates. Use only templates marked ready=true. For artifactPath, use only runtimeToolDiagnostics.engineeringArtifactCandidates entries marked ready=true; do not invent paths. If no engineering template is ready, do not request EngineeringProgramTool.",
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
      engineeringProgramReady: input.settings.allowCodeExecution && hasExecutableEngineeringTool(input.settings),
      webSearchReady
    });
    const tools = orderToolNames(executableCandidateTools(candidateTools, available));
    const programRequests = hasNormalizedTool(tools, ENGINEERING_PROGRAM_TOOL) ? defaultEngineeringProgramRequests() : undefined;
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
      programRequests,
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
    engineeringProgramReady: boolean;
    webSearchReady: boolean;
  }
): string[] {
  const tools = ["OpenCodeTool"];
  if (state.webSearchReady) tools.push("WebSearchTool");
  if (state.researchMetadataReady) tools.push("ResearchMetadataTool");
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
      request.kind !== "openfoam-case-run" &&
      request.kind !== "su2-case-run" &&
      request.kind !== "cad-script-run" &&
      request.kind !== "vsp-script-run" &&
      request.kind !== "commercial-cfd-run"
    ) continue;
    const normalized: EngineeringProgramRequest = { kind: request.kind };
    if (
      request.target === "all" ||
      request.target === "xfoil" ||
      request.target === "modeling" ||
      request.target === "openfoam" ||
      request.target === "su2" ||
      request.target === "freecad" ||
      request.target === "openvsp" ||
      request.target === "flightstream" ||
      request.target === "starccm"
    ) {
      normalized.target = request.target;
    }
    if (typeof request.artifactPath === "string" && request.artifactPath.trim()) {
      normalized.artifactPath = request.artifactPath.trim();
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
  const filtered: EngineeringProgramRequest[] = [];
  for (const request of requests) {
    const target = request.target ?? (targetRequiredForKind(request.kind) ? undefined : defaultTargetForKind(request.kind));
    if (!target) continue;
    const templateRequest = readyTemplates.get(`${request.kind}:${target}`);
    if (!templateRequest) continue;
    const safeRequest = mergeWithReadyProgramTemplate(templateRequest, request, readyArtifacts);
    if (!safeRequest) continue;
    filtered.push(safeRequest);
    if (filtered.length >= 4) break;
  }
  return filtered;
}

function mergeWithReadyProgramTemplate(
  templateRequest: EngineeringProgramRequest,
  request: EngineeringProgramRequest,
  readyArtifacts: Set<string>
): EngineeringProgramRequest | undefined {
  const safeRequest: EngineeringProgramRequest = { ...templateRequest };
  if (request.outputFileName?.trim()) safeRequest.outputFileName = request.outputFileName.trim();
  if (request.reason?.trim()) safeRequest.reason = request.reason.trim();
  if (request.naca?.trim()) safeRequest.naca = request.naca.trim();
  if (request.reynolds !== undefined) safeRequest.reynolds = request.reynolds;
  if (request.mach !== undefined) safeRequest.mach = request.mach;
  if (request.alphaStart !== undefined) safeRequest.alphaStart = request.alphaStart;
  if (request.alphaEnd !== undefined) safeRequest.alphaEnd = request.alphaEnd;
  if (request.alphaStep !== undefined) safeRequest.alphaStep = request.alphaStep;
  if (request.artifactPath?.trim() && readyArtifacts.has(request.artifactPath.trim())) {
    safeRequest.artifactPath = request.artifactPath.trim();
  }
  if (safeRequest.kind === "mesh-inspect" && !safeRequest.artifactPath) return undefined;
  return safeRequest;
}

function defaultTargetForKind(kind: EngineeringProgramRequest["kind"]): EngineeringProgramRequest["target"] | undefined {
  if (kind === "toolchain-check") return "all";
  if (kind === "mesh-inspect") return "modeling";
  if (kind === "xfoil-polar") return "xfoil";
  if (kind === "openfoam-case-run") return "openfoam";
  if (kind === "su2-case-run") return "su2";
  if (kind === "cad-script-run") return "freecad";
  if (kind === "vsp-script-run") return "openvsp";
  return undefined;
}

function targetRequiredForKind(kind: EngineeringProgramRequest["kind"]): boolean {
  return (
    kind === "openfoam-case-run" ||
    kind === "su2-case-run" ||
    kind === "cad-script-run" ||
    kind === "vsp-script-run" ||
    kind === "commercial-cfd-run"
  );
}

function defaultEngineeringProgramRequests(): EngineeringProgramRequest[] {
  return [{ kind: "toolchain-check", target: "all", reason: "Verify configured engineering program availability before requesting analysis outputs." }];
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
