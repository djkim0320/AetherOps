import { createId, nowIso } from "../shared/ids.js";
import type { AppSettings, OpenCodeRunInput, ToolRun } from "../shared/types.js";
import { createDefaultResearchTools } from "./toolCatalog.js";
import type { ResearchToolResult, ResearchTool } from "./researchToolTypes.js";
import { buildExecutableToolNames, type ToolExecutableContext } from "./toolAvailability.js";
export type { ToolExecutableContext } from "./toolAvailability.js";
import { filterRequiredTools, normalizedRequiredTools } from "./toolDependencyScheduler.js";
import { normalizeToolName } from "./toolMerger.js";
import { validateResearchToolResult } from "./toolResultGuards.js";

type RollingOpenCodeRunInput = OpenCodeRunInput & { toolRuns?: ToolRun[] };
type SyntheticFailureKind = "tool_exception" | "malformed_tool_result";

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

export interface ToolRunnerResult {
  completedResults: ResearchToolResult[];
  failedResult?: ResearchToolResult;
  failure?: Error;
  rollingInput: OpenCodeRunInput;
  toolName?: string;
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
    return buildExecutableToolNames(this.listRegisteredToolNames(), context);
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
      let returnedResult: unknown;
      try {
        returnedResult = await tool.run(currentInput, settings);
      } catch (error) {
        const failure = error instanceof Error ? error : new Error(String(error));
        const failedResult = syntheticFailedResult(tool.name, currentInput, failure, "tool_exception");
        throw new ToolRunnerError(`${tool.name} failed before returning a tool result: ${failure.message}`, {
          completedResults: results,
          failedResult,
          failure,
          rollingInput: accumulateToolResult(rollingInput, failedResult),
          toolName: tool.name
        });
      }
      const validation = validateResearchToolResult(returnedResult);
      if (!validation.ok) {
        const failure = new Error(validation.message);
        const failedResult = syntheticFailedResult(tool.name, currentInput, failure, "malformed_tool_result");
        throw new ToolRunnerError(`${tool.name} returned a malformed tool result: ${validation.message}`, {
          completedResults: results,
          failedResult,
          failure,
          rollingInput: accumulateToolResult(rollingInput, failedResult),
          toolName: tool.name
        });
      }
      const result = validation.result;
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

function syntheticFailedResult(toolName: string, input: RollingOpenCodeRunInput, failure: Error, failureKind: SyntheticFailureKind): ResearchToolResult {
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
        toolName,
        failureKind,
        evidenceFailure: true
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

function researchToolMap(tools: ResearchTool[]): Map<string, ResearchTool> {
  const map = new Map<string, ResearchTool>();
  for (const tool of tools) map.set(normalizeToolName(tool.name), tool);
  return map;
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

const httpUrlPattern = /^https?:\/\//i;
