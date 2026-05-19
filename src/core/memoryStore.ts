import type {
  EvidenceBasedResult,
  EvidenceItem,
  AgentPlan,
  LoopIteration,
  OpenCodeRun,
  RagContext,
  ResearchArtifact,
  ResearchChunk,
  ResearchDatabase,
  ResearchProject,
  ResearchQuestion,
  ResearchReport,
  ResearchSession,
  ResearchSource,
  ResearchSnapshot,
  ResearchStore,
  ToolRun
} from "./types.js";

export class InMemoryResearchStore implements ResearchStore {
  private projects = new Map<string, ResearchProject>();
  private databases = new Map<string, ResearchDatabase>();
  private sessions: ResearchSession[] = [];
  private questions: ResearchQuestion[] = [];
  private hypotheses: import("./types.js").Hypothesis[] = [];
  private evidence: EvidenceItem[] = [];
  private artifacts: ResearchArtifact[] = [];
  private sources: ResearchSource[] = [];
  private chunks: ResearchChunk[] = [];
  private toolRuns: ToolRun[] = [];
  private agentPlans: AgentPlan[] = [];
  private openCodeRuns: OpenCodeRun[] = [];
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
    return [...this.projects.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async getProject(projectId: string): Promise<ResearchProject | undefined> {
    return this.projects.get(projectId);
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
    const project = this.projects.get(projectId);
    if (!project) {
      throw new Error(`Research project not found: ${projectId}`);
    }

    return {
      project,
      sessions: this.sessions.filter((item) => item.projectId === projectId),
      database: this.databases.get(projectId),
      questions: this.questions.filter((item) => item.projectId === projectId),
      hypotheses: this.hypotheses.filter((item) => item.projectId === projectId),
      evidence: this.evidence.filter((item) => item.projectId === projectId),
      artifacts: this.artifacts.filter((item) => item.projectId === projectId),
      sources: this.sources.filter((item) => item.projectId === projectId),
      chunks: this.chunks.filter((item) => item.projectId === projectId),
      toolRuns: this.toolRuns.filter((item) => item.projectId === projectId),
      agentPlans: this.agentPlans.filter((item) => item.projectId === projectId),
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
