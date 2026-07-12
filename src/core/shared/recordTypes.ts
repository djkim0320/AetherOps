import type {
  EvidenceStrength,
  MemoryScope,
  NormalizedRecordKind,
  OntologyEntityType,
  OntologyRelationType,
  ResearchSourceKind,
  ResearchLoopStep,
  StorageCategory,
  TraceabilityKind,
  ValidationStatus
} from "./researchTypes.js";
import type { EngineeringProgramRequest } from "./engineeringTypes.js";

export interface ResearchPlan {
  id: string;
  projectId: string;
  sourceResearchInputId?: string;
  sourceSpecificationId?: string;
  iteration: number;
  objective: string;
  targetQuestions: string[];
  targetHypotheses: string[];
  requiredTools: string[];
  toolRequests?: Array<{
    intentId: string;
    toolName: string;
    purpose: string;
    expectedOutcome: string;
    inputs: Record<string, unknown>;
  }>;
  expectedSources: string[];
  expectedArtifacts: string[];
  executionSteps: string[];
  stopCriteria: string[];
  fetchCandidateUrls?: string[];
  programRequests?: EngineeringProgramRequest[];
  createdAt: string;
  steps?: string[];
}

export type AgentPlan = ResearchPlan;

export interface ResearchSource {
  id: string;
  projectId: string;
  kind: ResearchSourceKind;
  title: string;
  url?: string;
  doi?: string;
  authors?: string[];
  publishedAt?: string;
  retrievedAt: string;
  rawPath?: string;
  metadata: Record<string, unknown>;
  createdAt?: string;
}

export interface ResearchChunk {
  id: string;
  projectId: string;
  sourceProjectId?: string;
  originProjectId?: string;
  workspaceProjectId?: string;
  memoryScope?: MemoryScope;
  validationStatus?: ValidationStatus;
  sourceId: string;
  text: string;
  chunkIndex: number;
  embedding?: number[];
  keywords: string[];
  recordId?: string;
  evidenceId?: string;
  citation?: string;
  recordKind?: NormalizedRecordKind;
  traceabilityKind?: TraceabilityKind;
  canSupportHypothesis?: boolean;
  sourceQualityTier?: string;
  sourceQualityLabel?: string;
  sourceCanSupportHypothesis?: boolean;
  embeddingProvider?: string;
  embeddingModel?: string;
  embeddingDimensions?: number;
  createdAt: string;
}

export interface ToolRun {
  id: string;
  projectId: string;
  iteration: number;
  toolName: string;
  input: unknown;
  output: unknown;
  status: "completed" | "failed" | "skipped";
  error?: string;
  /** Stable durable attempt that produced this run; absent on legacy records. */
  originAttemptId?: string;
  /** Stable planner decision that authorized the attempt; absent on legacy records. */
  originDecisionId?: string;
  executionOrdinal?: number;
  startedAt: string;
  completedAt: string;
}

export interface EvidenceItem {
  id: string;
  projectId: string;
  category: StorageCategory;
  title: string;
  summary: string;
  sourceId?: string;
  sourceUri?: string;
  citation?: string;
  quote?: string;
  doi?: string;
  keywords: string[];
  linkedHypothesisIds: string[];
  reliabilityScore?: number;
  relevanceScore?: number;
  evidenceStrength?: EvidenceStrength;
  limitations?: string[];
  metadata?: Record<string, unknown>;
  createdAt: string;
}

export interface ResearchArtifact {
  id: string;
  projectId: string;
  category: StorageCategory;
  title: string;
  relativePath: string;
  mimeType: string;
  summary: string;
  content?: string;
  rawPath?: string;
  metadata?: Record<string, unknown>;
  createdAt: string;
}

