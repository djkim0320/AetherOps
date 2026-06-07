import { createId, nowIso } from "../shared/ids.js";
import { hasExecutableEngineeringTool } from "./engineeringProgramTool.js";
import type { AppSettings, OpenCodeRunInput, ResearchSnapshot, ToolRun } from "../shared/types.js";
import { createDefaultResearchTools, type ResearchToolResult, type ResearchTool } from "./toolRegistry.js";

type RollingOpenCodeRunInput = OpenCodeRunInput & { toolRuns?: ToolRun[] };

export interface ToolExecutableContext {
  snapshot: ResearchSnapshot;
  settings: AppSettings;
}

export interface ToolRunnerResult {
  completedResults: ResearchToolResult[];
  failedResult?: ResearchToolResult;
  failure?: Error;
  rollingInput: OpenCodeRunInput;
  toolName?: string;
}

export interface ToolRunnerOptions {
  includeTools?: string[];
  excludeTools?: string[];
}

export class ToolRunnerError extends Error {
  readonly partialResults: ResearchToolResult[];
  readonly failedResult?: ResearchToolResult;
  readonly rollingInput: OpenCodeRunInput;
  readonly failure?: Error;
  readonly toolName: string;

  constructor(message: string, result: ToolRunnerResult) {
    super(message);
    this.name = "ToolRunnerError";
    this.partialResults = result.completedResults;
    this.failedResult = result.failedResult;
    this.rollingInput = result.rollingInput;
    this.failure = result.failure;
    this.toolName = result.toolName ?? result.failedResult?.toolRun.toolName ?? "unknown";
  }
}

export class ToolRunner {
  constructor(private readonly tools: ResearchTool[] = createDefaultResearchTools()) {}

  listRegisteredToolNames(): string[] {
    const names: string[] = [];
    const seen = new Set<string>();
    for (const tool of this.tools) {
      if (seen.has(tool.name)) continue;
      seen.add(tool.name);
      names.push(tool.name);
    }
    return names;
  }

  listToolNames(): string[] {
    return this.listRegisteredToolNames();
  }

  listExecutableToolNames(context: ToolExecutableContext): string[] {
    const registered = registeredToolNameMap(this.tools);
    const externalAllowed = context.snapshot.project.autonomyPolicy.allowExternalSearch && context.settings.allowExternalSearch;
    const webSearchConfigured =
      context.settings.webSearch.provider !== "disabled" && Boolean(context.settings.webSearch.apiKey || context.settings.webSearch.apiKeyConfigured);
    const hasFetchCandidates = hasFetchCandidateUrls(context.snapshot) || hasContinuationFetchHint(context.snapshot);
    const hasPdfInputs = hasPdfInput(context.snapshot);
    const codeAllowed = context.snapshot.project.autonomyPolicy.allowCodeExecution && context.settings.allowCodeExecution;
    const researchMetadataReady = externalAllowed && context.settings.researchMetadata.enabled;
    const engineeringProgramReady = codeAllowed && hasExecutableEngineeringTool(context.settings);

    const customRegistered: string[] = [];
    for (const [normalizedName, registeredName] of registered) {
      if (!standardExecutableToolNames.has(normalizedName)) customRegistered.push(registeredName);
    }

    const candidates: string[] = [];
    pushRegisteredTool(candidates, registered, "WebSearchTool", externalAllowed && webSearchConfigured);
    pushRegisteredTool(candidates, registered, "BackgroundBrowserTool", externalAllowed && context.settings.browserUse.enabled);
    pushRegisteredTool(candidates, registered, "WebFetchTool", externalAllowed && (hasFetchCandidates || webSearchConfigured || context.settings.browserUse.enabled));
    pushRegisteredTool(candidates, registered, "ResearchMetadataTool", researchMetadataReady);
    pushRegisteredTool(candidates, registered, "PdfIngestionTool", hasPdfInputs);
    pushRegisteredTool(candidates, registered, "CodeExecutionTool", codeAllowed);
    pushRegisteredTool(candidates, registered, "EngineeringProgramTool", engineeringProgramReady);
    pushRegisteredTool(candidates, registered, "ArtifactWriterTool", true);
    pushRegisteredTool(candidates, registered, "DataAnalysisTool", true);
    for (const tool of customRegistered) candidates.push(tool);
    return orderToolNames(candidates);
  }

