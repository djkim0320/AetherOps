import { createId, nowIso } from "./ids.js";
import type { AppSettings, OpenCodeRunInput, ResearchSnapshot, ToolRun } from "./types.js";
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
    return [...new Set(this.tools.map((tool) => tool.name))];
  }

  listToolNames(): string[] {
    return this.listRegisteredToolNames();
  }

  listExecutableToolNames(context: ToolExecutableContext): string[] {
    const registered = new Map(this.tools.map((tool) => [normalizeToolName(tool.name), tool.name]));
    const include = (name: string, enabled: boolean) => (enabled && registered.has(normalizeToolName(name)) ? [registered.get(normalizeToolName(name)) as string] : []);
    const externalAllowed = context.snapshot.project.autonomyPolicy.allowExternalSearch && context.settings.allowExternalSearch;
    const webSearchConfigured =
      context.settings.webSearch.provider !== "disabled" && Boolean(context.settings.webSearch.apiKey || context.settings.webSearch.apiKeyConfigured);
    const hasFetchCandidates = hasFetchCandidateUrls(context.snapshot) || hasContinuationFetchHint(context.snapshot);
    const hasPdfInputs = hasPdfInput(context.snapshot);
    const codeAllowed = context.snapshot.project.autonomyPolicy.allowCodeExecution && context.settings.allowCodeExecution;

    const standard = [
      "websearchtool",
      "backgroundbrowsertool",
      "webfetchtool",
      "papermetadatatool",
      "pdfingestiontool",
      "codeexecutiontool",
      "artifactwritertool",
      "dataanalysistool"
    ];
    const customRegistered = this.listRegisteredToolNames().filter((name) => !standard.includes(normalizeToolName(name)));

    return orderToolNames([
      ...include("WebSearchTool", externalAllowed && webSearchConfigured),
      ...include("BackgroundBrowserTool", externalAllowed && context.settings.browserUse.enabled),
      ...include("WebFetchTool", externalAllowed || hasFetchCandidates),
      ...include("PdfIngestionTool", hasPdfInputs),
      ...include("CodeExecutionTool", codeAllowed),
      ...include("ArtifactWriterTool", true),
      ...include("DataAnalysisTool", true),
      ...customRegistered
    ]);
  }

  hasTool(name: string): boolean {
    const normalized = normalizeToolName(name);
    return this.tools.some((tool) => normalizeToolName(tool.name) === normalized);
  }

  async runAll(input: OpenCodeRunInput, settings: AppSettings): Promise<ResearchToolResult[]> {
    const results: ResearchToolResult[] = [];
    let rollingInput: RollingOpenCodeRunInput = {
      ...input,
      evidence: [...(input.evidence ?? [])],
      artifacts: [...(input.artifacts ?? [])],
      sources: [...(input.sources ?? [])],
      sourceCandidates: [...(input.sourceCandidates ?? [])],
      claims: [...(input.claims ?? [])],
      observations: [...(input.observations ?? [])],
      toolRuns: [...(input.toolRuns ?? [])]
    };
    const toolMap = new Map(this.tools.map((tool) => [normalizeToolName(tool.name), tool]));
    const requiredTools = orderToolNames(input.researchPlan?.requiredTools ?? [])
      .map(normalizeToolName)
      .filter((toolName) => toolName && toolName !== "opencodetool");

    for (const toolName of requiredTools) {
      const tool = toolMap.get(toolName);
      if (!tool) {
        throw new ToolRunnerError(`Required research tool is not registered: ${toolName}`, {
          completedResults: results,
          rollingInput,
          toolName
        });
      }
      const currentInput: RollingOpenCodeRunInput = {
        ...rollingInput,
        evidence: [...(rollingInput.evidence ?? [])],
        artifacts: [...(rollingInput.artifacts ?? [])],
        sources: [...(rollingInput.sources ?? [])],
        sourceCandidates: [...(rollingInput.sourceCandidates ?? [])],
        claims: [...(rollingInput.claims ?? [])],
        observations: [...(rollingInput.observations ?? [])],
        toolRuns: [...(rollingInput.toolRuns ?? [])]
      };
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
    evidence: [...(input.evidence ?? []), ...result.evidence],
    artifacts: [...(input.artifacts ?? []), ...result.artifacts],
    sources: [...(input.sources ?? []), ...result.sources],
    toolRuns: [...(input.toolRuns ?? []), result.toolRun]
  };
}

export function normalizeToolName(value: string): string {
  return value.replace(/\(.*?\)/g, "").replace(/\s+/g, "").trim().toLowerCase();
}

const canonicalToolOrder = [
  "opencodetool",
  "websearchtool",
  "backgroundbrowsertool",
  "webfetchtool",
  "papermetadatatool",
  "pdfingestiontool",
  "codeexecutiontool",
  "artifactwritertool",
  "dataanalysistool"
];

export function orderToolNames(values: string[]): string[] {
  const firstSeen = new Map<string, string>();
  for (const value of values) {
    const normalized = normalizeToolName(value);
    if (normalized && !firstSeen.has(normalized)) {
      firstSeen.set(normalized, value);
    }
  }
  return [...firstSeen.entries()]
    .sort(([left], [right]) => {
      const leftIndex = canonicalToolOrder.indexOf(left);
      const rightIndex = canonicalToolOrder.indexOf(right);
      if (leftIndex === -1 && rightIndex === -1) return 0;
      if (leftIndex === -1) return 1;
      if (rightIndex === -1) return -1;
      return leftIndex - rightIndex;
    })
    .map(([, value]) => value);
}

export function dedupeResearchTools(tools: ResearchTool[]): ResearchTool[] {
  const map = new Map<string, ResearchTool>();
  for (const tool of tools) {
    map.set(normalizeToolName(tool.name), tool);
  }
  return [...map.values()];
}

function hasFetchCandidateUrls(snapshot: ResearchSnapshot): boolean {
  return snapshot.sources.some((source) => source.kind === "web" && Boolean(source.url) && !source.rawPath && source.metadata.fetchStatus !== "fetched") ||
    snapshot.evidence.some((evidence) => Boolean(evidence.sourceUri));
}

function hasContinuationFetchHint(snapshot: ResearchSnapshot): boolean {
  const decision = snapshot.continuationDecisions.at(-1);
  return Boolean(decision?.planRevisionHints.some((hint) => /webfetch|fetch selected source|citation-backed evidence/i.test(hint)));
}

function hasPdfInput(snapshot: ResearchSnapshot): boolean {
  return snapshot.sources.some((source) => /\.pdf($|[?#])/i.test(source.url ?? source.rawPath ?? "") || source.metadata.mimeType === "application/pdf") ||
    snapshot.artifacts.some((artifact) => artifact.mimeType === "application/pdf" || /\.pdf$/i.test(artifact.relativePath));
}

function candidateUrlCount(input: OpenCodeRunInput): number {
  const urls = new Set<string>();
  for (const source of input.sources ?? []) {
    if (source.kind === "web" && source.url) urls.add(source.url);
  }
  for (const evidence of input.evidence ?? []) {
    if (evidence.sourceUri) urls.add(evidence.sourceUri);
  }
  return urls.size;
}