export interface NormalizedResearchRecord {
  id: string;
  projectId: string;
  sourceProjectId?: string;
  originProjectId?: string;
  workspaceProjectId?: string;
  memoryScope: MemoryScope;
  validationStatus: ValidationStatus;
  iteration: number;
  kind: NormalizedRecordKind;
  title: string;
  content: string;
  sourceId?: string;
  artifactId?: string;
  evidenceId?: string;
  citation?: string;
  sourceUri?: string;
  metadata: Record<string, unknown>;
  confidence?: number;
  createdAt: string;
}

export interface OntologyEntity {
  id: string;
  projectId: string;
  sourceProjectId?: string;
  originProjectId?: string;
  workspaceProjectId?: string;
  memoryScope?: MemoryScope;
  validationStatus?: ValidationStatus;
  label: string;
  type: OntologyEntityType;
  description?: string;
  sourceRecordId?: string;
  sourceEvidenceId?: string;
  confidence: number;
  createdAt: string;
}

export interface OntologyRelation {
  id: string;
  projectId: string;
  sourceProjectId?: string;
  originProjectId?: string;
  workspaceProjectId?: string;
  memoryScope?: MemoryScope;
  validationStatus?: ValidationStatus;
  subjectId: string;
  predicate: OntologyRelationType;
  objectId: string;
  sourceRecordId?: string;
  sourceEvidenceId?: string;
  confidence: number;
  createdAt: string;
}

export interface OntologyConstraint {
  id: string;
  projectId: string;
  sourceProjectId?: string;
  originProjectId?: string;
  workspaceProjectId?: string;
  memoryScope?: MemoryScope;
  validationStatus?: ValidationStatus;
  label: string;
  description: string;
  appliesToEntityType?: OntologyEntityType;
  ruleType: "unit" | "consistency" | "hierarchy" | "hypothesis_evidence" | "runtime_requirement" | "custom";
  rule: Record<string, unknown>;
  sourceRecordId?: string;
  confidence: number;
  createdAt: string;
}

export interface RuntimeRequirement {
  key: string;
  label: string;
  requiredForSteps: ResearchLoopStep[];
  isSatisfied: boolean;
  message?: string;
}

export interface RuntimeBlocker {
  id: string;
  projectId: string;
  step: ResearchLoopStep;
  requirementKey: string;
  message: string;
  createdAt: string;
}

export interface StepError {
  id: string;
  projectId: string;
  step: ResearchLoopStep;
  message: string;
  cause?: string;
  metadata: Record<string, unknown>;
  createdAt: string;
}

/** Read-only execution record imported from the retired executor table. */
export interface LegacyAgentRun {
  id: string;
  projectId: string;
  iteration: number;
  prompt: string;
  toolPlan: string[];
  status: "queued" | "running" | "completed" | "failed" | "skipped";
  logs: string[];
  artifactIds: string[];
  evidenceIds: string[];
  metadata?: Record<string, unknown>;
  startedAt: string;
  completedAt?: string;
}

export interface RagContext {
  id: string;
  projectId: string;
  query: string;
  evidenceIds: string[];
  artifactIds: string[];
  summary: string;
  chunkIds?: string[];
  citations?: string[];
  retrievalScores?: Record<string, number>;
  contextText?: string;
  createdAt: string;
}

export interface HybridContext {
  id: string;
  projectId: string;
  iteration: number;
  query: string;
  vectorChunkIds: string[];
  ontologyEntityIds: string[];
  ontologyRelationIds: string[];
  evidenceIds: string[];
  artifactIds: string[];
  citations: string[];
  vectorSummary: string;
  graphSummary: string;
  contextText: string;
  retrievalScores: Record<string, number>;
  createdAt: string;
}

export interface ProjectContextSnapshot {
  id: string;
  projectId: string;
  iteration: number;
  query: string;
  selectedRecordIds: string[];
  selectedSourceIds: string[];
  selectedEvidenceIds: string[];
  selectedChunkIds: string[];
  selectedEntityIds: string[];
  selectedRelationIds: string[];
  citations: string[];
  selectionReason: string;
  createdAt: string;
}
