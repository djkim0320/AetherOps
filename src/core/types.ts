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
  RUN_OPENCODE: ResearchLoopStep.ExecuteTools,
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

export type FlowKind =
  | "Main Flow"
  | "Data Flow"
  | "Agent Control"
  | "Storage Flow"
  | "Knowledge Flow"
  | "Loop Back"
  | "Output Flow"
  | "Error Flow";

export type LoopStatus = "idle" | "running" | "paused" | "aborted" | "completed" | "failed" | "blocked";

export type StorageCategory =
  | "generated_artifact"
  | "paper_reference"
  | "web_source"
  | "experiment_log"
  | "conversation_memo";

export type ResearchSourceKind = "web" | "paper" | "file" | "artifact" | "log" | "conversation";
export type EvidenceStrength = "weak" | "medium" | "strong";
export type HypothesisStatus = "untested" | "supported" | "rejected" | "needs_more_evidence";
export type NormalizedRecordKind = "source" | "artifact" | "claim" | "evidence" | "observation" | "citation" | "error";
export type TraceabilityKind = "internal_artifact" | "external_source" | "tool_observation" | "project_provenance" | "error";
export type MemoryScope = "global" | "project_only" | "ephemeral";
export type ResearchMemoryScope = MemoryScope;
export type ValidationStatus =
  | "raw"
  | "normalized"
  | "indexed"
  | "graph_linked"
  | "validated"
  | "disputed"
  | "deprecated"
  | "rejected";
export type OntologyEntityType =
  | "ResearchQuestion"
  | "Hypothesis"
  | "Claim"
  | "Evidence"
  | "Source"
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
  | "blockedBy"
  | "failedAt";

export interface AutonomyPolicy {
  toolApproval: "manual" | "suggested" | "automatic";
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
  text: string;
  status: "open" | "answered" | "deferred";
  createdAt: string;
}

export interface Hypothesis {
  id: string;
  projectId: string;
  questionId: string;
  statement: string;
  status: HypothesisStatus;
  confidence: number;
  createdAt: string;
}

