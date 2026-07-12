import type { EvidenceItem, ResearchArtifact, ResearchSource, ToolRun } from "../shared/types.js";

export function withToolRunBundle(toolRun: ToolRun, executionBundleId: string): ToolRun {
  return {
    ...toolRun,
    input: appendBundleToUnknown(toolRun.input, executionBundleId),
    output: appendBundleToUnknown(toolRun.output, executionBundleId)
  };
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

function appendBundleToUnknown(value: unknown, executionBundleId: string): unknown {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return { ...(value as Record<string, unknown>), executionBundleId };
  }
  return { value, executionBundleId };
}
