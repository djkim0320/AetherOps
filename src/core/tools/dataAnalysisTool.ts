import { createId, nowIso } from "../shared/ids.js";
import type { OpenCodeRunInput, ToolRun } from "../shared/types.js";
import type { ResearchTool, ResearchToolResult } from "./researchToolTypes.js";

export class DataAnalysisTool implements ResearchTool {
  name = "DataAnalysisTool";

  async run(input: OpenCodeRunInput): Promise<ResearchToolResult> {
    const startedAt = nowIso();
    const completedAt = nowIso();
    const evidence = input.evidence ?? [];
    const normalizedRecords = input.normalizedRecords ?? [];
    const validationResults = input.validationResults ?? [];
    const projectContextSnapshots = input.projectContextSnapshots ?? [];
    const synthesizedResults = input.results ?? [];
    const missingInputWarnings: string[] = [];

    if (normalizedRecords.length === 0) missingInputWarnings.push("normalizedRecords input was not available; support eligibility may be undercounted.");
    if (validationResults.length === 0) missingInputWarnings.push("validationResults input was not available; latest evidence gaps may be incomplete.");
    if (projectContextSnapshots.length === 0)
      missingInputWarnings.push("projectContextSnapshots input was not available; context coverage analysis may be incomplete.");

    const supportEligibleEvidenceIds = new Set<string>();
    const sourceQualityDistribution: Record<string, number> = {};
    const traceabilityKindDistribution: Record<string, number> = {};
    for (const record of normalizedRecords) {
      const sourceQualityTier = stringMetadataOrDefault(record.metadata.sourceQualityTier, "unknown");
      incrementCount(traceabilityKindDistribution, stringMetadataOrDefault(record.metadata.traceabilityKind, "unknown"));
      if (
        record.kind === "evidence" &&
        record.evidenceId &&
        record.metadata.canSupportHypothesis === true &&
        sourceQualityTier !== "weak" &&
        sourceQualityTier !== "excluded" &&
        sourceQualityTier !== "general_web" &&
        (record.metadata.traceabilityKind === "external_source" || record.metadata.traceabilityKind === "tool_observation")
      ) {
        supportEligibleEvidenceIds.add(record.evidenceId);
      }
    }

    let citedEvidenceCount = 0;
    const linkedEvidenceCoverage = new Map<string, { linkedEvidenceCount: number; supportEligibleEvidenceCount: number }>();
    for (const item of evidence) {
      if (item.citation || item.quote || item.sourceUri) citedEvidenceCount += 1;
      incrementCount(sourceQualityDistribution, sourceQualityKeyword(item.keywords));
      for (const hypothesisId of item.linkedHypothesisIds) {
        const coverage = linkedEvidenceCoverage.get(hypothesisId) ?? { linkedEvidenceCount: 0, supportEligibleEvidenceCount: 0 };
        coverage.linkedEvidenceCount += 1;
        if (item.id && supportEligibleEvidenceIds.has(item.id)) coverage.supportEligibleEvidenceCount += 1;
        linkedEvidenceCoverage.set(hypothesisId, coverage);
      }
    }

    const validationStatusDistribution: Record<string, number> = {};
    let latestIteration = 0;
    for (const result of validationResults) {
      if (result.iteration > latestIteration) latestIteration = result.iteration;
    }
    const latestEvidenceGaps = new Set<string>();
    for (const result of validationResults) {
      incrementCount(validationStatusDistribution, result.status);
      if (latestIteration && result.iteration === latestIteration) {
        for (const gap of result.evidenceGaps) latestEvidenceGaps.add(gap);
      }
    }

    const output = {
      evidenceCount: evidence.length,
      supportEligibleEvidenceCount: supportEligibleEvidenceIds.size,
      citationCoverage: evidence.length ? citedEvidenceCount / evidence.length : 0,
      sourceQualityDistribution,
      traceabilityKindDistribution,
      hypothesisEvidenceCoverage: hypothesisEvidenceCoverage(input, linkedEvidenceCoverage),
      validationStatusDistribution,
      iterationGrowthSummary: {
        iteration: input.iteration,
        evidenceCount: evidence.length,
        artifactCount: input.artifacts?.length ?? 0,
        sourceCount: input.sources?.length ?? 0,
        toolRunCount: input.toolRuns?.length ?? 0,
        normalizedRecordCount: normalizedRecords.length,
        validationResultCount: validationResults.length,
        projectContextSnapshotCount: projectContextSnapshots.length,
        synthesizedResultCount: synthesizedResults.length
      },
      inputAvailability: {
        normalizedRecordCount: normalizedRecords.length,
        validationResultCount: validationResults.length,
        projectContextSnapshotCount: projectContextSnapshots.length,
        resultCount: synthesizedResults.length
      },
      missingInputWarnings,
      evidenceGapsFromLatestValidation: setToArray(latestEvidenceGaps)
    };

    return {
      toolRun: completedToolRun(input, this.name, startedAt, completedAt, { iteration: input.iteration }, output),
      evidence: [],
      artifacts: [],
      sources: []
    };
  }
}

function completedToolRun(input: OpenCodeRunInput, toolName: string, startedAt: string, completedAt: string, toolInput: unknown, output: unknown): ToolRun {
  return {
    id: createId("tool"),
    projectId: input.project.id,
    iteration: input.iteration,
    toolName,
    input: toolInput,
    output,
    status: "completed",
    startedAt,
    completedAt
  };
}

function hypothesisEvidenceCoverage(
  input: OpenCodeRunInput,
  linkedEvidenceCoverage: Map<string, { linkedEvidenceCount: number; supportEligibleEvidenceCount: number }>
): Record<string, { linkedEvidenceCount: number; supportEligibleEvidenceCount: number }> {
  const coverage: Record<string, { linkedEvidenceCount: number; supportEligibleEvidenceCount: number }> = {};
  for (const hypothesis of input.hypotheses) {
    coverage[hypothesis.id] = linkedEvidenceCoverage.get(hypothesis.id) ?? { linkedEvidenceCount: 0, supportEligibleEvidenceCount: 0 };
  }
  return coverage;
}

function setToArray<T>(items: Set<T>): T[] {
  const values: T[] = [];
  for (const item of items) values.push(item);
  return values;
}

function incrementCount(counts: Record<string, number>, value: string): void {
  counts[value] = (counts[value] ?? 0) + 1;
}

function sourceQualityKeyword(keywords: string[]): string {
  for (const keyword of keywords) {
    if (
      keyword === "scholarly" ||
      keyword === "official" ||
      keyword === "institutional" ||
      keyword === "general_web" ||
      keyword === "weak" ||
      keyword === "excluded"
    ) {
      return keyword;
    }
  }
  return "unknown";
}

function stringMetadataOrDefault(value: unknown, defaultValue: string): string {
  return typeof value === "string" && value.trim() ? value : defaultValue;
}
