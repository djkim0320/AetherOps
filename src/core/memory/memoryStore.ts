import type {
  EvidenceBasedResult,
  EvidenceItem,
  AgentPlan,
  ContinuationDecision,
  FinalResearchOutput,
  GlobalMemoryItem,
  BenchmarkPlan,
  HybridContext,
  LoopIteration,
  NormalizedResearchRecord,
  LegacyAgentRun,
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
  RunAuditOutput,
  RuntimeBlocker,
  StepError,
  ToolRun,
  MainMemorySearchOptions
} from "../shared/types.js";
import { byProject, searchItems, visibleInProject } from "./memoryStoreSearch.js";

export class InMemoryResearchStore implements ResearchStore {
  private projects = new Map<string, ResearchProject>();
  private databases = new Map<string, ResearchDatabase>();
  private sessions: ResearchSession[] = [];
  private researchInputs: ResearchInput[] = [];
  private questions: ResearchQuestion[] = [];
  private hypotheses: import("../shared/types.js").Hypothesis[] = [];
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
  private validationResults: import("../shared/types.js").ValidationResult[] = [];
  private continuationDecisions: ContinuationDecision[] = [];
  private finalOutputs: FinalResearchOutput[] = [];
  private runAuditOutputs: RunAuditOutput[] = [];
  private benchmarkPlans: BenchmarkPlan[] = [];
  private globalMemoryItems: GlobalMemoryItem[] = [];
  private runtimeBlockers: RuntimeBlocker[] = [];
  private stepErrors: StepError[] = [];
  private legacyAgentRuns: LegacyAgentRun[] = [];
  private ragContexts: RagContext[] = [];
  private results: EvidenceBasedResult[] = [];
  private iterations: LoopIteration[] = [];
  private reports = new Map<string, ResearchReport>();

  async saveProject(project: ResearchProject): Promise<void> {
    this.projects.set(project.id, project);
  }

  async updateProject(project: ResearchProject): Promise<void> {
    this.projects.set(project.id, project);
  }

  async listProjects(): Promise<ResearchProject[]> {
    const projects: ResearchProject[] = [];
    for (const project of this.projects.values()) {
      projects.push(project);
    }
    projects.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return projects;
  }

  async getProject(projectId: string): Promise<ResearchProject | undefined> {
    const project = this.projects.get(projectId);
    return project;
  }

  async saveSessions(sessions: ResearchSession[]): Promise<void> {
    this.sessions = this.upsertMany(this.sessions, sessions);
  }

