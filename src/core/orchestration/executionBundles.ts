import { createId, nowIso } from "../shared/ids.js";
import { dedupeSourcesByIdUrlDoi } from "../evidence/sourceDedupe.js";
import type { ResearchToolResult } from "../tools/researchToolTypes.js";
import type { EvidenceItem, OpenCodeRun, OpenCodeRunInput, OpenCodeRunOutput, ResearchArtifact, ResearchSource, ToolRun } from "../shared/types.js";

export function applyToolResultsToOpenCodeInput(input: OpenCodeRunInput, results: ResearchToolResult[]): OpenCodeRunInput {
  if (!results.length) return input;
  let evidence = copyItems(input.evidence ?? []);
  let artifacts = copyItems(input.artifacts ?? []);
  let sources = copyItems(input.sources ?? []);
  let toolRuns = copyItems(input.toolRuns ?? []);
  for (const result of results) {
    evidence = concatItems(evidence, result.evidence);
    artifacts = concatItems(artifacts, result.artifacts);
    sources = concatItems(sources, result.sources);
    toolRuns = concatItems(toolRuns, [result.toolRun]);
  }
  return {
    ...input,
    evidence,
    artifacts,
    sources: dedupeSourcesByIdUrlDoi(sources),
    toolRuns
  };
}

export function withToolRunBundle(toolRun: ToolRun, executionBundleId: string): ToolRun {
  return {
    ...toolRun,
    input: appendBundleToUnknown(toolRun.input, executionBundleId),
    output: appendBundleToUnknown(toolRun.output, executionBundleId)
  };
}

export function withOpenCodeRunBundle(run: OpenCodeRunOutput["run"], executionBundleId: string): OpenCodeRunOutput["run"] {
  const logs = run.logs.some((line) => line.includes(executionBundleId)) ? run.logs : concatItems(run.logs, [`executionBundleId: ${executionBundleId}`]);
  return {
    ...run,
    metadata: { ...(run.metadata ?? {}), executionBundleId },
    logs
  };
}

export function buildExecutionBundleId(projectId: string, iteration: number, openCodeRunId: string): string {
  return `execution-bundle:${projectId}:${iteration}:${openCodeRunId}`;
}

export function genericOpenCodeRunAttempt(input: OpenCodeRunInput, executionBundleId: string): OpenCodeRun {
  const startedAt = nowIso();
  const prompt = [
    "OpenCode adapter run input",
    `Project: ${JSON.stringify(input.project)}`,
    `Questions: ${JSON.stringify(input.questions)}`,
    `Hypotheses: ${JSON.stringify(input.hypotheses)}`,
    `ResearchPlan: ${JSON.stringify(input.researchPlan)}`,
    `Iteration: ${input.iteration}`
  ].join("\n");
  return {
    id: input.openCodeRunId ?? createId("opencode"),
    projectId: input.project.id,
    iteration: input.iteration,
    prompt,
    toolPlan: ["OpenCodeTool"],
    status: "running",
    logs: ["OpenCode adapter attempt started."],
    artifactIds: [],
    evidenceIds: [],
    metadata: { executionBundleId },
    startedAt
  };
}

export function failedOpenCodeRun(run: OpenCodeRun, error: unknown, executionBundleId: string): OpenCodeRun {
  const message = formatError(error);
  return withOpenCodeRunBundle(
    {
      ...run,
      status: "failed",
      logs: concatItems(run.logs, [`OpenCode execution failed: ${message}`]),
      metadata: {
        ...(run.metadata ?? {}),
        ...executionErrorMetadata(error),
        executionBundleId,
        error: message
      },
      completedAt: nowIso()
    },
    executionBundleId
  );
}

export function executionErrorMetadata(error: unknown): Record<string, unknown> {
  if (!error || typeof error !== "object") return {};
  const metadata = (error as { metadata?: unknown }).metadata;
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return {};
  return metadata as Record<string, unknown>;
}

export function bundleToolRuns(toolRuns: ToolRun[], executionBundleId: string): ToolRun[] {
  const bundled: ToolRun[] = [];
  for (const toolRun of toolRuns) bundled.push(withToolRunBundle(toolRun, executionBundleId));
  return bundled;
}

export function bundleSources(sources: ResearchSource[], executionBundleId: string): ResearchSource[] {
  const bundled: ResearchSource[] = [];
  for (const source of sources) bundled.push(withSourceBundle(source, executionBundleId));
  return bundled;
}

export function bundleEvidence(evidence: EvidenceItem[], executionBundleId: string): EvidenceItem[] {
  const bundled: EvidenceItem[] = [];
  for (const item of evidence) bundled.push(withEvidenceBundle(item, executionBundleId));
  return bundled;
}

export function bundleArtifacts(artifacts: ResearchArtifact[], executionBundleId: string): ResearchArtifact[] {
  const bundled: ResearchArtifact[] = [];
  for (const artifact of artifacts) bundled.push(withArtifactBundle(artifact, executionBundleId));
  return bundled;
}

export function bundleOpenCodeStructured<T extends { metadata?: Record<string, unknown> }>(values: T[], executionBundleId: string): T[] {
  const bundled: T[] = [];
  for (const value of values) bundled.push(withOpenCodeStructuredBundle(value, executionBundleId));
  return bundled;
}

export function copyItems<T>(items: T[]): T[] {
  const copy: T[] = [];
  for (const item of items) copy.push(item);
  return copy;
}

export function concatItems<T>(first: T[], second: T[]): T[] {
  const output: T[] = [];
  for (const item of first) output.push(item);
  for (const item of second) output.push(item);
  return output;
}

export function concatSourceGroups(first: ResearchSource[] | undefined, second: ResearchSource[] | undefined, third: ResearchSource[]): ResearchSource[] {
  const output: ResearchSource[] = [];
  for (const source of first ?? []) output.push(source);
  for (const source of second ?? []) output.push(source);
  for (const source of third) output.push(source);
  return output;
}

export function withSourceBundle(source: ResearchSource, executionBundleId: string): ResearchSource {
  return {
    ...source,
    metadata: { ...source.metadata, executionBundleId }
  };
}

export function withEvidenceBundle(evidence: EvidenceItem, executionBundleId: string): EvidenceItem {
  return {
    ...evidence,
    metadata: { ...(evidence.metadata ?? {}), executionBundleId }
  };
}

export function withArtifactBundle(artifact: ResearchArtifact, executionBundleId: string): ResearchArtifact {
  return {
    ...artifact,
    metadata: { ...(artifact.metadata ?? {}), executionBundleId }
  };
}

function withOpenCodeStructuredBundle<T extends { metadata?: Record<string, unknown> }>(value: T, executionBundleId: string): T {
  return {
    ...value,
    metadata: { ...(value.metadata ?? {}), executionBundleId }
  };
}

function appendBundleToUnknown(value: unknown, executionBundleId: string): unknown {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return { ...(value as Record<string, unknown>), executionBundleId };
  }
  return { value, executionBundleId };
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
