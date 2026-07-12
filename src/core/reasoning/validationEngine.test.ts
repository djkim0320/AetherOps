import { describe, expect, it } from "vitest";
import {
  ResearchLoopStep,
  type EvidenceBasedResult,
  type EvidenceItem,
  type HybridContext,
  type NormalizedResearchRecord,
  type OntologyRelation,
  type ResearchSnapshot,
  type ToolRun
} from "../shared/types.js";
import { extractAtomicClaimsFromResult, scoreFinalResultClaims } from "./evidenceScorecard.js";
import type { ReasoningSummary } from "./reasoningEngine.js";
import { ResultSynthesizer } from "./resultSynthesizer.js";
import { ValidationEngine } from "./validationEngine.js";

const createdAt = "2026-06-27T00:00:00.000Z";
const projectId = "project-scorecard";
const hypothesisId = "h1";

describe("ValidationEngine evidence scorecard", () => {
  it("marks a claim supported only when citation-faithful support evidence exists", () => {
    const support = evidence("e-support", "A controlled study directly supports the claim.");
    const result = validateOne({
      evidence: [support],
      normalizedRecords: [supportRecord("r-support", support.id, true)],
      ontologyRelations: [relation("rel-support", support.id, "supports")],
      reasoning: reasoning({ supportingEvidenceIds: [support.id] })
    });

    expect(result.status).toBe("supported");
    expect(result.claimScorecard?.claims[0]).toMatchObject({
      status: "supported",
      correctness: {
        status: "supported",
        supportingEvidenceIds: [support.id]
      },
      citationFaithfulness: {
        status: "faithful",
        faithfulEvidenceIds: [support.id],
        unfaithfulEvidenceIds: []
      }
    });
  });

  it("marks a claim missing_evidence when no evidence is available", () => {
    const result = validateOne({
      evidence: [],
      normalizedRecords: [],
      ontologyRelations: [],
      reasoning: reasoning()
    });

    expect(result.status).toBe("not_tested");
    expect(result.claimScorecard?.claims[0]?.status).toBe("missing_evidence");
    expect(result.claimScorecard?.claims[0]?.correctness.status).toBe("insufficient");
    expect(result.claimScorecard?.claims[0]?.citationFaithfulness.status).toBe("missing");
    expect(result.evidenceGaps).toContain("No citation-faithful support evidence was found for this claim.");
  });

  it("marks a claim contradicted when contradiction evidence is support-eligible", () => {
    const contradiction = evidence("e-contradict", "A controlled study contradicts the claim.");
    const result = validateOne({
      evidence: [contradiction],
      normalizedRecords: [supportRecord("r-contradict", contradiction.id, true)],
      ontologyRelations: [relation("rel-contradict", contradiction.id, "contradicts")],
      reasoning: reasoning({ contradictingEvidenceIds: [contradiction.id] })
    });

    expect(result.status).toBe("contradicted");
    expect(result.claimScorecard?.claims[0]).toMatchObject({
      status: "contradicted",
      correctness: {
        status: "contradicted",
        contradictingEvidenceIds: [contradiction.id]
      },
      citationFaithfulness: {
        status: "faithful",
        faithfulEvidenceIds: [contradiction.id]
      }
    });
  });

  it("marks a cited but non-supporting source as attribution_unfaithful instead of supported", () => {
    const ineligible = evidence("e-unfaithful", "This citation is related but does not support the claim.");
    const result = validateOne({
      evidence: [ineligible],
      normalizedRecords: [supportRecord("r-unfaithful", ineligible.id, false)],
      ontologyRelations: [relation("rel-unfaithful", ineligible.id, "mentions")],
      reasoning: reasoning({ supportingEvidenceIds: [ineligible.id] })
    });

    expect(result.status).not.toBe("supported");
    expect(result.status).toBe("inconclusive");
    expect(result.claimScorecard?.statusCounts.attribution_unfaithful).toBe(1);
    expect(result.claimScorecard?.claims[0]).toMatchObject({
      status: "attribution_unfaithful",
      correctness: {
        status: "insufficient",
        supportingEvidenceIds: []
      },
      citationFaithfulness: {
        status: "unfaithful",
        unfaithfulEvidenceIds: [ineligible.id]
      }
    });
    expect(result.evidenceGaps).toContain("At least one cited evidence item was not eligible to support the claim.");
  });

  it("records unknown claim assessment when malformed tool output is already a failed tool run", () => {
    const result = validateOne({
      evidence: [],
      normalizedRecords: [],
      ontologyRelations: [],
      toolRuns: [
        {
          id: "tool-malformed",
          projectId,
          iteration: 1,
          toolName: "MalformedTool",
          input: {},
          output: { failureKind: "malformed_tool_result", evidenceFailure: true },
          status: "failed",
          error: "result must be an object",
          startedAt: createdAt,
          completedAt: createdAt
        }
      ],
      reasoning: reasoning()
    });

    expect(result.claimScorecard?.claims[0]).toMatchObject({
      status: "unknown",
      correctness: { status: "unknown" },
      citationFaithfulness: { status: "missing" }
    });
    expect(result.evidenceGaps.join("\n")).toContain("Tool failure prevented claim assessment: MalformedTool: result must be an object");
  });

  it("aggregates validation scorecards into the synthesized research result", () => {
    const support = evidence("e-support", "A controlled study directly supports the claim.");
    const contradiction = evidence("e-contradict", "A controlled study contradicts a second claim.");
    const secondHypothesisId = "h2";
    const snapshot = baseSnapshot({
      evidence: [
        { ...support, linkedHypothesisIds: [hypothesisId] },
        { ...contradiction, linkedHypothesisIds: [secondHypothesisId] }
      ],
      normalizedRecords: [supportRecord("r-support", support.id, true), supportRecord("r-contradict", contradiction.id, true)],
      ontologyRelations: [relation("rel-support", support.id, "supports"), relation("rel-contradict", contradiction.id, "contradicts")],
      extraHypotheses: [
        {
          id: secondHypothesisId,
          projectId,
          questionId: "q1",
          statement: "Long sessions always reduce fatigue.",
          status: "untested",
          confidence: 0.35,
          createdAt
        }
      ]
    });
    const hybridContext = contextFor([support.id, contradiction.id]);
    const validationResults = new ValidationEngine().validate(snapshot, hybridContext, [
      reasoning({ supportingEvidenceIds: [support.id] }),
      reasoning({
        hypothesisId: secondHypothesisId,
        claim: "Long sessions always reduce fatigue.",
        contradictingEvidenceIds: [contradiction.id]
      })
    ]);

    const result = new ResultSynthesizer().synthesize({ snapshot, hybridContext, validationResults });

    expect(result.validationResultIds).toEqual(validationResults.map((validation) => validation.id));
    expect(result.evidenceScorecard).toMatchObject({
      claimCount: 2,
      statusCounts: {
        supported: 1,
        missing_evidence: 0,
        contradicted: 1,
        attribution_unfaithful: 0,
        unknown: 0
      }
    });
    expect(result.evidenceScorecard?.claims[0]?.claim).toBe("Frequent short breaks reduce fatigue.");
    expect(result.evidenceScorecard?.claims[1]).toMatchObject({
      claim: "Long sessions always reduce fatigue.",
      hypothesisId: secondHypothesisId,
      status: "contradicted"
    });
  });

  it("scores atomic claims extracted from final result text", () => {
    const support = evidence("e-support", "A controlled study directly supports frequent short breaks reduce fatigue.");
    const snapshot = baseSnapshot({
      evidence: [support],
      normalizedRecords: [supportRecord("r-support", support.id, true)],
      ontologyRelations: [relation("rel-support", support.id, "supports")]
    });
    const hybridContext = contextFor([support.id]);
    const result = resultFixture({
      answer: "Frequent short breaks reduce fatigue. Productivity gains improve outcomes.",
      quantitativeResults: ["Evidence items: 1"],
      qualitativeResults: ["Citations preserved: https://example.edu/e-support"]
    });

    expect(extractAtomicClaimsFromResult(result)).toEqual(["Frequent short breaks reduce fatigue.", "Productivity gains improve outcomes."]);

    const scorecard = scoreFinalResultClaims({ snapshot, hybridContext, validationResults: [], result });

    expect(scorecard).toMatchObject({
      claimCount: 2,
      statusCounts: {
        supported: 1,
        missing_evidence: 1,
        contradicted: 0,
        attribution_unfaithful: 0,
        unknown: 0
      }
    });
    expect(scorecard?.claims[0]).toMatchObject({
      claim: "Frequent short breaks reduce fatigue.",
      status: "supported",
      correctness: { supportingEvidenceIds: [support.id] },
      citationFaithfulness: { faithfulEvidenceIds: [support.id] }
    });
    expect(scorecard?.claims[1]).toMatchObject({
      claim: "Productivity gains improve outcomes.",
      status: "missing_evidence",
      correctness: { status: "insufficient" },
      citationFaithfulness: { status: "missing" }
    });
  });
});