  hasTool(name: string): boolean {
    const normalized = normalizeToolName(name);
    for (const tool of this.tools) {
      if (normalizeToolName(tool.name) === normalized) return true;
    }
    return false;
  }

  async runAll(input: OpenCodeRunInput, settings: AppSettings, options: ToolRunnerOptions = {}): Promise<ResearchToolResult[]> {
    const results: ResearchToolResult[] = [];
    let rollingInput = cloneRollingInput(input);
    const toolMap = researchToolMap(this.tools);
    const requiredTools = filterRequiredTools(normalizedRequiredTools(input.researchPlan?.requiredTools ?? []), options);

    for (const toolName of requiredTools) {
      const tool = toolMap.get(toolName);
      if (!tool) {
        throw new ToolRunnerError(`Required research tool is not registered: ${toolName}`, {
          completedResults: results,
          rollingInput,
          toolName
        });
      }
      const currentInput = cloneRollingInput(rollingInput);
      let result: ResearchToolResult;
      try {
        result = await tool.run(currentInput, settings);
      } catch (error) {
        const failure = error instanceof Error ? error : new Error(String(error));
        const failedResult = syntheticFailedResult(tool.name, currentInput, failure);
        throw new ToolRunnerError(`${tool.name} failed before returning a tool result: ${failure.message}`, {
          completedResults: results,
          failedResult,
          failure,
          rollingInput: accumulateToolResult(rollingInput, failedResult),
          toolName: tool.name
        });
      }
      if (result.toolRun.status !== "completed") {
        throw new ToolRunnerError(`${tool.name} did not complete successfully: ${result.toolRun.error ?? JSON.stringify(result.toolRun.output)}`, {
          completedResults: results,
          failedResult: result,
          rollingInput: accumulateToolResult(rollingInput, result),
          toolName: tool.name
        });
      }
      results.push(result);
      rollingInput = accumulateToolResult(rollingInput, result);
    }
    return results;
  }
}

function syntheticFailedResult(toolName: string, input: RollingOpenCodeRunInput, failure: Error): ResearchToolResult {
  const timestamp = nowIso();
  const urls = candidateUrlCount(input);
  return {
    toolRun: {
      id: createId("tool"),
      projectId: input.project.id,
      iteration: input.iteration,
      toolName,
      input: {
        projectId: input.project.id,
        iteration: input.iteration,
        toolName,
        sourceCount: input.sources?.length ?? 0,
        evidenceCount: input.evidence?.length ?? 0,
        artifactCount: input.artifacts?.length ?? 0,
        toolRunCount: input.toolRuns?.length ?? 0,
        selectedUrlCandidateCount: urls
      },
      output: {
        failureMessage: failure.message,
        toolName
      },
      status: "failed",
      error: failure.message,
      startedAt: timestamp,
      completedAt: timestamp
    },
    evidence: [],
    artifacts: [],
    sources: []
  };
}

function accumulateToolResult(input: RollingOpenCodeRunInput, result: ResearchToolResult): RollingOpenCodeRunInput {
  return {
    ...input,
    evidence: concatItems(input.evidence ?? [], result.evidence),
    artifacts: concatItems(input.artifacts ?? [], result.artifacts),
    sources: concatItems(input.sources ?? [], result.sources),
    toolRuns: appendItem(input.toolRuns ?? [], result.toolRun)
  };
}

function cloneRollingInput(input: RollingOpenCodeRunInput): RollingOpenCodeRunInput {
  return {
    ...input,
    evidence: copyItems(input.evidence ?? []),
    artifacts: copyItems(input.artifacts ?? []),
    sources: copyItems(input.sources ?? []),
    sourceCandidates: copyItems(input.sourceCandidates ?? []),
    claims: copyItems(input.claims ?? []),
    observations: copyItems(input.observations ?? []),
    toolRuns: copyItems(input.toolRuns ?? []),
    normalizedRecords: copyItems(input.normalizedRecords ?? []),
    validationResults: copyItems(input.validationResults ?? []),
    projectContextSnapshots: copyItems(input.projectContextSnapshots ?? []),
    results: copyItems(input.results ?? [])
  };
}

