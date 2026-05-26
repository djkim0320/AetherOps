import type {
  EvidenceBasedResult,
  EvidenceItem,
  AgentPlan,
  ContinuationDecision,
  FinalResearchOutput,
  GlobalMemoryItem,
  HybridContext,
  LoopIteration,
  NormalizedResearchRecord,
  OpenCodeRun,
  OntologyConstraint,
  OntologyEntity,
  OntologyRelation,
  RagContext,
  ResearchArtifact,
  ResearchChunk,
  ResearchDatabase,
  ResearchInput,
  ResearchPlan,
  ResearchProject,
  ResearchQuestion,
  ResearchReport,
  ResearchSession,
  ResearchSpecification,
  ResearchSource,
  ResearchSnapshot,
  ResearchStore,
  ProjectContextSnapshot,
  RuntimeBlocker,
  StepError,
  ToolRun
} from "./types.js";
import { normalizeMemoryScope } from "./researchMemory.js";

type ScopedProjectItem = { projectId: string; workspaceProjectId?: string; memoryScope?: import("./types.js").MemoryScope };

export class InMemoryResearchStore implements ResearchStore {
  private projects = new Map<string, ResearchProject>();
  private databases = new Map<string, ResearchDatabase>();
  private sessions: ResearchSession[] = [];
  private researchInputs: ResearchInput[] = [];
  private questions: ResearchQuestion[] = [];
  private hypotheses: import("./types.js").Hypothesis[] = [];
  private evidence: EvidenceItem[] = [];
  private artifacts: ResearchArtifact[] = [];
  private sources: ResearchSource[] = [];
  private chunks: ResearchChunk[] = [];
  private toolRuns: ToolRun[] = [];
  private agentPlans: AgentPlan[] = [];
  private researchPlans: ResearchPlan[] = [];
  private specifications: ResearchSpecification[] = [];
  private normalizedRecords: NormalizedResearchRecord[] = [];
  private ontologyEntities: OntologyEntity[] = [];
  private ontologyRelations: OntologyRelation[] = [];
  private ontologyConstraints: OntologyConstraint[] = [];
  private projectContextSnapshots: ProjectContextSnapshot[] = [];
  private hybridContexts: HybridContext[] = [];
  private validationResults: import("./types.js").ValidationResult[] = [];
  private continuationDecisions: ContinuationDecision[] = [];
  private finalOutputs: FinalResearchOutput[] = [];
  private globalMemoryItems: GlobalMemoryItem[] = [];
  private runtimeBlockers: RuntimeBlocker[] = [];
  private stepErrors: StepError[] = [];
  private openCodeRuns: OpenCodeRun[] = [];
  private ragContexts: RagContext[] = [];
  private results: EvidenceBasedResult[] = [];
  private iterations: LoopIteration[] = [];
  private reports = new Map<string, ResearchReport>();

  async saveProject(project: ResearchProject): Promise<void> {
    this.projects.set(project.id, sanitizeProject(project));
  }

  async updateProject(project: ResearchProject): Promise<void> {
    this.projects.set(project.id, sanitizeProject(project));
  }

