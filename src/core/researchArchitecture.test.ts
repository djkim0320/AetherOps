import { describe, expect, it } from "vitest";
import { LocalHashEmbeddingProvider } from "./embeddingProvider.js";
import { EvidenceNormalizer } from "./evidenceNormalizer.js";
import { HybridRetrievalEngine } from "./hybridRetrievalEngine.js";
import { LoopDecisionEngine } from "./loopDecision.js";
import { OntologyGraphEngine } from "./ontologyGraphEngine.js";
import { ReasoningEngine } from "./reasoningEngine.js";
import { ResearchPlanner } from "./researchPlanner.js";
import { ResearchSpecificationBuilder } from "./researchSpecification.js";
import { ResultSynthesizer } from "./resultSynthesizer.js";
import { ValidationEngine } from "./validationEngine.js";
import { VectorIndexEngine } from "./vectorIndexEngine.js";
import { ResearchLoopStep, type AppSettings, type ResearchSnapshot } from "./types.js";

const createdAt = "2026-05-20T00:00:00.000Z";
const settings: AppSettings = {
  openCodeLlm: { source: "codex-oauth", model: "gpt-5.5" },
  openCode: { enabled: false, command: "opencode", provider: "openai", model: "gpt-5.5", timeoutMs: 180_000 },
  webSearch: { provider: "disabled" },
  embedding: { provider: "local", model: "local-hash", dimensions: 64 },
  allowExternalSearch: false,
  allowCodeExecution: false,
  maxLoopIterations: 2,
  ontologyExtractionMode: "rule_based",
  finalOutputExport: { markdown: true, json: true, ontologyGraph: true, artifactPackage: true },
  updatedAt: createdAt
};

function snapshot(): ResearchSnapshot {
  return {
    project: {
      id: "project-1",
      goal: "Compare Pomodoro 25/5 and 50/10 for a two-hour study session.",
      topic: "Pomodoro 25/5 vs 50/10",
      scope: "focus fatigue completion",
      budget: "30 minutes",
      autonomyPolicy: { toolApproval: "suggested", maxLoopIterations: 2, allowExternalSearch: false, allowCodeExecution: false },
      createdAt,
      updatedAt: createdAt,
      currentStep: ResearchLoopStep.CreateResearchDb,
      status: "running",
      projectRoot: ".aetherops/test"
    },
    sessions: [],
    questions: [
      { id: "q1", projectId: "project-1", text: "Which method sustains focus better?", status: "open", createdAt },
      { id: "q2", projectId: "project-1", text: "Which method reduces fatigue?", status: "open", createdAt },
      { id: "q3", projectId: "project-1", text: "Which method improves task completion?", status: "open", createdAt }
    ],
    hypotheses: [
      { id: "h1", projectId: "project-1", questionId: "q1", statement: "25/5 may reduce fatigue.", status: "untested", confidence: 0.35, createdAt },
      { id: "h2", projectId: "project-1", questionId: "q3", statement: "50/10 may improve deep work.", status: "untested", confidence: 0.35, createdAt }
    ],
    evidence: [
      {
        id: "e1",
        projectId: "project-1",
        category: "web_source",
        title: "Study break observation",
        summary: "Frequent short breaks may help fatigue management during studying.",
        sourceId: "s1",
        sourceUri: "https://example.com/study-breaks",
        citation: "Example Study Breaks",
        keywords: ["pomodoro", "breaks", "fatigue"],
        linkedHypothesisIds: ["h1"],
        reliabilityScore: 0.7,
        relevanceScore: 0.8,
        evidenceStrength: "strong",
        limitations: [],
        createdAt
      },
      {
        id: "gap1",
        projectId: "project-1",
        category: "experiment_log",
        title: "Search unavailable",
        summary: "External search is disabled.",
        keywords: ["evidence_gap", "tool_unavailable"],
        linkedHypothesisIds: ["h2"],
        reliabilityScore: 0.1,
        relevanceScore: 0.3,
        evidenceStrength: "weak",
        limitations: ["Gap log only."],
        createdAt
      }
    ],
    artifacts: [
      {
        id: "a1",
        projectId: "project-1",
        category: "generated_artifact",
        title: "Mini experiment design",
        relativePath: "artifacts/iteration-1/design.md",
        mimeType: "text/markdown",
        summary: "A mini experiment design for comparing 25/5 and 50/10.",
        content: "Measure focus, fatigue, and completion for Pomodoro 25/5 and 50/10.",
        createdAt
      }
    ],
    sources: [
      { id: "s1", projectId: "project-1", kind: "web", title: "Study break observation", url: "https://example.com/study-breaks", retrievedAt: createdAt, metadata: {}, createdAt }
    ],
    chunks: [],
    toolRuns: [],
    agentPlans: [],
    researchPlans: [],
    specifications: [],
    normalizedRecords: [],
    ontologyEntities: [],
    ontologyRelations: [],
    ontologyConstraints: [],
    hybridContexts: [],
    validationResults: [],
    continuationDecisions: [],
    finalOutputs: [],
    openCodeRuns: [],
    ragContexts: [],
    results: [],
    iterations: []
  };
}

