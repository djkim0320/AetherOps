import { describe, expect, it } from "vitest";
import { DataAnalysisTool } from "../../../src/core/tools/dataAnalysisTool.js";
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

    const result = await new DataAnalysisTool().run(input);

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
      iterationGrowthSummary: {
        iteration: 1,
        evidenceCount: 2,
        artifactCount: 1,
        sourceCount: 1,
        toolRunCount: 1,
        normalizedRecordCount: 2,
        validationResultCount: 1,
        projectContextSnapshotCount: 0,
        synthesizedResultCount: 0
      },
      inputAvailability: {
        normalizedRecordCount: 2,
        validationResultCount: 1,
        projectContextSnapshotCount: 0,
        resultCount: 0
      },
      missingInputWarnings: ["projectContextSnapshots input was not available; context coverage analysis may be incomplete."],
      evidenceGapsFromLatestValidation: ["Need a stronger source."]
    });
  });

  it("reports missing analysis inputs explicitly", async () => {
    const result = await new DataAnalysisTool().run({ ...runInput(["DataAnalysisTool"]), evidence: [] });

    expect(result.toolRun.output).toMatchObject({
      supportEligibleEvidenceCount: 0,
      inputAvailability: {
        normalizedRecordCount: 0,
        validationResultCount: 0,
        projectContextSnapshotCount: 0
      },
      missingInputWarnings: expect.arrayContaining([
        "normalizedRecords input was not available; support eligibility may be undercounted.",
        "validationResults input was not available; latest evidence gaps may be incomplete."
      ])
    });
  });
});
