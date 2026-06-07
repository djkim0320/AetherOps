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
  RunAuditOutput,
  RuntimeBlocker,
  StepError,
  ToolRun,
  MainMemorySearchOptions
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
  private runAuditOutputs: RunAuditOutput[] = [];
  private benchmarkPlans: BenchmarkPlan[] = [];
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
    const projects: ResearchProject[] = [];
    for (const project of this.projects.values()) {
      projects.push(sanitizeProject(project));
    }
    projects.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return projects;
  }

  async getProject(projectId: string): Promise<ResearchProject | undefined> {
    const project = this.projects.get(projectId);
    return project ? sanitizeProject(project) : undefined;
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
      openCodeRuns: byProject(this.openCodeRuns, projectId),
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

  async searchGlobalGraph(query: string, options: MainMemorySearchOptions = {}): Promise<{
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
    const relationCandidates = searchItems(this.ontologyRelations, query, { ...options, limit: Math.max(relationLimit, 24) }, (relation) =>
      `${relation.subjectId} ${relation.predicate} ${relation.objectId}`
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

function sanitizeProject(project: ResearchProject): ResearchProject {
  return project;
}

function byProject<T extends { projectId: string }>(items: T[], projectId: string): T[] {
  const selected: T[] = [];
  for (const item of items) {
    if (item.projectId === projectId) {
      selected.push(item);
    }
  }
  return selected;
}

function visibleInProject<T extends ScopedProjectItem>(items: T[], projectId: string): T[] {
  const visible: T[] = [];
  for (const item of items) {
    if (item.projectId === projectId || item.workspaceProjectId === projectId || normalizeMemoryScope(item.memoryScope) === "global") {
      visible.push(item);
    }
  }
  return visible;
}

function searchItems<T extends ScopedProjectItem>(
  items: T[],
  query: string,
  options: MainMemorySearchOptions,
  textOf: (item: T) => string = (item) => {
    const record = item as T & { title?: string; content?: string; metadata?: unknown };
    return `${record.title ?? ""}\n${record.content ?? ""}\n${JSON.stringify(record.metadata ?? {})}`;
  }
): T[] {
  const limit = options.limit ?? 24;
  const queryTokens = new Set(tokens(query));
  const scored: Array<{ item: T; score: number }> = [];
  for (const item of items) {
    const scope = normalizeMemoryScope(item.memoryScope);
    if (
      options.projectId &&
      item.projectId !== options.projectId &&
      item.workspaceProjectId !== options.projectId &&
      scope !== "global"
    ) {
      continue;
    }
    if (!options.includeEphemeral && scope === "ephemeral") continue;
    if ((item as T & { validationStatus?: string }).validationStatus === "rejected") continue;
    const score = lexicalScore(queryTokens, textOf(item));
    if (scope === "global" && score <= 0) continue;
    scored.push({ item, score });
  }
  scored.sort((left, right) => right.score - left.score);
  const output: T[] = [];
  for (let index = 0; index < scored.length && index < limit; index += 1) {
    output.push(scored[index].item);
  }
  return output;
}

function lexicalScore(queryTokens: Set<string>, text: string): number {
  if (!queryTokens.size) return 0;
  let score = 0;
  const weight = 1 / queryTokens.size;
  for (const token of tokens(text)) {
    if (queryTokens.has(token)) score += weight;
  }
  return score;
}

function tokens(text: string): string[] {
  return text.toLowerCase().replace(/[^\p{L}\p{N}\s-]/gu, " ").match(/\S+/g) ?? [];
}
