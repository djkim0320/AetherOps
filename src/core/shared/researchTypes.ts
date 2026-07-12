export enum ResearchLoopStep {
  CreateResearchDb = "CREATE_RESEARCH_DB",
  InputResearchQuestionHypothesis = "INPUT_RESEARCH_QUESTION_HYPOTHESIS",
  BuildResearchSpecification = "BUILD_RESEARCH_SPECIFICATION",
  PlanResearch = "PLAN_RESEARCH",
  ExecuteTools = "EXECUTE_TOOLS",
  NormalizeData = "NORMALIZE_DATA",
  BuildVectorIndex = "BUILD_VECTOR_INDEX",
  BuildOntologyGraph = "BUILD_ONTOLOGY_GRAPH",
  ReasonAndValidate = "REASON_AND_VALIDATE",
  SynthesizeAndEvaluate = "SYNTHESIZE_AND_EVALUATE",
  DecideContinuation = "DECIDE_CONTINUATION",
  FinalizeOutputs = "FINALIZE_OUTPUTS"
}

export const legacyResearchLoopStepMap: Record<string, ResearchLoopStep> = {
  CREATE_PROJECT: ResearchLoopStep.CreateResearchDb,
  CREATE_SUB_SESSIONS: ResearchLoopStep.CreateResearchDb,
  CREATE_RESEARCH_DB: ResearchLoopStep.CreateResearchDb,
  GENERATE_QUESTIONS_HYPOTHESES_EVIDENCE: ResearchLoopStep.BuildResearchSpecification,
  STORE_RESULTS: ResearchLoopStep.NormalizeData,
  BUILD_RAG_CONTEXT: ResearchLoopStep.BuildVectorIndex,
  DERIVE_EVIDENCE_BASED_RESULT: ResearchLoopStep.SynthesizeAndEvaluate,
  FINALIZE_RESEARCH_OUTPUTS: ResearchLoopStep.FinalizeOutputs
};

export function normalizeResearchLoopStep(value: unknown): ResearchLoopStep {
  if (typeof value !== "string") {
    throw new Error(`Unknown research loop step: ${String(value)}`);
  }
  if (Object.values(ResearchLoopStep).includes(value as ResearchLoopStep)) {
    return value as ResearchLoopStep;
  }
  const legacyStep = legacyResearchLoopStepMap[value];
  if (legacyStep) {
    return legacyStep;
  }
  throw new Error(`Unknown research loop step: ${value}`);
}

export type FlowKind = "Main Flow" | "Data Flow" | "Agent Control" | "Storage Flow" | "Knowledge Flow" | "Loop Back" | "Output Flow" | "Error Flow";

export type LoopStatus = "idle" | "running" | "paused" | "aborted" | "completed" | "failed" | "blocked";

export type StorageCategory = "generated_artifact" | "paper_reference" | "web_source" | "experiment_log" | "conversation_memo";

export type ResearchSourceKind = "web" | "paper" | "file" | "artifact" | "log" | "conversation";
export type EvidenceStrength = "weak" | "medium" | "strong";
export type HypothesisStatus = "untested" | "supported" | "rejected" | "needs_more_evidence";
export type NormalizedRecordKind = "source" | "artifact" | "claim" | "evidence" | "observation" | "citation" | "error";
export type TraceabilityKind = "internal_artifact" | "external_source" | "tool_observation" | "project_provenance" | "error";
export type MemoryScope = "global" | "project_only" | "ephemeral";
export type ResearchMemoryScope = MemoryScope;
export type ValidationStatus = "raw" | "normalized" | "indexed" | "graph_linked" | "validated" | "disputed" | "deprecated" | "rejected";
export type OntologyEntityType =
  | "ResearchQuestion"
  | "Hypothesis"
  | "Claim"
  | "Evidence"
  | "Source"
  | "Citation"
  | "Artifact"
  | "Method"
  | "Tool"
  | "Dataset"
  | "Metric"
  | "Concept"
  | "Parameter"
  | "Unit"
  | "Constraint"
  | "Assumption"
  | "Limitation"
  | "Result"
  | "Error";
export type OntologyRelationType =
  | "answers"
  | "supports"
  | "contradicts"
  | "refines"
  | "derivedFrom"
  | "generatedBy"
  | "cites"
  | "mentions"
  | "dependsOn"
  | "hasParameter"
  | "measuredIn"
  | "partOf"
  | "isA"
  | "affects"
  | "requires"
  | "hasLimitation"
  | "hasCitation"
  | "blockedBy"
  | "failedAt";

export interface AutonomyPolicy {
  toolApproval: "manual" | "suggested" | "automatic";
  /** Defaults to true when reading projects created before the v2 capability split. */
  allowAgent?: boolean;
  allowExternalSearch: boolean;
  allowCodeExecution: boolean;
  maxLoopIterations?: number;
}

export interface ResearchProjectInput {
  goal: string;
  topic: string;
  scope: string;
  budget: string;
  autonomyPolicy: AutonomyPolicy;
}

export interface ResearchProject extends ResearchProjectInput {
  id: string;
  createdAt: string;
  updatedAt: string;
  currentStep: ResearchLoopStep;
  status: LoopStatus;
  projectRoot: string;
}

export interface ResearchInput {
  id: string;
  projectId: string;
  researchQuestion: string;
  initialHypotheses: string[];
  constraints: string[];
  expectedOutputs: string[];
  createdAt: string;
}

export interface ResearchSession {
  id: string;
  projectId: string;
  title: string;
  focus: string;
  createdAt: string;
}

export interface ResearchDatabase {
  id: string;
  projectId: string;
  sqlitePath: string;
  vectorPath: string;
  ontologyPath?: string;
  artifactRoot: string;
  sourceRoot?: string;
  logRoot?: string;
  reportRoot?: string;
  knowledgeRoot?: string;
  ontologyRoot?: string;
  exportsRoot?: string;
  errorsRoot?: string;
  statePath?: string;
  createdAt: string;
}

export interface ResearchQuestion {
  id: string;
  projectId: string;
  researchInputId?: string;
  text: string;
  status: "open" | "answered" | "deferred";
  createdAt: string;
}

export interface Hypothesis {
  id: string;
  projectId: string;
  researchInputId?: string;
  questionId: string;
  statement: string;
  status: HypothesisStatus;
  confidence: number;
  createdAt: string;
}

export interface ResearchSpecification {
  id: string;
  projectId: string;
  sourceResearchInputId?: string;
  sourceQuestionIds?: string[];
  sourceHypothesisIds?: string[];
  researchQuestions: string[];
  initialHypotheses: string[];
  refinedHypotheses: string[];
  scope: string;
  assumptions: string[];
  constraints: string[];
  successCriteria: string[];
  requiredEvidenceTypes: string[];
  competencyQuestions: string[];
  evaluationMetrics: string[];
  createdAt: string;
}
