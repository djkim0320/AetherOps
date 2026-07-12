import { describe, expect, it } from "vitest";
import { DataAnalysisTool } from "../../../src/core/tools/dataAnalysisTool.js";
import type { ResearchToolExecutionContext } from "../../../src/core/tools/researchToolTypes.js";
import { createdAt, installToolRunnerTestCleanup, runInput, webSource } from "./toolRunner.integration.support.js";

installToolRunnerTestCleanup();

describe("DataAnalysisTool", () => {
  it("returns expanded distributions and does not create evidence", async () => {
    const input = {
      ...runInput(["DataAnalysisTool"]),
      evidence: [
        {
          id: "e1",
          projectId: "project-1",
          category: "web_source" as const,
          title: "Evidence 1",
          summary: "Summary",
          citation: "Citation",
          sourceUri: "https://example.edu/one",
          keywords: ["scholarly"],
          linkedHypothesisIds: ["h1"],
          createdAt
        },
        {
          id: "e2",
          projectId: "project-1",
          category: "web_source" as const,
          title: "Evidence 2",
          summary: "Summary",
          keywords: ["weak"],
          linkedHypothesisIds: [],
          createdAt
        }
      ],
      sources: [webSource("s1", "https://example.edu/one")],
      artifacts: [
        {
          id: "a1",
          projectId: "project-1",
          category: "generated_artifact" as const,
          title: "Artifact",
          relativePath: "artifact.md",
          mimeType: "text/markdown",
          summary: "Summary",
          createdAt
        }
      ],
      toolRuns: [
        {
          id: "tool-1",
          projectId: "project-1",
          iteration: 1,
          toolName: "WebFetchTool",
          input: {},
          output: {},
          status: "completed" as const,
          startedAt: createdAt,
          completedAt: createdAt
        }
      ],
      normalizedRecords: [
        {
          id: "r1",
          projectId: "project-1",
          memoryScope: "global" as const,
          validationStatus: "validated" as const,
          iteration: 1,
          kind: "evidence" as const,
          title: "Record 1",
          content: "Record content",
          evidenceId: "e1",
          metadata: { canSupportHypothesis: true, sourceQualityTier: "scholarly", traceabilityKind: "external_source" },
          createdAt
        },
        {
          id: "r2",
          projectId: "project-1",
          memoryScope: "project_only" as const,
          validationStatus: "rejected" as const,
          iteration: 1,
          kind: "artifact" as const,
          title: "Record 2",
          content: "Record content",
          metadata: { canSupportHypothesis: false, sourceQualityTier: "weak", traceabilityKind: "internal_artifact" },
          createdAt
        }
      ],
      validationResults: [
        {
          id: "v1",
          projectId: "project-1",
          iteration: 1,
          hypothesisId: "h1",
          status: "partially_supported" as const,
          confidence: 0.5,
          supportingEvidenceIds: ["e1"],
          contradictingEvidenceIds: [],
          relatedEntityIds: [],
          relatedRelationIds: [],
          reasoningSummary: "Partial support.",
          limitations: [],
          evidenceGaps: ["Need a stronger source."],
          createdAt
        }
      ]
    };

    const result = await new DataAnalysisTool().run(input, undefined, analysisContext());

    expect(result.evidence).toEqual([]);
    expect(result.sources).toEqual([]);
    expect(result.artifacts).toEqual([]);
    expect(result.toolRun.output).toMatchObject({
      evidenceCount: 2,
      supportEligibleEvidenceCount: 1,
      citationCoverage: 0.5,
      sourceQualityDistribution: { scholarly: 1, weak: 1 },
      traceabilityKindDistribution: { external_source: 1, internal_artifact: 1 },
      hypothesisEvidenceCoverage: { h1: { linkedEvidenceCount: 1, supportEligibleEvidenceCount: 1 } },
      validationStatusDistribution: { partially_supported: 1 },
      inputAvailability: {
        normalizedRecordCount: 2,
        validationResultCount: 1,
        projectContextSnapshotCount: 0,
        resultCount: 0
      },
      evidenceGaps: expect.arrayContaining(["Need a stronger source."])
    });
  });

  it("reports missing analysis inputs explicitly", async () => {
    const result = await new DataAnalysisTool().run({ ...runInput(["DataAnalysisTool"]), evidence: [] }, undefined, analysisContext());

    expect(result.toolRun.output).toMatchObject({
      supportEligibleEvidenceCount: 0,
      inputAvailability: {
        normalizedRecordCount: 0,
        validationResultCount: 0,
        projectContextSnapshotCount: 0
      },
      checkAssessments: expect.arrayContaining([expect.objectContaining({ check: "evidence_coverage", status: "unverifiable" })])
    });
  });
});

function analysisContext(): ResearchToolExecutionContext {
  return {
    signal: new AbortController().signal,
    attemptId: "attempt-analysis",
    decisionId: "decision-analysis",
    ordinal: 0,
    phase: "analysis",
    inputs: { checks: ["evidence_coverage", "hypothesis_coverage"] }
  };
}