export interface ResearchSpecification {
  id: string;
  projectId: string;
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

export interface ResearchPlan {
  id: string;
  projectId: string;
  iteration: number;
  objective: string;
  targetQuestions: string[];
  targetHypotheses: string[];
  requiredTools: string[];
  expectedSources: string[];
  expectedArtifacts: string[];
  executionSteps: string[];
  stopCriteria: string[];
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

export interface OpenCodeRun {
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
  globalMemoryItems?: GlobalMemoryItem[];
  runtimeBlockers: RuntimeBlocker[];
  stepErrors: StepError[];
  openCodeRuns: OpenCodeRun[];
  ragContexts: RagContext[];
  results: EvidenceBasedResult[];
  iterations: LoopIteration[];
  report?: ResearchReport;
}

export interface OpenCodeRunInput {
  project: ResearchProject;
  questions: ResearchQuestion[];
  hypotheses: Hypothesis[];
  evidence?: EvidenceItem[];
  artifacts?: ResearchArtifact[];
  sources?: ResearchSource[];
  sourceCandidates?: ResearchSource[];
  claims?: OpenCodeClaim[];
  observations?: OpenCodeObservation[];
  toolRuns?: ToolRun[];
  ragContext?: RagContext;
  hybridContext?: HybridContext;
  specification?: ResearchSpecification;
  researchPlan?: ResearchPlan;
  iteration: number;
}

export type OpenCodeLlmSource = "api" | "codex-oauth";

export interface OpenCodeApiLlmSettings {
  source: "api";
  provider: "openai" | "anthropic" | "google" | "custom";
  model: string;
  baseUrl?: string;
  apiKey?: string;
  apiKeyConfigured?: boolean;
}

export interface OpenCodeCodexOAuthLlmSettings {
  source: "codex-oauth";
  model?: string;
}

export type OpenCodeLlmSettings = OpenCodeApiLlmSettings | OpenCodeCodexOAuthLlmSettings;

export interface OpenCodeCliSettings {
  enabled: boolean;
  command: string;
  provider?: string;
  model?: string;
  timeoutMs: number;
}

export interface WebSearchSettings {
  provider: "tavily" | "brave" | "custom" | "disabled";
  apiKey?: string;
  apiKeyConfigured?: boolean;
  endpoint?: string;
}

export interface EmbeddingSettings {
  provider: "openai" | "google" | "custom" | "local";
  model?: string;
  baseUrl?: string;
  apiKey?: string;
  apiKeyConfigured?: boolean;
  dimensions: number;
}

export interface BrowserUseSettings {
  enabled: boolean;
  mode: "background" | "visible";
  maxPages: number;
  timeoutMs: number;
  captureScreenshots: boolean;
}

export interface AppSettings {
  openCodeLlm: OpenCodeLlmSettings;
  openCode: OpenCodeCliSettings;
  webSearch: WebSearchSettings;
  embedding: EmbeddingSettings;
  browserUse: BrowserUseSettings;
  allowExternalSearch: boolean;
  allowCodeExecution: boolean;
  ontologyExtractionMode?: "llm" | "rule_based" | "hybrid";
  finalOutputExport?: {
    markdown: boolean;
    json: boolean;
    ontologyGraph: boolean;
    artifactPackage: boolean;
  };
  updatedAt: string;
}

export interface OpenCodeRunOutput {
  run: OpenCodeRun;
  artifacts: ResearchArtifact[];
  evidence: EvidenceItem[];
  sources?: ResearchSource[];
  sourceCandidates?: ResearchSource[];
  claims?: OpenCodeClaim[];
  observations?: OpenCodeObservation[];
  chunks?: ResearchChunk[];
  toolRuns?: ToolRun[];
  agentPlan?: AgentPlan;
  nextActions?: string[];
  needsMoreEvidence?: boolean;
  needsMoreAnalysis?: boolean;
  fatalError?: string;
}

export interface OpenCodeClaim {
  title: string;
  content: string;
  sourceUri?: string;
  citation?: string;
  metadata?: Record<string, unknown>;
}

export interface OpenCodeObservation {
  title: string;
  content: string;
  sourceUri?: string;
  citation?: string;
  metadata?: Record<string, unknown>;
}

export interface OpenCodeAdapter {
  preflight?(): Promise<void>;
  run(input: OpenCodeRunInput): Promise<OpenCodeRunOutput>;
}

export interface RagEngine {
  buildContext(snapshot: ResearchSnapshot): Promise<RagContext>;
}

export interface ResearchStore {
  saveProject(project: ResearchProject): Promise<void>;
  listProjects(): Promise<ResearchProject[]>;
  getProject(projectId: string): Promise<ResearchProject | undefined>;
  saveSessions(sessions: ResearchSession[]): Promise<void>;
  deleteSession(projectId: string, sessionId: string): Promise<void>;
  saveDatabase(database: ResearchDatabase): Promise<void>;
  saveResearchInput(input: ResearchInput): Promise<void>;
  saveQuestions(questions: ResearchQuestion[]): Promise<void>;
  saveHypotheses(hypotheses: Hypothesis[]): Promise<void>;
  saveEvidence(evidence: EvidenceItem[]): Promise<void>;
  saveArtifacts(artifacts: ResearchArtifact[]): Promise<void>;
  saveSources(sources: ResearchSource[]): Promise<void>;
  saveChunks(chunks: ResearchChunk[]): Promise<void>;
  saveToolRuns(toolRuns: ToolRun[]): Promise<void>;
  saveAgentPlan(plan: AgentPlan): Promise<void>;
  saveResearchSpecification(specification: ResearchSpecification): Promise<void>;
  saveResearchPlan(plan: ResearchPlan): Promise<void>;
  saveNormalizedRecords(records: NormalizedResearchRecord[]): Promise<void>;
  saveOntologyEntities(entities: OntologyEntity[]): Promise<void>;
  saveOntologyRelations(relations: OntologyRelation[]): Promise<void>;
  saveOntologyConstraints(constraints: OntologyConstraint[]): Promise<void>;
  saveProjectContextSnapshot(context: ProjectContextSnapshot): Promise<void>;
  saveHybridContext(context: HybridContext): Promise<void>;
  saveValidationResults(results: ValidationResult[]): Promise<void>;
  saveContinuationDecision(decision: ContinuationDecision): Promise<void>;
  saveFinalResearchOutput(output: FinalResearchOutput): Promise<void>;
  saveGlobalMemoryItems(items: GlobalMemoryItem[]): Promise<void>;
  saveRuntimeBlocker(blocker: RuntimeBlocker): Promise<void>;
  saveStepError(error: StepError): Promise<void>;
  saveOpenCodeRun(run: OpenCodeRun): Promise<void>;
  saveRagContext(context: RagContext): Promise<void>;
  saveResult(result: EvidenceBasedResult): Promise<void>;
  saveIteration(iteration: LoopIteration): Promise<void>;
  saveReport(report: ResearchReport): Promise<void>;
  updateProject(project: ResearchProject): Promise<void>;
  getSnapshot(projectId: string): Promise<ResearchSnapshot>;
  searchGlobalRecords(query: string, options?: MainMemorySearchOptions): Promise<NormalizedResearchRecord[]>;
  searchGlobalChunks(query: string, options?: MainMemorySearchOptions): Promise<ResearchChunk[]>;
  searchGlobalGraph(query: string, options?: MainMemorySearchOptions): Promise<{
    entities: OntologyEntity[];
    relations: OntologyRelation[];
    constraints: OntologyConstraint[];
  }>;
}
