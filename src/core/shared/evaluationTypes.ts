import type {
  FlowKind,
  Hypothesis,
  HypothesisStatus,
  LoopStatus,
  MemoryScope,
  ResearchDatabase,
  ResearchInput,
  ResearchLoopStep,
  ResearchProject,
  ResearchQuestion,
  ResearchSession,
  ResearchSpecification,
  ValidationStatus
} from "./researchTypes.js";
import type {
  AgentPlan,
  EvidenceItem,
  HybridContext,
  NormalizedResearchRecord,
  OntologyConstraint,
  OntologyEntity,
  OntologyRelation,
  ProjectContextSnapshot,
  RagContext,
  ResearchArtifact,
  ResearchChunk,
  ResearchPlan,
  ResearchSource,
  ToolRun
} from "./recordTypes.js";
import type { LegacyAgentRun, RuntimeBlocker, StepError } from "./recordTypes.js";

export type EvidenceClaimStatus = "supported" | "missing_evidence" | "contradicted" | "attribution_unfaithful" | "unknown";
export type EvidenceClaimCorrectnessStatus = "supported" | "contradicted" | "insufficient" | "unknown";
export type CitationFaithfulnessStatus = "faithful" | "unfaithful" | "missing" | "unknown";

export interface EvidenceClaimScore {
  id: string;
  claim: string;
  hypothesisId?: string;
  status: EvidenceClaimStatus;
  correctness: {
    status: EvidenceClaimCorrectnessStatus;
    confidence: number;
    supportingEvidenceIds: string[];
    contradictingEvidenceIds: string[];
    rationale: string;
  };
  citationFaithfulness: {
    status: CitationFaithfulnessStatus;
    citedEvidenceIds: string[];
    faithfulEvidenceIds: string[];
    unfaithfulEvidenceIds: string[];
    rationale: string;
  };
  evidenceGaps: string[];
}

export interface EvidenceScorecard {
  claimCount: number;
  statusCounts: Record<EvidenceClaimStatus, number>;
  claims: EvidenceClaimScore[];
}

export interface MainMemorySearchOptions {
  projectId?: string;
  limit?: number;
  includeEphemeral?: boolean;
}

export interface ValidationResult {
  id: string;
  projectId: string;
  iteration: number;
  hypothesisId?: string;
  status: "supported" | "partially_supported" | "contradicted" | "inconclusive" | "not_tested";
  confidence: number;
  supportingEvidenceIds: string[];
  contradictingEvidenceIds: string[];
  relatedEntityIds: string[];
  relatedRelationIds: string[];
  reasoningSummary: string;
  limitations: string[];
  evidenceGaps: string[];
  claimScorecard?: EvidenceScorecard;
  createdAt: string;
}

export interface EvidenceBasedResult {
  id: string;
  projectId: string;
  iteration: number;
  answer: string;
  hypothesisUpdates: Array<{
    hypothesisId: string;
    status: HypothesisStatus;
    confidence: number;
    rationale: string;
  }>;
  quantitativeResults: string[];
  qualitativeResults: string[];
  nextQuestions: string[];
  needsMoreEvidence: boolean;
  needsMoreAnalysis: boolean;
  validationResultIds?: string[];
  hybridContextId?: string;
  evidenceScorecard?: EvidenceScorecard;
  metadata?: Record<string, unknown>;
  createdAt: string;
}

export interface ContinuationDecision {
  id: string;
  projectId: string;
  iteration: number;
  shouldContinue: boolean;
  reason: string;
  nextObjective?: string;
  nextQuestions: string[];
  evidenceGaps: string[];
  planRevisionHints: string[];
  selectedSourceIds?: string[];
  selectedRecordIds?: string[];
  selectedEvidenceIds?: string[];
  selectedChunkIds?: string[];
  selectedCitationUrls?: string[];
  fetchCandidateUrls?: string[];
  projectContextSnapshotId?: string;
  forceStop?: boolean;
  createdAt: string;
}