  async deleteSession(projectId: string, sessionId: string): Promise<void> {
    const remaining: ResearchSession[] = [];
    for (const session of this.sessions) {
      if (session.projectId !== projectId || session.id !== sessionId) {
        remaining.push(session);
      }
    }
    this.sessions = remaining;
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

  async saveHypotheses(hypotheses: import("../shared/types.js").Hypothesis[]): Promise<void> {
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

  async saveValidationResults(results: import("../shared/types.js").ValidationResult[]): Promise<void> {
    this.validationResults = this.upsertMany(this.validationResults, results);
  }

  async saveContinuationDecision(decision: ContinuationDecision): Promise<void> {
    this.continuationDecisions = this.upsertMany(this.continuationDecisions, [decision]);
  }

  async saveFinalResearchOutput(output: FinalResearchOutput): Promise<void> {
    this.finalOutputs = this.upsertMany(this.finalOutputs, [output]);
  }

  async saveRunAuditOutput(output: RunAuditOutput): Promise<void> {
    this.runAuditOutputs = this.upsertMany(this.runAuditOutputs, [output]);
  }

  async saveBenchmarkPlan(plan: BenchmarkPlan): Promise<void> {
    this.benchmarkPlans = this.upsertMany(this.benchmarkPlans, [plan]);
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

  async saveLegacyAgentRun(run: LegacyAgentRun): Promise<void> {
    this.legacyAgentRuns = this.upsertMany(this.legacyAgentRuns, [run]);
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
      sessions: byProject(this.sessions, projectId),
      database: this.databases.get(projectId),
      researchInputs: byProject(this.researchInputs, projectId),
      questions: byProject(this.questions, projectId),
      hypotheses: byProject(this.hypotheses, projectId),
      evidence: byProject(this.evidence, projectId),
      artifacts: byProject(this.artifacts, projectId),
      sources: byProject(this.sources, projectId),
      chunks: visibleInProject(this.chunks, projectId),
      toolRuns: byProject(this.toolRuns, projectId),
      agentPlans: byProject(this.agentPlans, projectId),
      researchPlans: byProject(this.researchPlans, projectId),
      specifications: byProject(this.specifications, projectId),
      normalizedRecords: visibleInProject(this.normalizedRecords, projectId),
      ontologyEntities: visibleInProject(this.ontologyEntities, projectId),
      ontologyRelations: visibleInProject(this.ontologyRelations, projectId),
      ontologyConstraints: visibleInProject(this.ontologyConstraints, projectId),
      projectContextSnapshots: byProject(this.projectContextSnapshots, projectId),
      hybridContexts: byProject(this.hybridContexts, projectId),
      validationResults: byProject(this.validationResults, projectId),
      continuationDecisions: byProject(this.continuationDecisions, projectId),
      finalOutputs: byProject(this.finalOutputs, projectId),
      runAuditOutputs: byProject(this.runAuditOutputs, projectId),
      benchmarkPlans: byProject(this.benchmarkPlans, projectId),
      globalMemoryItems: visibleInProject(this.globalMemoryItems, projectId),
      runtimeBlockers: byProject(this.runtimeBlockers, projectId),
      stepErrors: byProject(this.stepErrors, projectId),
      legacyAgentRuns: byProject(this.legacyAgentRuns, projectId),
      ragContexts: byProject(this.ragContexts, projectId),
      results: byProject(this.results, projectId),
      iterations: byProject(this.iterations, projectId),
      report: this.reports.get(projectId)
    };
  }

  async searchGlobalRecords(query: string, options: MainMemorySearchOptions = {}): Promise<NormalizedResearchRecord[]> {
    return searchItems(this.normalizedRecords, query, options);
  }

  async searchGlobalChunks(query: string, options: MainMemorySearchOptions = {}): Promise<ResearchChunk[]> {
    return searchItems(this.chunks, query, options, (chunk) => `${chunk.text}\n${chunk.keywords.join(" ")}\n${chunk.citation ?? ""}`);
  }

  async searchGlobalGraph(
    query: string,
    options: MainMemorySearchOptions = {}
  ): Promise<{
    entities: OntologyEntity[];
    relations: OntologyRelation[];
    constraints: OntologyConstraint[];
  }> {
    const entities = searchItems(this.ontologyEntities, query, options, (entity) => `${entity.label}\n${entity.description ?? ""}`);
    const entityIds = new Set<string>();
    for (const entity of entities) {
      entityIds.add(entity.id);
    }
    const relationLimit = options.limit ?? 24;
    const relationCandidates = searchItems(
      this.ontologyRelations,
      query,
      { ...options, limit: Math.max(relationLimit, 24) },
      (relation) => `${relation.subjectId} ${relation.predicate} ${relation.objectId}`
    );
    const relations: OntologyRelation[] = [];
    for (const relation of relationCandidates) {
      if (!entityIds.has(relation.subjectId) && !entityIds.has(relation.objectId)) continue;
      relations.push(relation);
      if (relations.length >= relationLimit) break;
    }
    const constraints = searchItems(this.ontologyConstraints, query, options, (constraint) => `${constraint.label}\n${constraint.description}`);
    return { entities, relations, constraints };
  }

  private upsertMany<T extends { id: string }>(existing: T[], incoming: T[]): T[] {
    const merged = new Map<string, T>();
    for (const item of existing) {
      merged.set(item.id, item);
    }
    for (const item of incoming) {
      merged.set(item.id, item);
    }
    return [...merged.values()];
  }
}
