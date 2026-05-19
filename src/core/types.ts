export enum ResearchLoopStep {
  CreateProject = "CREATE_PROJECT",
  CreateSubSessions = "CREATE_SUB_SESSIONS",
  CreateResearchDb = "CREATE_RESEARCH_DB",
  GenerateQuestionsHypothesesEvidence = "GENERATE_QUESTIONS_HYPOTHESES_EVIDENCE",
  RunOpenCode = "RUN_OPENCODE",
  StoreResults = "STORE_RESULTS",
  BuildRagContext = "BUILD_RAG_CONTEXT",
  DeriveEvidenceBasedResult = "DERIVE_EVIDENCE_BASED_RESULT",
  FinalizeResearchOutputs = "FINALIZE_RESEARCH_OUTPUTS"
}

export type FlowKind = "Main Flow" | "Data Flow" | "Agent Control";

export type LoopStatus = "idle" | "running" | "paused" | "aborted" | "completed" | "failed";

export type StorageCategory =
  | "generated_artifact"
  | "paper_reference"
  | "web_source"
  | "experiment_log"
  | "conversation_memo";

export type ResearchSourceKind = "web" | "paper" | "file" | "artifact" | "log" | "conversation";

export type EvidenceStrength = "weak" | "medium" | "strong";

export type HypothesisStatus = "untested" | "supported" | "rejected" | "needs_more_evidence";

export interface AutonomyPolicy {
  toolApproval: "manual" | "suggested" | "automatic";
  maxLoopIterations: number;
  allowExternalSearch: boolean;
  allowCodeExecution: boolean;
}

export interface CreateProjectInput {
  goal: string;
  topic: string;
  scope: string;
  budget: string;
  autonomyPolicy: AutonomyPolicy;
}

export interface ResearchProject extends CreateProjectInput {
  id: string;
  createdAt: string;
  updatedAt: string;
  currentStep: ResearchLoopStep;
  status: LoopStatus;
  projectRoot: string;
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
  artifactRoot: string;
  sourceRoot?: string;
  logRoot?: string;
  reportRoot?: string;
  knowledgeRoot?: string;
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
  sourceId: string;
  text: string;
  chunkIndex: number;
  embedding?: number[];
  keywords: string[];
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

export interface AgentPlan {
  id: string;
  projectId: string;
  iteration: number;
  objective: string;
  steps: string[];
  requiredTools: string[];
  expectedArtifacts: string[];
  createdAt: string;
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

export interface ResearchSnapshot {
  project: ResearchProject;
  sessions: ResearchSession[];
  database?: ResearchDatabase;
  questions: ResearchQuestion[];
  hypotheses: Hypothesis[];
  evidence: EvidenceItem[];
  artifacts: ResearchArtifact[];
  sources: ResearchSource[];
  chunks: ResearchChunk[];
  toolRuns: ToolRun[];
  agentPlans: AgentPlan[];
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
  ragContext?: RagContext;
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

export interface AppSettings {
  openCodeLlm: OpenCodeLlmSettings;
  openCode: OpenCodeCliSettings;
  webSearch: WebSearchSettings;
  embedding: EmbeddingSettings;
  allowExternalSearch: boolean;
  allowCodeExecution: boolean;
  maxLoopIterations: number;
  updatedAt: string;
}

export interface OpenCodeRunOutput {
  run: OpenCodeRun;
  artifacts: ResearchArtifact[];
  evidence: EvidenceItem[];
  sources?: ResearchSource[];
  chunks?: ResearchChunk[];
  toolRuns?: ToolRun[];
  agentPlan?: AgentPlan;
  nextActions?: string[];
  needsMoreEvidence?: boolean;
  needsMoreAnalysis?: boolean;
  fallbackRecommended?: boolean;
}

export interface OpenCodeAdapter {
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
  saveQuestions(questions: ResearchQuestion[]): Promise<void>;
  saveHypotheses(hypotheses: Hypothesis[]): Promise<void>;
  saveEvidence(evidence: EvidenceItem[]): Promise<void>;
  saveArtifacts(artifacts: ResearchArtifact[]): Promise<void>;
  saveSources(sources: ResearchSource[]): Promise<void>;
  saveChunks(chunks: ResearchChunk[]): Promise<void>;
  saveToolRuns(toolRuns: ToolRun[]): Promise<void>;
  saveAgentPlan(plan: AgentPlan): Promise<void>;
  saveOpenCodeRun(run: OpenCodeRun): Promise<void>;
  saveRagContext(context: RagContext): Promise<void>;
  saveResult(result: EvidenceBasedResult): Promise<void>;
  saveIteration(iteration: LoopIteration): Promise<void>;
  saveReport(report: ResearchReport): Promise<void>;
  updateProject(project: ResearchProject): Promise<void>;
  getSnapshot(projectId: string): Promise<ResearchSnapshot>;
}