function copyItems<T>(items: T[]): T[] {
  if (!items.length) return [];
  const output: T[] = [];
  for (const item of items) output.push(item);
  return output;
}

function concatItems<T>(first: T[], second: T[]): T[] {
  if (!first.length && !second.length) return [];
  if (!second.length) return first;
  if (!first.length) return copyItems(second);
  const output: T[] = [];
  for (const item of first) output.push(item);
  for (const item of second) output.push(item);
  return output;
}

function appendItem<T>(items: T[], item: T): T[] {
  const output = new Array<T>(items.length + 1);
  for (let index = 0; index < items.length; index += 1) output[index] = items[index] as T;
  output[items.length] = item;
  return output;
}

export function normalizeToolName(value: string): string {
  return value.replace(toolAnnotationPattern, "").replace(toolWhitespacePattern, "").trim().toLowerCase();
}

function registeredToolNameMap(tools: ResearchTool[]): Map<string, string> {
  const registered = new Map<string, string>();
  for (const tool of tools) registered.set(normalizeToolName(tool.name), tool.name);
  return registered;
}

function researchToolMap(tools: ResearchTool[]): Map<string, ResearchTool> {
  const map = new Map<string, ResearchTool>();
  for (const tool of tools) map.set(normalizeToolName(tool.name), tool);
  return map;
}

function pushRegisteredTool(candidates: string[], registered: Map<string, string>, name: string, enabled: boolean): void {
  if (!enabled) return;
  const registeredName = registered.get(normalizeToolName(name));
  if (registeredName) candidates.push(registeredName);
}

function normalizedRequiredTools(requiredTools: string[]): string[] {
  const normalized: string[] = [];
  for (const tool of orderedToolEntries(requiredTools)) {
    if (tool.normalized !== "opencodetool") normalized.push(tool.normalized);
  }
  return normalized;
}

function filterRequiredTools(requiredTools: string[], options: ToolRunnerOptions): string[] {
  const include = normalizedToolFilter(options.includeTools);
  const exclude = normalizedToolFilter(options.excludeTools);
  const filtered: string[] = [];
  for (const tool of requiredTools) {
    if (include && !include.has(tool)) continue;
    if (exclude?.has(tool)) continue;
    filtered.push(tool);
  }
  return filtered;
}

function normalizedToolFilter(tools: string[] | undefined): Set<string> | undefined {
  if (!tools?.length) return undefined;
  const normalized = new Set<string>();
  for (const tool of tools) {
    const name = normalizeToolName(tool);
    if (name && name !== "opencodetool") normalized.add(name);
  }
  return normalized;
}

const canonicalToolOrder = [
  "opencodetool",
  "websearchtool",
  "backgroundbrowsertool",
  "webfetchtool",
  "researchmetadatatool",
  "papermetadatatool",
  "pdfingestiontool",
  "codeexecutiontool",
  "engineeringprogramtool",
  "artifactwritertool",
  "dataanalysistool"
];

function buildCanonicalToolOrderMap(): Map<string, number> {
  const order = new Map<string, number>();
  for (let index = 0; index < canonicalToolOrder.length; index += 1) {
    order.set(canonicalToolOrder[index], index);
  }
  return order;
}

function buildStandardExecutableToolNames(): Set<string> {
  const names = new Set<string>();
  for (const tool of canonicalToolOrder) {
    if (tool !== "opencodetool") names.add(tool);
  }
  return names;
}