describe("12-step research architecture modules", () => {
  it("builds specification and plan from project questions and hypotheses", async () => {
    const base = snapshot();
    const spec = await new ResearchSpecificationBuilder().build({
      project: base.project,
      questions: base.questions,
      hypotheses: base.hypotheses,
      evidence: base.evidence
    });
    expect(spec.researchQuestions.length).toBeGreaterThanOrEqual(3);
    expect(spec.refinedHypotheses.length).toBeGreaterThanOrEqual(2);
    expect(spec.competencyQuestions.length).toBeGreaterThan(0);
    expect(spec.requiredEvidenceTypes.length).toBeGreaterThan(0);
    expect(spec.successCriteria.length).toBeGreaterThan(0);

    const plan = await new ResearchPlanner().plan({ snapshot: base, specification: spec, iteration: 1, settings });
    expect(plan.iteration).toBe(1);
    expect(plan.objective).toBeTruthy();
    expect(plan.requiredTools.length).toBeGreaterThan(0);
    expect(plan.expectedSources.length).toBeGreaterThan(0);
    expect(plan.stopCriteria.length).toBeGreaterThan(0);
  });

  it("normalizes, indexes, builds ontology, retrieves hybrid context, validates, and decides continuation", async () => {
    const base = snapshot();
    const records = new EvidenceNormalizer().normalize(base, 1);
    expect(records.map((record) => record.kind)).toEqual(expect.arrayContaining(["source", "artifact", "claim", "evidence", "observation", "citation"]));
    expect(records.find((record) => record.evidenceId === "gap1")?.confidence).toBeLessThan(0.5);

    const provider = new LocalHashEmbeddingProvider(64);
    const chunks = await new VectorIndexEngine(provider).buildIndex({ snapshot: base, records, settings });
    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks[0]?.embedding?.length).toBe(64);

    const withIndex = { ...base, normalizedRecords: records, chunks };
    const graph = new OntologyGraphEngine().build({ snapshot: withIndex, records });
    expect(graph.entities.length).toBeGreaterThan(0);
    expect(graph.relations.some((relation) => relation.predicate === "supports")).toBe(true);
    expect(graph.entities.some((entity) => entity.type === "Concept")).toBe(true);
    expect(graph.entities.some((entity) => entity.type === "Parameter")).toBe(true);
    expect(graph.relations.some((relation) => relation.predicate === "generatedBy")).toBe(true);
    expect(graph.relations.some((relation) => relation.predicate === "hasLimitation")).toBe(true);
    expect(graph.relations.some((relation) => relation.predicate === "measuredIn")).toBe(true);

    const withGraph = { ...withIndex, ontologyEntities: graph.entities, ontologyRelations: graph.relations, ontologyConstraints: graph.constraints };
    const hybrid = await new HybridRetrievalEngine(provider).buildContext(withGraph, "Pomodoro fatigue evidence", 1);
    expect(hybrid.vectorChunkIds.length).toBeGreaterThan(0);
    expect(hybrid.citations.length).toBeGreaterThan(0);
    expect(hybrid.contextText).toContain("Vector Context");

    const reasoning = new ReasoningEngine().reason(withGraph, hybrid);
    const validations = new ValidationEngine().validate(withGraph, hybrid, reasoning);
    expect(validations.some((validation) => validation.status === "supported" || validation.status === "partially_supported")).toBe(true);
    expect(validations.some((validation) => validation.status === "inconclusive" || validation.status === "not_tested")).toBe(true);

    const withValidation = { ...withGraph, hybridContexts: [hybrid], validationResults: validations };
    const result = new ResultSynthesizer().synthesize({ snapshot: withValidation, hybridContext: hybrid, validationResults: validations });
    const decision = new LoopDecisionEngine().decide({
      snapshot: { ...withValidation, results: [result] },
      result,
      iteration: 1,
      maxLoopIterations: 2,
      beforeCounts: { evidence: 0, artifacts: 0, chunks: 0, entities: 0, relations: 0 }
    });
    expect(decision.shouldContinue).toBe(true);
    expect(decision.nextObjective).toBeTruthy();
    expect(decision.planRevisionHints.join(" ")).toContain("Step 4");
  });
});