function validateOne(input: {
  evidence: EvidenceItem[];
  normalizedRecords: NormalizedResearchRecord[];
  ontologyRelations: OntologyRelation[];
  reasoning: ReasoningSummary;
  toolRuns?: ToolRun[];
}): ReturnType<ValidationEngine["validate"]>[number] {
  const snapshot = baseSnapshot(input);
  const hybridContext = contextFor(input.evidence.map((item) => item.id));
  const result = new ValidationEngine().validate(snapshot, hybridContext, [input.reasoning])[0];
  if (!result) throw new Error("Expected a validation result.");
  return result;
}

function baseSnapshot(
  overrides: {
    evidence?: EvidenceItem[];
    normalizedRecords?: NormalizedResearchRecord[];
    ontologyRelations?: OntologyRelation[];
    toolRuns?: ToolRun[];
    extraHypotheses?: ResearchSnapshot["hypotheses"];
  } = {}
): ResearchSnapshot {
  const hypotheses = [
    {
      id: hypothesisId,
      projectId,
      questionId: "q1",
      statement: "Frequent short breaks reduce fatigue.",
      status: "untested" as const,
      confidence: 0.35,
      createdAt
    },
    ...(overrides.extraHypotheses ?? [])
  ];
  return {
    project: {
      id: projectId,
      goal: "Validate claim-level evidence.",
      topic: "Evidence scorecard",
      scope: "Unit test fixture",
      budget: "5 minutes",
      autonomyPolicy: { toolApproval: "suggested", allowExternalSearch: false, allowCodeExecution: false },
      createdAt,
      updatedAt: createdAt,
      currentStep: ResearchLoopStep.ReasonAndValidate,
      status: "running",
      projectRoot: ".aetherops/test"
    },
    sessions: [],
    database: undefined,
    researchInputs: [],
    questions: [{ id: "q1", projectId, text: "Do short breaks reduce fatigue?", status: "open", createdAt }],
    hypotheses,
    evidence: overrides.evidence ?? [],
    artifacts: [],
    sources: [],
    chunks: [],
    toolRuns: overrides.toolRuns ?? [],
    agentPlans: [],
    researchPlans: [],
    specifications: [],
    normalizedRecords: overrides.normalizedRecords ?? [],
    ontologyEntities: [],
    ontologyRelations: overrides.ontologyRelations ?? [],
    ontologyConstraints: [],
    projectContextSnapshots: [],
    hybridContexts: [],
    validationResults: [],
    continuationDecisions: [],
    finalOutputs: [],
    runAuditOutputs: [],
    benchmarkPlans: [],
    globalMemoryItems: [],
    runtimeBlockers: [],
    stepErrors: [],
    legacyAgentRuns: [],
    ragContexts: [],
    results: [],
    iterations: []
  };
}

