import type { ResearchSnapshot } from "../../../core/shared/evaluationTypes.js";
import { ResearchLoopStep, type ResearchSpecification } from "../../../core/shared/researchTypes.js";

const PROJECT_ID = "project-session";
const CREATED_AT = "2026-07-14T00:00:00.000Z";

export function evidence(id: string, title: string, overrides: Partial<ResearchSnapshot["evidence"][number]> = {}): ResearchSnapshot["evidence"][number] {
  return {
    id,
    projectId: PROJECT_ID,
    category: "experiment_log",
    title,
    summary: `${title} summary.`,
    keywords: [],
    linkedHypothesisIds: [],
    createdAt: CREATED_AT,
    ...overrides
  };
}

export function artifact(id: string, metadata: Record<string, unknown>): ResearchSnapshot["artifacts"][number] {
  return {
    id,
    projectId: PROJECT_ID,
    category: "generated_artifact",
    title: id,
    relativePath: `outputs/${id}.json`,
    mimeType: "application/json",
    summary: `${id} summary.`,
    metadata,
    createdAt: CREATED_AT
  };
}

export function specificationFixture(): ResearchSpecification {
  return {
    id: "specification-session",
    projectId: PROJECT_ID,
    sourceResearchInputId: "input-session",
    researchQuestions: ["Can a canonical session resume without changing identity?"],
    initialHypotheses: ["Yes."],
    refinedHypotheses: ["Stable lineage and receipts preserve identity."],
    scope: "Local deterministic session verification.",
    assumptions: [],
    constraints: ["No network access."],
    successCriteria: ["Checkpoint replay produces one revision."],
    requiredEvidenceTypes: ["validation receipt"],
    competencyQuestions: [],
    evaluationMetrics: ["canonical hash equality"],
    createdAt: CREATED_AT
  };
}

export function snapshotFixture(overrides: Partial<ResearchSnapshot> = {}): ResearchSnapshot {
  return {
    project: {
      id: PROJECT_ID,
      goal: "Verify canonical research sessions.",
      topic: "Durable canonical session",
      scope: "One bounded local run.",
      budget: "Deterministic fixture budget.",
      autonomyPolicy: { toolApproval: "automatic", allowAgent: true, allowExternalSearch: false, allowCodeExecution: false },
      createdAt: CREATED_AT,
      updatedAt: CREATED_AT,
      currentStep: ResearchLoopStep.PlanResearch,
      status: "running",
      projectRoot: PROJECT_ID
    },
    sessions: [],
    researchInputs: [
      {
        id: "input-session",
        projectId: PROJECT_ID,
        researchQuestion: "Can the durable canonical session replay safely?",
        initialHypotheses: ["Yes."],
        constraints: ["Use immutable receipts."],
        expectedOutputs: ["A canonical session report."],
        createdAt: CREATED_AT
      }
    ],
    questions: [],
    hypotheses: [],
    evidence: [],
    artifacts: [],
    sources: [],
    chunks: [],
    toolRuns: [],
    agentPlans: [],
    researchPlans: [],
    specifications: [specificationFixture()],
    normalizedRecords: [],
    ontologyEntities: [],
    ontologyRelations: [],
    ontologyConstraints: [],
    projectContextSnapshots: [],
    hybridContexts: [],
    validationResults: [],
    continuationDecisions: [],
    finalOutputs: [],
    runAuditOutputs: [],
    benchmarkPlans: [],
    runtimeBlockers: [],
    stepErrors: [],
    legacyAgentRuns: [],
    ragContexts: [],
    results: [],
    iterations: [],
    ...overrides
  };
}
