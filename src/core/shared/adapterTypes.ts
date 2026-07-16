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
import type { RuntimeBlocker, StepError, LegacyAgentRun } from "./recordTypes.js";
import type { SourceAccessPolicy } from "../../shared/kernel/sourceAccessPolicy.js";
import type { CodexSettings } from "./settingsTypes.js";

export type CodexCliStage = "resolving_cli" | "authenticating" | "running" | "tool_activity" | "validating_output" | "terminal";

export interface CodexCliTaskInput {
  task: string;
  inputArtifactIds: string[];
  outputs: Array<{ relativePath: string; kind: "code" | "report" | "data" }>;
}

export interface CodexCliInputArtifact {
  id: string;
  sourcePath: string;
  sha256: string;
}

export interface CodexCliTaskResult {
  summary: string;
  outputs: Array<{ relativePath: string; kind: "code" | "report" | "data"; absolutePath: string; sha256: string; bytes: number }>;
  trace: {
    cliVersion: string;
    model: string;
    reasoningEffort: string;
    sandboxProfile: "aetherops-codex-workspace-v1";
    networkPolicy: "disabled";
    durationMs: number;
    exitCode: number;
    eventCount: number;
    workspaceManifestHash: string;
    outputManifestHash: string;
    terminationReason: string;
  };
}

export interface CodexCliAdapterRequest {
  actionRoot: string;
  input: CodexCliTaskInput;
  artifacts: CodexCliInputArtifact[];
  settings: CodexSettings;
  signal?: AbortSignal;
  onStage?: (stage: CodexCliStage) => void | Promise<void>;
}

export interface CodexCliAdapter {
  preflight?(): Promise<void>;
  run(request: CodexCliAdapterRequest): Promise<CodexCliTaskResult>;
  dispose?(): Promise<void>;
}

export interface ResearchToolInput {
  project: ResearchProject;
  executionBundleId?: string;
  questions: ResearchQuestion[];
  hypotheses: Hypothesis[];
  evidence?: EvidenceItem[];
  artifacts?: ResearchArtifact[];
  sources?: ResearchSource[];
  sourceCandidates?: ResearchSource[];
  toolRuns?: ToolRun[];
  normalizedRecords?: NormalizedResearchRecord[];
  validationResults?: ValidationResult[];
  projectContextSnapshots?: ProjectContextSnapshot[];
  results?: EvidenceBasedResult[];
  ragContext?: RagContext;
  hybridContext?: HybridContext;
  specification?: ResearchSpecification;
  researchPlan?: ResearchPlan;
  executionContext?: ResearchToolExecutionContext;
  coordinateBindings?: VerifiedAirfoilCoordinateBinding[];
  projectContextSnapshot?: ProjectContextSnapshot;
  iteration: number;
}

export type ResearchSourceAccessPolicy = SourceAccessPolicy;

export interface ResearchToolExecutionContext {
  toolPolicy: {
    allowCodexCli: boolean;
    sourceAccess: ResearchSourceAccessPolicy;
  };
}

export interface VerifiedAirfoilCoordinateBinding {
  id: string;
  sourceId: string;
  sourceUrl: string;
  label: string;
  sha256: string;
  rawText: string;
  pointCount: number;
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
  saveLegacyAgentRun(run: LegacyAgentRun): Promise<void>;
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