  async listProjects(): Promise<ResearchProject[]> {
    return [...this.projects.values()].map(sanitizeProject).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async getProject(projectId: string): Promise<ResearchProject | undefined> {
    const project = this.projects.get(projectId);
    return project ? sanitizeProject(project) : undefined;
  }

  async saveSessions(sessions: ResearchSession[]): Promise<void> {
    this.sessions = this.upsertMany(this.sessions, sessions);
  }

  async deleteSession(projectId: string, sessionId: string): Promise<void> {
    this.sessions = this.sessions.filter((session) => session.projectId !== projectId || session.id !== sessionId);
  }

  async saveDatabase(database: ResearchDatabase): Promise<void> {
    this.databases.set(database.projectId, database);
  }

  async saveResearchInput(input: ResearchInput): Promise<void> {
    this.researchInputs = this.upsertMany(this.researchInputs, [input]);
  }

  async saveQuestions(questions: ResearchQuestion[]): Promise<void> {
    this.questions = this.upsertMany(this.questions, questions);
  }

  async saveHypotheses(hypotheses: import("./types.js").Hypothesis[]): Promise<void> {
    this.hypotheses = this.upsertMany(this.hypotheses, hypotheses);
  }

  async saveEvidence(evidence: EvidenceItem[]): Promise<void> {
    this.evidence = this.upsertMany(this.evidence, evidence);
  }

  async saveArtifacts(artifacts: ResearchArtifact[]): Promise<void> {
    this.artifacts = this.upsertMany(this.artifacts, artifacts);
  }

  async saveSources(sources: ResearchSource[]): Promise<void> {
    this.sources = this.upsertMany(this.sources, sources);
  }

  async saveChunks(chunks: ResearchChunk[]): Promise<void> {
    this.chunks = this.upsertMany(this.chunks, chunks);
  }

  async saveToolRuns(toolRuns: ToolRun[]): Promise<void> {
    this.toolRuns = this.upsertMany(this.toolRuns, toolRuns);
  }

  async saveAgentPlan(plan: AgentPlan): Promise<void> {
    this.agentPlans = this.upsertMany(this.agentPlans, [plan]);
  }

  async saveResearchSpecification(specification: ResearchSpecification): Promise<void> {
    this.specifications = this.upsertMany(this.specifications, [specification]);
  }

  async saveResearchPlan(plan: ResearchPlan): Promise<void> {
    this.researchPlans = this.upsertMany(this.researchPlans, [plan]);
    this.agentPlans = this.upsertMany(this.agentPlans, [plan]);
  }

  async saveNormalizedRecords(records: NormalizedResearchRecord[]): Promise<void> {
    this.normalizedRecords = this.upsertMany(this.normalizedRecords, records);
  }

  async saveOntologyEntities(entities: OntologyEntity[]): Promise<void> {
    this.ontologyEntities = this.upsertMany(this.ontologyEntities, entities);
  }

  async saveOntologyRelations(relations: OntologyRelation[]): Promise<void> {
    this.ontologyRelations = this.upsertMany(this.ontologyRelations, relations);
  }

  async saveOntologyConstraints(constraints: OntologyConstraint[]): Promise<void> {
    this.ontologyConstraints = this.upsertMany(this.ontologyConstraints, constraints);
  }

  async saveProjectContextSnapshot(context: ProjectContextSnapshot): Promise<void> {
    this.projectContextSnapshots = this.upsertMany(this.projectContextSnapshots, [context]);
  }

  async saveHybridContext(context: HybridContext): Promise<void> {
    this.hybridContexts = this.upsertMany(this.hybridContexts, [context]);
  }

  async saveValidationResults(results: import("./types.js").ValidationResult[]): Promise<void> {
    this.validationResults = this.upsertMany(this.validationResults, results);
  }

  async saveContinuationDecision(decision: ContinuationDecision): Promise<void> {
    this.continuationDecisions = this.upsertMany(this.continuationDecisions, [decision]);
  }

  async saveFinalResearchOutput(output: FinalResearchOutput): Promise<void> {
    this.finalOutputs = this.upsertMany(this.finalOutputs, [output]);
  }

  async saveGlobalMemoryItems(items: GlobalMemoryItem[]): Promise<void> {
    this.globalMemoryItems = this.upsertMany(this.globalMemoryItems, items);
  }

  async saveRuntimeBlocker(blocker: RuntimeBlocker): Promise<void> {
    this.runtimeBlockers = this.upsertMany(this.runtimeBlockers, [blocker]);
  }

  async saveStepError(error: StepError): Promise<void> {
    this.stepErrors = this.upsertMany(this.stepErrors, [error]);
  }

  async saveOpenCodeRun(run: OpenCodeRun): Promise<void> {
    this.openCodeRuns = this.upsertMany(this.openCodeRuns, [run]);
  }

  async saveRagContext(context: RagContext): Promise<void> {
    this.ragContexts = this.upsertMany(this.ragContexts, [context]);
  }

  async saveResult(result: EvidenceBasedResult): Promise<void> {
    this.results = this.upsertMany(this.results, [result]);
  }

  async saveIteration(iteration: LoopIteration): Promise<void> {
    this.iterations = this.upsertMany(this.iterations, [iteration]);
  }

  async saveReport(report: ResearchReport): Promise<void> {
    this.reports.set(report.projectId, report);
  }

  async getSnapshot(projectId: string): Promise<ResearchSnapshot> {
    const project = await this.getProject(projectId);
    if (!project) {
      throw new Error(`Research project not found: ${projectId}`);
    }

    return {
      project,
      sessions: this.sessions.filter((item) => item.projectId === projectId),
      database: this.databases.get(projectId),
      researchInputs: this.researchInputs.filter((item) => item.projectId === projectId),
      questions: this.questions.filter((item) => item.projectId === projectId),
      hypotheses: this.hypotheses.filter((item) => item.projectId === projectId),
      evidence: this.evidence.filter((item) => item.projectId === projectId),
      artifacts: this.artifacts.filter((item) => item.projectId === projectId),
      sources: this.sources.filter((item) => item.projectId === projectId),
      chunks: visibleInProject(this.chunks, projectId),
      toolRuns: this.toolRuns.filter((item) => item.projectId === projectId),
      agentPlans: this.agentPlans.filter((item) => item.projectId === projectId),
      researchPlans: this.researchPlans.filter((item) => item.projectId === projectId),
      specifications: this.specifications.filter((item) => item.projectId === projectId),
      normalizedRecords: visibleInProject(this.normalizedRecords, projectId),
      ontologyEntities: visibleInProject(this.ontologyEntities, projectId),
      ontologyRelations: visibleInProject(this.ontologyRelations, projectId),
      ontologyConstraints: visibleInProject(this.ontologyConstraints, projectId),
      projectContextSnapshots: this.projectContextSnapshots.filter((item) => item.projectId === projectId),
      hybridContexts: this.hybridContexts.filter((item) => item.projectId === projectId),
      validationResults: this.validationResults.filter((item) => item.projectId === projectId),
      continuationDecisions: this.continuationDecisions.filter((item) => item.projectId === projectId),
      finalOutputs: this.finalOutputs.filter((item) => item.projectId === projectId),
      globalMemoryItems: visibleInProject(this.globalMemoryItems, projectId),
      runtimeBlockers: this.runtimeBlockers.filter((item) => item.projectId === projectId),
      stepErrors: this.stepErrors.filter((item) => item.projectId === projectId),
      openCodeRuns: this.openCodeRuns.filter((item) => item.projectId === projectId),
      ragContexts: this.ragContexts.filter((item) => item.projectId === projectId),
      results: this.results.filter((item) => item.projectId === projectId),
      iterations: this.iterations.filter((item) => item.projectId === projectId),
      report: this.reports.get(projectId)
    };
  }

  private upsertMany<T extends { id: string }>(existing: T[], incoming: T[]): T[] {
    const merged = new Map(existing.map((item) => [item.id, item]));
    for (const item of incoming) {
      merged.set(item.id, item);
    }
    return [...merged.values()];
  }
}

function sanitizeProject(project: ResearchProject): ResearchProject {
  const { maxLoopIterations: _legacyMaxLoopIterations, ...autonomyPolicy } = project.autonomyPolicy as ResearchProject["autonomyPolicy"] & {
    maxLoopIterations?: number;
  };
  return { ...project, autonomyPolicy };
}

function visibleInProject<T extends ScopedProjectItem>(items: T[], projectId: string): T[] {
  return items.filter((item) => item.projectId === projectId || item.workspaceProjectId === projectId);
}
