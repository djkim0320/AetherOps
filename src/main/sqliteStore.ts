import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type {
  EvidenceBasedResult,
  EvidenceItem,
  AgentPlan,
  Hypothesis,
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
} from "../core/types.js";

type JsonRecord = { id: string; project_id?: string; created_at?: string; data: string };

export class SqliteResearchStore implements ResearchStore {
  private readonly db: DatabaseSync;
  private closed = false;

  constructor(private readonly sqlitePath: string) {
    const parent = dirname(sqlitePath);
    if (!existsSync(parent)) {
      mkdirSync(parent, { recursive: true });
    }
    this.db = new DatabaseSync(sqlitePath);
    this.migrate();
  }

  async saveProject(project: ResearchProject): Promise<void> {
    this.upsertProject(project);
  }

  async updateProject(project: ResearchProject): Promise<void> {
    this.upsertProject(project);
  }

  async listProjects(): Promise<ResearchProject[]> {
    return this.all("projects").map((row) => this.parse<ResearchProject>(row)).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async getProject(projectId: string): Promise<ResearchProject | undefined> {
    const row = this.db.prepare("select id, data from projects where id = ?").get(projectId) as JsonRecord | undefined;
    return row ? this.parse<ResearchProject>(row) : undefined;
  }

  async saveSessions(sessions: ResearchSession[]): Promise<void> {
    this.upsertMany("sessions", sessions);
  }

  async deleteSession(projectId: string, sessionId: string): Promise<void> {
    this.db.prepare("delete from sessions where project_id = ? and id = ?").run(projectId, sessionId);
  }

  async saveDatabase(database: ResearchDatabase): Promise<void> {
    this.upsertMany("research_databases", [database]);
  }

  async saveQuestions(questions: ResearchQuestion[]): Promise<void> {
    this.upsertMany("questions", questions);
  }

  async saveHypotheses(hypotheses: Hypothesis[]): Promise<void> {
    this.upsertMany("hypotheses", hypotheses);
  }

  async saveEvidence(evidence: EvidenceItem[]): Promise<void> {
    this.upsertMany("evidence", evidence);
  }

  async saveArtifacts(artifacts: ResearchArtifact[]): Promise<void> {
    this.upsertMany("artifacts", artifacts);
  }

  async saveSources(sources: ResearchSource[]): Promise<void> {
    this.upsertMany("sources", sources.map((source) => ({ ...source, createdAt: source.createdAt ?? source.retrievedAt })));
  }

  async saveChunks(chunks: ResearchChunk[]): Promise<void> {
    this.upsertMany("chunks", chunks);
  }

  async saveToolRuns(toolRuns: ToolRun[]): Promise<void> {
    this.upsertMany("tool_runs", toolRuns);
  }

  async saveAgentPlan(plan: AgentPlan): Promise<void> {
    this.upsertMany("agent_plans", [plan]);
  }

  async saveOpenCodeRun(run: OpenCodeRun): Promise<void> {
    this.upsertMany("opencode_runs", [run]);
  }

  async saveRagContext(context: RagContext): Promise<void> {
    this.upsertMany("rag_contexts", [context]);
  }

  async saveResult(result: EvidenceBasedResult): Promise<void> {
    this.upsertMany("results", [result]);
  }

  async saveIteration(iteration: LoopIteration): Promise<void> {
    this.upsertMany("iterations", [iteration]);
  }

  async saveReport(report: ResearchReport): Promise<void> {
    this.upsertMany("reports", [report]);
  }

  async getSnapshot(projectId: string): Promise<ResearchSnapshot> {
    const project = await this.getProject(projectId);
    if (!project) {
      throw new Error(`Research project not found: ${projectId}`);
    }

    return {
      project,
      sessions: this.byProject<ResearchSession>("sessions", projectId),
      database: this.byProject<ResearchDatabase>("research_databases", projectId).at(-1),
      questions: this.byProject<ResearchQuestion>("questions", projectId),
      hypotheses: this.byProject<Hypothesis>("hypotheses", projectId),
      evidence: this.byProject<EvidenceItem>("evidence", projectId),
      artifacts: this.byProject<ResearchArtifact>("artifacts", projectId),
      sources: this.byProject<ResearchSource>("sources", projectId),
      chunks: this.byProject<ResearchChunk>("chunks", projectId),
      toolRuns: this.byProject<ToolRun>("tool_runs", projectId),
      agentPlans: this.byProject<AgentPlan>("agent_plans", projectId),
      openCodeRuns: this.byProject<OpenCodeRun>("opencode_runs", projectId),
      ragContexts: this.byProject<RagContext>("rag_contexts", projectId),
      results: this.byProject<EvidenceBasedResult>("results", projectId),
      iterations: this.byProject<LoopIteration>("iterations", projectId),
      report: this.byProject<ResearchReport>("reports", projectId).at(-1)
    };
  }

  close(): void {
    if (this.closed) {
      return;
    }
    this.db.close();
    this.closed = true;
  }

  private migrate(): void {
    const tables = [
      "projects",
      "sessions",
      "research_databases",
      "questions",
      "hypotheses",
      "evidence",
      "artifacts",
      "sources",
      "chunks",
      "tool_runs",
      "agent_plans",
      "opencode_runs",
      "rag_contexts",
      "results",
      "iterations",
      "reports"
    ];

    this.db.exec("pragma journal_mode = WAL");
    for (const table of tables) {
      if (table === "projects") {
        this.db.exec(`create table if not exists ${table} (id text primary key, created_at text not null, data text not null)`);
      } else {
        this.db.exec(
          `create table if not exists ${table} (id text primary key, project_id text not null, created_at text not null, data text not null)`
        );
        this.db.exec(`create index if not exists idx_${table}_project on ${table}(project_id, created_at)`);
      }
    }
  }

  private upsertProject(project: ResearchProject): void {
    this.db
      .prepare("insert into projects (id, created_at, data) values (?, ?, ?) on conflict(id) do update set data = excluded.data")
      .run(project.id, project.createdAt, JSON.stringify(project));
  }

  private upsertMany<T extends { id: string; projectId: string; createdAt?: string; startedAt?: string }>(table: string, items: T[]): void {
    const statement = this.db.prepare(
      `insert into ${table} (id, project_id, created_at, data) values (?, ?, ?, ?) on conflict(id) do update set data = excluded.data`
    );
    this.db.exec("begin");
    try {
      for (const item of items) {
        statement.run(item.id, item.projectId, item.createdAt ?? item.startedAt ?? new Date().toISOString(), JSON.stringify(item));
      }
      this.db.exec("commit");
    } catch (error) {
      this.db.exec("rollback");
      throw error;
    }
  }

  private all(table: string): JsonRecord[] {
    return this.db.prepare(`select id, data from ${table}`).all() as JsonRecord[];
  }

  private byProject<T>(table: string, projectId: string): T[] {
    const rows = this.db
      .prepare(`select id, project_id, created_at, data from ${table} where project_id = ? order by created_at asc`)
      .all(projectId) as JsonRecord[];
    return rows.map((row) => this.parse<T>(row));
  }

  private parse<T>(row: JsonRecord): T {
    return JSON.parse(row.data) as T;
  }
}
