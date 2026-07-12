import { describe, expect, it } from "vitest";
import { buildResearchReport } from "./report.js";
import { ResearchLoopStep, type EvidenceBasedResult, type ResearchSnapshot, type ValidationResult } from "../shared/types.js";

const createdAt = "2026-06-27T00:00:00.000Z";

describe("buildResearchReport evidence scorecards", () => {
  it("renders claim scorecard lines when validation results include them", () => {
    const report = buildResearchReport(snapshot([validationWithScorecard()]));

    expect(report.comprehensiveReport).toContain(
      "Claim score: supported; correctness=supported; citation=faithful; claim=Frequent short breaks reduce fatigue."
    );
  });

  it("keeps rendering legacy validation results without claim scorecards", () => {
    const report = buildResearchReport(snapshot([{ ...validationWithScorecard(), id: "validation-legacy", claimScorecard: undefined }]));

    expect(report.comprehensiveReport).toContain("Fixture validation summary.");
    expect(report.comprehensiveReport).not.toContain("Claim score:");
  });

  it("renders the final result evidence scorecard", () => {
    const report = buildResearchReport(snapshot([validationWithScorecard()], [resultWithScorecard()]));

    expect(report.comprehensiveReport).toContain("# Evidence Claim Scorecard");
    expect(report.comprehensiveReport).toContain("Claims: 1; supported=1");
    expect(report.comprehensiveReport).toContain(
      "Final claim score: supported; correctness=supported; citation=faithful; claim=Frequent short breaks reduce fatigue."
    );
    expect(report.comprehensiveReport).toContain("Evidence: e1");
  });

  it("labels current Codex CLI runs separately from archived executor history", () => {
    const current = snapshot([]);
    current.toolRuns.push({
      id: "tool-codex",
      projectId: current.project.id,
      iteration: 1,
      toolName: "CodexCliTool",
      input: {},
      output: {},
      status: "completed",
      startedAt: createdAt,
      completedAt: createdAt
    });
    current.legacyAgentRuns.push({
      id: "legacy-run",
      projectId: current.project.id,
      iteration: 1,
      prompt: "archived",
      status: "completed",
      toolPlan: ["legacy-tool"],
      logs: [],
      artifactIds: [],
      evidenceIds: [],
      startedAt: createdAt,
      completedAt: createdAt
    });

    const report = buildResearchReport(current);
    expect(report.comprehensiveReport).toContain("## Codex CLI run tool-codex");
    expect(report.comprehensiveReport).toContain("## Archived legacy executor run legacy-run");
    expect(report.comprehensiveReport).not.toContain("# OpenCode");
  });
});

function snapshot(validationResults: ValidationResult[], results: EvidenceBasedResult[] = []): ResearchSnapshot {
  return {
    project: {
      id: "project-report",
      goal: "Render scorecard report.",
      topic: "Evidence scorecard",
      scope: "Report test",
      budget: "5 minutes",
      autonomyPolicy: { toolApproval: "suggested", allowExternalSearch: false, allowCodeExecution: false },
      createdAt,
      updatedAt: createdAt,
      currentStep: ResearchLoopStep.FinalizeOutputs,
      status: "completed",
      projectRoot: ".aetherops/test"
    },
    sessions: [],
    database: undefined,
    researchInputs: [],
    questions: [{ id: "q1", projectId: "project-report", text: "Do short breaks reduce fatigue?", status: "open", createdAt }],
    hypotheses: [
      {
        id: "h1",
        projectId: "project-report",
        questionId: "q1",
        statement: "Frequent short breaks reduce fatigue.",
        status: "supported",
        confidence: 0.8,
        createdAt
      }
    ],
    evidence: [],
    artifacts: [],
    sources: [],
    chunks: [],
    toolRuns: [],
    agentPlans: [],
    researchPlans: [],
    specifications: [],
    normalizedRecords: [],
    ontologyEntities: [],
    ontologyRelations: [],
    ontologyConstraints: [],
    projectContextSnapshots: [],
    hybridContexts: [],
    validationResults,
    continuationDecisions: [],
    finalOutputs: [],
    runAuditOutputs: [],
    benchmarkPlans: [],
    globalMemoryItems: [],
    runtimeBlockers: [],
    stepErrors: [],
    legacyAgentRuns: [],
    ragContexts: [],
    results,
    iterations: []
  };
}

function validationWithScorecard(): ValidationResult {
  return {
    id: "validation-scorecard",
    projectId: "project-report",
    iteration: 1,
    hypothesisId: "h1",
    status: "supported",
    confidence: 0.82,
    supportingEvidenceIds: ["e1"],
    contradictingEvidenceIds: [],
    relatedEntityIds: [],
    relatedRelationIds: [],
    reasoningSummary: "Fixture validation summary.",
    limitations: [],
    evidenceGaps: [],
    claimScorecard: {
      claimCount: 1,
      statusCounts: {
        supported: 1,
        missing_evidence: 0,
        contradicted: 0,
        attribution_unfaithful: 0,
        unknown: 0
      },
      claims: [
        {
          id: "claim-score-1",
          claim: "Frequent short breaks reduce fatigue.",
          hypothesisId: "h1",
          status: "supported",
          correctness: {
            status: "supported",
            confidence: 0.82,
            supportingEvidenceIds: ["e1"],
            contradictingEvidenceIds: [],
            rationale: "Fixture support."
          },
          citationFaithfulness: {
            status: "faithful",
            citedEvidenceIds: ["e1"],
            faithfulEvidenceIds: ["e1"],
            unfaithfulEvidenceIds: [],
            rationale: "Fixture citation support."
          },
          evidenceGaps: []
        }
      ]
    },
    createdAt
  };
}

function resultWithScorecard(): EvidenceBasedResult {
  return {
    id: "result-scorecard",
    projectId: "project-report",
    iteration: 1,
    answer: "Frequent short breaks reduce fatigue.",
    hypothesisUpdates: [],
    quantitativeResults: [],
    qualitativeResults: [],
    nextQuestions: [],
    needsMoreEvidence: false,
    needsMoreAnalysis: false,
    validationResultIds: ["validation-scorecard"],
    hybridContextId: "hybrid-1",
    evidenceScorecard: validationWithScorecard().claimScorecard,
    createdAt
  };
}
