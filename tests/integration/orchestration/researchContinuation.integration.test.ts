import { describe, expect, it } from "vitest";
import { EvidenceNormalizer } from "../../../src/core/evidence/evidenceNormalizer.js";
import { MemoryPromotionEngine } from "../../../src/core/memory/memoryPromotion.js";
import { LoopDecisionEngine } from "../../../src/core/planning/loopDecision.js";
import { WebSearchTool } from "../../../src/server/runtime/tools/webSearchTool.js";
import { createdAt, settings, snapshot } from "./researchArchitecture.integration.support.js";

describe("Research continuation and memory architecture", () => {
  it("adds a WebFetch revision hint only when selected context has external source candidates without evidence", () => {
    const base = snapshot();
    const result = {
      id: "result-fetch-hint",
      projectId: base.project.id,
      iteration: 1,
      answer: "Source candidates require fetch.",
      hypothesisUpdates: [],
      quantitativeResults: [],
      qualitativeResults: [],
      nextQuestions: [],
      needsMoreEvidence: false,
      needsMoreAnalysis: false,
      ragContextId: undefined,
      createdAt
    };
    const decision = new LoopDecisionEngine().decide({
      snapshot: {
        ...base,
        projectContextSnapshots: [
          {
            id: "context-fetch",
            projectId: base.project.id,
            iteration: 1,
            query: "Pomodoro",
            selectedRecordIds: [],
            selectedSourceIds: ["s1"],
            selectedEvidenceIds: [],
            selectedChunkIds: [],
            selectedEntityIds: [],
            selectedRelationIds: [],
            citations: ["https://arxiv.org/abs/2401.00001"],
            selectionReason: "external source candidate",
            createdAt
          }
        ]
      },
      result,
      iteration: 1,
      safetyCapIterations: 3,
      beforeCounts: { evidence: base.evidence.length, artifacts: base.artifacts.length, chunks: 0, entities: 0, relations: 0 }
    });

    expect(decision.shouldContinue).toBe(true);
    expect(decision.evidenceGaps).toContain("Source candidates found but not fetched into citation-backed evidence");
    expect(decision.planRevisionHints).toContain("Use WebFetchTool to fetch selected source URLs from previous ProjectContextSnapshot.");
    expect(decision.projectContextSnapshotId).toBe("context-fetch");
    expect(decision.selectedSourceIds).toContain("s1");
    expect(decision.selectedCitationUrls).toContain("https://arxiv.org/abs/2401.00001");
    expect(decision.fetchCandidateUrls).toContain("https://arxiv.org/abs/2401.00001");
  });

  it("uses DataAnalysisTool output as a conservative loop decision signal without overriding the safety cap", () => {
    const base = snapshot();
    const result = {
      id: "result-analysis-signal",
      projectId: base.project.id,
      iteration: 1,
      answer: "No further work requested by synthesizer.",
      hypothesisUpdates: [],
      quantitativeResults: [],
      qualitativeResults: [],
      nextQuestions: [],
      needsMoreEvidence: false,
      needsMoreAnalysis: false,
      createdAt
    };
    const snapshotWithAnalysis = {
      ...base,
      toolRuns: [
        {
          id: "analysis-run",
          projectId: base.project.id,
          iteration: 1,
          toolName: "DataAnalysisTool",
          input: {},
          output: {
            supportEligibleEvidenceCount: 0,
            citationCoverage: 0.25,
            inputAvailability: {
              normalizedRecordCount: 2,
              validationResultCount: 1,
              projectContextSnapshotCount: 1
            },
            evidenceGapsFromLatestValidation: ["Need citation-backed source path."]
          },
          status: "completed" as const,
          startedAt: createdAt,
          completedAt: createdAt
        }
      ]
    };

    const decision = new LoopDecisionEngine().decide({
      snapshot: snapshotWithAnalysis,
      result,
      iteration: 1,
      safetyCapIterations: 3,
      beforeCounts: { evidence: base.evidence.length, artifacts: base.artifacts.length, chunks: 0, entities: 0, relations: 0 }
    });
    expect(decision.shouldContinue).toBe(false);
    expect(decision.evidenceGaps).toEqual(
      expect.arrayContaining([
        "Need citation-backed source path.",
        "DataAnalysisTool found no support-eligible citation-backed evidence.",
        "DataAnalysisTool reported low citation coverage (0.25)."
      ])
    );
    expect(decision.reason).toContain("DataAnalysisTool found no support-eligible evidence");

    const capped = new LoopDecisionEngine().decide({
      snapshot: snapshotWithAnalysis,
      result,
      iteration: 3,
      safetyCapIterations: 3,
      beforeCounts: { evidence: base.evidence.length, artifacts: base.artifacts.length, chunks: 0, entities: 0, relations: 0 }
    });
    expect(capped.shouldContinue).toBe(false);
    expect(capped.forceStop).toBe(true);
  });

  it("does not turn web search snippets or internal artifacts into support evidence", async () => {
    const base = snapshot();
    const tool = new WebSearchTool();
    (tool as unknown as { search: () => Promise<Array<{ title: string; url: string; snippet: string }>> }).search = async () => [
      { title: "Search only result", url: "https://example.edu/search-result", snippet: "Snippet is not verified evidence." }
    ];
    const result = await tool.run(
      {
        project: { ...base.project, autonomyPolicy: { ...base.project.autonomyPolicy, allowExternalSearch: true } },
        questions: base.questions,
        hypotheses: base.hypotheses,
        sources: base.sources,
        iteration: 1
      },
      { ...settings, allowExternalSearch: true, webSearch: { provider: "custom", apiKey: "test-key", endpoint: "https://example.test/search" } }
    );
    expect(result.sources).toHaveLength(1);
    expect(result.evidence).toHaveLength(0);

    const records = new EvidenceNormalizer().normalize({ ...base, artifacts: base.artifacts, evidence: [], sources: result.sources }, 1);
    expect(records.some((record) => record.kind === "evidence")).toBe(false);
    expect(records.some((record) => record.kind === "artifact" && record.metadata.canSupportHypothesis === false)).toBe(true);
  });

  it("normalizes OpenCode claims and observations without support evidence eligibility", () => {
    const base = snapshot();
    const records = new EvidenceNormalizer().normalize(
      {
        ...base,
        toolRuns: [
          {
            id: "tool-opencode-structured",
            projectId: base.project.id,
            iteration: 1,
            toolName: "OpenCodeStructuredOutput",
            input: {},
            output: {
              claims: [{ title: "OpenCode claim", content: "Claim text", sourceUri: "https://example.com/source" }],
              observations: [{ title: "OpenCode observation", content: "Observation text" }]
            },
            status: "completed",
            startedAt: createdAt,
            completedAt: createdAt
          }
        ]
      },
      1
    );

    const claim = records.find((record) => record.title === "OpenCode claim");
    const observation = records.find((record) => record.title === "OpenCode observation");
    expect(claim?.kind).toBe("claim");
    expect(observation?.kind).toBe("observation");
    expect(claim?.metadata.canSupportHypothesis).toBe(false);
    expect(observation?.metadata.canSupportHypothesis).toBe(false);
    expect(claim?.evidenceId).toBeUndefined();
    expect(observation?.evidenceId).toBeUndefined();
  });

  it("does not mark OpenCode source candidates as support-capable source evidence", () => {
    const base = snapshot();
    const records = new EvidenceNormalizer().normalize(
      {
        ...base,
        evidence: [],
        sources: [
          {
            id: "opencode-source-candidate",
            projectId: base.project.id,
            kind: "web",
            title: "OpenCode candidate only",
            url: "https://arxiv.org/abs/2401.00001",
            retrievedAt: createdAt,
            metadata: {
              sourceCandidateOnly: true,
              canSupportHypothesis: false,
              provider: "opencode"
            },
            createdAt
          }
        ]
      },
      1
    );

    const sourceRecord = records.find((record) => record.sourceId === "opencode-source-candidate" && record.kind === "source");
    expect(sourceRecord?.metadata.canSupportHypothesis).toBe(false);
    expect(sourceRecord?.validationStatus).toBe("raw");
  });

  it("promotes only validated citation-backed external evidence into global memory items", () => {
    const base = snapshot();
    const records = new EvidenceNormalizer()
      .normalize(base, 1)
      .map((record) => (record.evidenceId === "e1" && record.kind === "evidence" ? { ...record, validationStatus: "validated" as const } : record));
    const validation = {
      id: "validation-supported",
      projectId: base.project.id,
      iteration: 1,
      hypothesisId: "h1",
      status: "supported" as const,
      confidence: 0.8,
      supportingEvidenceIds: ["e1"],
      contradictingEvidenceIds: [],
      relatedEntityIds: [],
      relatedRelationIds: [],
      reasoningSummary: "External evidence supports the hypothesis.",
      limitations: [],
      evidenceGaps: [],
      createdAt
    };
    const promoted = new MemoryPromotionEngine().promote({ ...base, normalizedRecords: records, validationResults: [validation] });
    expect(promoted).toHaveLength(1);
    expect(promoted[0]?.supportingEvidenceIds).toContain("e1");

    const notPromoted = new MemoryPromotionEngine().promote({
      ...base,
      normalizedRecords: records,
      validationResults: [{ ...validation, id: "validation-gap", status: "inconclusive", supportingEvidenceIds: [] }]
    });
    expect(notPromoted).toHaveLength(0);
  });
});