const canonicalToolOrderByName = buildCanonicalToolOrderMap();
const standardExecutableToolNames = buildStandardExecutableToolNames();
const httpUrlPattern = /^https?:\/\//i;
const pdfUrlPattern = /\.pdf($|[?#])/i;
const arxivAbsUrlPattern = /arxiv\.org\/abs\//i;
const webFetchHintPattern = /webfetch|fetch selected source|citation-backed evidence/i;

export function orderToolNames(values: string[]): string[] {
  const output: string[] = [];
  for (const item of orderedToolEntries(values)) output.push(item.value);
  return output;
}

function orderedToolEntries(values: string[]): Array<{ normalized: string; value: string }> {
  const ordered: Array<{ normalized: string; value: string }> = [];
  const seen = new Set<string>();
  for (const value of values) {
    const normalized = normalizeToolName(value);
    if (normalized && !seen.has(normalized)) {
      seen.add(normalized);
      ordered.push({ normalized, value });
    }
  }
  if (ordered.length > 1) ordered.sort((left, right) => {
      const leftIndex = canonicalToolOrderByName.get(left.normalized);
      const rightIndex = canonicalToolOrderByName.get(right.normalized);
      if (leftIndex === undefined && rightIndex === undefined) return 0;
      if (leftIndex === undefined) return 1;
      if (rightIndex === undefined) return -1;
      return leftIndex - rightIndex;
    });
  return ordered;
}

const toolAnnotationPattern = /\(.*?\)/g;
const toolWhitespacePattern = /\s+/g;

export function dedupeResearchTools(tools: ResearchTool[]): ResearchTool[] {
  const map = new Map<string, ResearchTool>();
  for (const tool of tools) {
    map.set(normalizeToolName(tool.name), tool);
  }
  const deduped: ResearchTool[] = [];
  for (const tool of map.values()) deduped.push(tool);
  return deduped;
}

function hasFetchCandidateUrls(snapshot: ResearchSnapshot): boolean {
  if ((snapshot.researchPlans ?? []).at(-1)?.fetchCandidateUrls?.length) return true;
  if ((snapshot.continuationDecisions ?? []).at(-1)?.fetchCandidateUrls?.length) return true;
  for (const source of snapshot.sources ?? []) {
    if (source.kind === "web" && source.url && !source.rawPath && source.metadata.fetchStatus !== "fetched") return true;
  }
  for (const evidence of snapshot.evidence ?? []) {
    if (evidence.sourceUri) return true;
  }
  for (const citation of (snapshot.projectContextSnapshots ?? []).at(-1)?.citations ?? []) {
    if (httpUrlPattern.test(citation)) return true;
  }
  return false;
}

function hasContinuationFetchHint(snapshot: ResearchSnapshot): boolean {
  const decision = (snapshot.continuationDecisions ?? []).at(-1);
  for (const hint of decision?.planRevisionHints ?? []) {
    if (webFetchHintPattern.test(hint)) return true;
  }
  return false;
}

function hasPdfInput(snapshot: ResearchSnapshot): boolean {
  for (const source of snapshot.sources ?? []) {
    if (pdfUrlPattern.test(source.url ?? source.rawPath ?? String(source.metadata.pdfUrl ?? "")) || source.metadata.mimeType === "application/pdf") {
      return true;
    }
  }
  for (const url of (snapshot.researchPlans ?? []).at(-1)?.fetchCandidateUrls ?? []) {
    if (pdfUrlPattern.test(url) || arxivAbsUrlPattern.test(url)) return true;
  }
  for (const artifact of snapshot.artifacts ?? []) {
    if (artifact.mimeType === "application/pdf" || pdfUrlPattern.test(artifact.relativePath)) return true;
  }
  return false;
}

function candidateUrlCount(input: OpenCodeRunInput): number {
  const urls = new Set<string>();
  for (const url of input.researchPlan?.fetchCandidateUrls ?? []) urls.add(url);
  for (const source of input.sources ?? []) {
    if (source.kind === "web" && source.url) urls.add(source.url);
  }
  for (const evidence of input.evidence ?? []) {
    if (evidence.sourceUri) urls.add(evidence.sourceUri);
  }
  for (const citation of input.projectContextSnapshot?.citations ?? []) {
    if (httpUrlPattern.test(citation)) urls.add(citation);
  }
  return urls.size;
}