export interface LoopIteration {
  id: string;
  projectId: string;
  iteration: number;
  step: ResearchLoopStep;
  flowKind: FlowKind;
  message: string;
  createdAt: string;
}

export interface ResearchReport {
  id: string;
  projectId: string;
  answer: string;
  hypothesisVerification: string;
  quantitativeQualitativeResults: string;
  comprehensiveReport: string;
  reusableKnowledgeAsset: string;
  markdown?: string;
  reportPath?: string;
  knowledgePath?: string;
  createdAt: string;
}

export interface FinalResearchOutput {
  id: string;
  projectId: string;
  finalAnswer: string;
  reportPath?: string;
  markdownReport: string;
  hypothesisSummary: string;
  evidenceCitationList: string[];
  reusableKnowledgeAsset: string;
  ontologyExportPath?: string;
  artifactPackagePath?: string;
  createdAt: string;
}

export interface RunAuditOutput {
  id: string;
  projectId: string;
  finalStatus: LoopStatus;
  failedStep?: ResearchLoopStep;
  failureReason?: string;
  completedIterations: number;
  sourceCount: number;
  evidenceCount: number;
  artifactCount: number;
  chunkCount: number;
  ontologyEntityCount: number;
  ontologyRelationCount: number;
  latestProjectContextSnapshotIds: string[];
  latestValidationResultIds: string[];
  latestResultIds: string[];
  continuationDecisionIds: string[];
  evidenceGaps: string[];
  recoverableNextActions: string[];
  unmetRequirements?: Array<{ requirementKey: string; message: string }>;
  markdownReport: string;
  reportPath?: string;
  jsonPath?: string;
  createdAt: string;
}

export interface BenchmarkPlan {
  id: string;
  projectId: string;
  queries: string[];
  conditions: Array<"vector_only" | "hybrid">;
  metrics: {
    citationCoverage: boolean;
    traceabilityPathCompleteness: boolean;
    unsupportedClaimDetection: boolean;
    evidenceGapRecall: boolean;
    latency: boolean;
    toolCostEstimate: boolean;
  };
  createdAt: string;
}

export interface GlobalMemoryItem {
  id: string;
  projectId: string;
  sourceProjectId?: string;
  memoryScope?: Extract<MemoryScope, "global">;
  title: string;
  content: string;
  validationResultId: string;
  supportingRecordIds: string[];
  supportingEvidenceIds: string[];
  citations: string[];
  promotionReason: string;
  validationStatus: Extract<ValidationStatus, "validated">;
  createdAt: string;
}

export interface ResearchSnapshot {
  project: ResearchProject;
  sessions: ResearchSession[];
  database?: ResearchDatabase;
  researchInputs: ResearchInput[];
  questions: ResearchQuestion[];
  hypotheses: Hypothesis[];
  evidence: EvidenceItem[];
  artifacts: ResearchArtifact[];
  sources: ResearchSource[];
  chunks: ResearchChunk[];
  toolRuns: ToolRun[];
  agentPlans: AgentPlan[];
  researchPlans: ResearchPlan[];
  specifications: ResearchSpecification[];
  normalizedRecords: NormalizedResearchRecord[];
  ontologyEntities: OntologyEntity[];
  ontologyRelations: OntologyRelation[];
  ontologyConstraints: OntologyConstraint[];
  projectContextSnapshots: ProjectContextSnapshot[];
  hybridContexts: HybridContext[];
  validationResults: ValidationResult[];
  continuationDecisions: ContinuationDecision[];
  finalOutputs: FinalResearchOutput[];
  runAuditOutputs: RunAuditOutput[];
  benchmarkPlans: BenchmarkPlan[];
  globalMemoryItems?: GlobalMemoryItem[];
  runtimeBlockers: RuntimeBlocker[];
  stepErrors: StepError[];
  legacyAgentRuns: LegacyAgentRun[];
  ragContexts: RagContext[];
  results: EvidenceBasedResult[];
  iterations: LoopIteration[];
  report?: ResearchReport;
}