function contextFor(evidenceIds: string[]): HybridContext {
  return {
    id: "hybrid-1",
    projectId,
    iteration: 1,
    query: "short breaks fatigue",
    vectorChunkIds: [],
    ontologyEntityIds: [],
    ontologyRelationIds: ["rel-support"],
    evidenceIds,
    artifactIds: [],
    citations: evidenceIds.map((id) => `https://example.edu/${id}`),
    vectorSummary: "Selected evidence by fixture.",
    graphSummary: "Selected relation by fixture.",
    contextText: "Fixture context.",
    retrievalScores: {},
    createdAt
  };
}

function evidence(id: string, summary: string): EvidenceItem {
  return {
    id,
    projectId,
    category: "web_source",
    title: id,
    summary,
    sourceId: `source-${id}`,
    sourceUri: `https://example.edu/${id}`,
    citation: `Example citation ${id}`,
    keywords: [],
    linkedHypothesisIds: [hypothesisId],
    reliabilityScore: 0.9,
    relevanceScore: 0.9,
    evidenceStrength: "strong",
    limitations: [],
    createdAt
  };
}

function supportRecord(id: string, evidenceId: string, canSupportHypothesis: boolean): NormalizedResearchRecord {
  return {
    id,
    projectId,
    memoryScope: "global",
    validationStatus: "normalized",
    iteration: 1,
    kind: "evidence",
    title: id,
    content: "Claim-level evidence fixture content.",
    sourceId: `source-${evidenceId}`,
    evidenceId,
    citation: `https://example.edu/${evidenceId}`,
    sourceUri: `https://example.edu/${evidenceId}`,
    metadata: {
      traceabilityKind: "external_source",
      sourceQualityTier: "scholarly",
      canSupportHypothesis
    },
    confidence: 0.9,
    createdAt
  };
}

function relation(id: string, evidenceId: string, predicate: OntologyRelation["predicate"]): OntologyRelation {
  return {
    id,
    projectId,
    memoryScope: "global",
    validationStatus: "graph_linked",
    subjectId: `entity-${evidenceId}`,
    predicate,
    objectId: hypothesisId,
    sourceRecordId: `record-${evidenceId}`,
    sourceEvidenceId: evidenceId,
    confidence: 0.9,
    createdAt
  };
}

function reasoning(overrides: Partial<ReasoningSummary> = {}): ReasoningSummary {
  return {
    hypothesisId,
    claim: "Frequent short breaks reduce fatigue.",
    supportingEvidenceIds: [],
    contradictingEvidenceIds: [],
    evidenceGaps: [],
    summary: "Fixture reasoning summary.",
    ...overrides
  };
}

function resultFixture(overrides: Partial<EvidenceBasedResult> = {}): EvidenceBasedResult {
  return {
    id: "result-fixture",
    projectId,
    iteration: 1,
    answer: "",
    hypothesisUpdates: [],
    quantitativeResults: [],
    qualitativeResults: [],
    nextQuestions: [],
    needsMoreEvidence: false,
    needsMoreAnalysis: false,
    createdAt,
    ...overrides
  };
}
