import type {
  Hypothesis,
  ResearchDatabase,
  ResearchInput,
  ResearchProject,
  ResearchQuestion,
  ResearchSession,
  ResearchSpecification
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
import type {
  BenchmarkPlan,
  ContinuationDecision,
  EvidenceBasedResult,
  FinalResearchOutput,
  GlobalMemoryItem,
  LoopIteration,
  MainMemorySearchOptions,
  ResearchReport,
  ResearchSnapshot,
  RunAuditOutput,
  ValidationResult
} from "./evaluationTypes.js";
import type { RuntimeBlocker, StepError, OpenCodeRun } from "./recordTypes.js";

export interface OpenCodeRunInput {
  project: ResearchProject;
  openCodeRunId?: string;
  executionBundleId?: string;
  questions: ResearchQuestion[];
  hypotheses: Hypothesis[];
  evidence?: EvidenceItem[];
  artifacts?: ResearchArtifact[];
  sources?: ResearchSource[];
  sourceCandidates?: ResearchSource[];
  claims?: OpenCodeClaim[];
  observations?: OpenCodeObservation[];
  toolRuns?: ToolRun[];
  normalizedRecords?: NormalizedResearchRecord[];
  validationResults?: ValidationResult[];
  projectContextSnapshots?: ProjectContextSnapshot[];
  results?: EvidenceBasedResult[];
  ragContext?: RagContext;
  hybridContext?: HybridContext;
  specification?: ResearchSpecification;
  researchPlan?: ResearchPlan;
  projectContextSnapshot?: ProjectContextSnapshot;
  iteration: number;
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
  createRunAttempt?(input: OpenCodeRunInput): Promise<OpenCodeRun>;
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
  saveRunAuditOutput(output: RunAuditOutput): Promise<void>;
  saveBenchmarkPlan(plan: BenchmarkPlan): Promise<void>;
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
  searchGlobalGraph(
    query: string,
    options?: MainMemorySearchOptions
  ): Promise<{
    entities: OntologyEntity[];
    relations: OntologyRelation[];
    constraints: OntologyConstraint[];
  }>;
}
