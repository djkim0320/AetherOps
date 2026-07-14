import type { ResearchSnapshot } from "../../../core/shared/evaluationTypes.js";
import { ResearchLoopStep, type ResearchSpecification } from "../../../core/shared/researchTypes.js";

const PROJECT_ID = "project-1";
const CREATED_AT = "2026-07-14T00:00:00.000Z";

export function specificationFixture(): ResearchSpecification {
  return {
    id: "specification-1",
    projectId: PROJECT_ID,
    sourceResearchInputId: "input-1",
    sourceQuestionIds: [],
    sourceHypothesisIds: [],
    researchQuestions: ["Does the deterministic fixture satisfy the criterion?"],
    initialHypotheses: ["The fixture is deterministic."],
    refinedHypotheses: ["The same input produces the same hash."],
    scope: "Local deterministic verification only.",
    assumptions: [],
    constraints: ["Do not access the network."],
    successCriteria: ["The compiled context hash is replay-stable."],
    requiredEvidenceTypes: ["fixture"],
    competencyQuestions: [],
    evaluationMetrics: ["hash equality"],
    createdAt: CREATED_AT
  };
}

export function snapshotFixture(overrides: Partial<ResearchSnapshot> = {}): ResearchSnapshot {
  return {
    project: {
      id: PROJECT_ID,
      goal: "Verify deterministic canonical orchestration.",
      topic: "Canonical run state",
      scope: "One local research run.",
      budget: "Bounded test budget.",
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
        id: "input-1",
        projectId: PROJECT_ID,
        researchQuestion: "Can canonical state replay deterministically?",
        initialHypotheses: ["Yes."],
        constraints: ["Use receipt-bound state only."],
        expectedOutputs: ["A verified canonical run report."],
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
