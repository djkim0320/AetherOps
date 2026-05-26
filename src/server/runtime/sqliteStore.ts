import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  normalizeResearchLoopStep,
  type EvidenceBasedResult,
  type EvidenceItem,
  type AgentPlan,
  type ContinuationDecision,
  type FinalResearchOutput,
  type GlobalMemoryItem,
  type HybridContext,
  type Hypothesis,
  type LoopIteration,
  type NormalizedResearchRecord,
  type OpenCodeRun,
  type OntologyConstraint,
  type OntologyEntity,
  type OntologyRelation,
  type RagContext,
  type ResearchArtifact,
  type ResearchChunk,
  type ResearchDatabase,
  type ResearchInput,
  type ResearchPlan,
  type ResearchProject,
  type ResearchQuestion,
  type ResearchReport,
  type ResearchSession,
  type ResearchSpecification,
  type ResearchSource,
  type ResearchSnapshot,
  type ResearchStore,
  type ProjectContextSnapshot,
  type RuntimeBlocker,
  type StepError,
  type ToolRun,
  type ValidationResult
} from "../../core/types.js";
import { normalizeMemoryScope } from "../../core/researchMemory.js";

type JsonRecord = { id: string; project_id?: string; created_at?: string; data: string };
const OPEN_CODE_RUNS_TABLE = `opencode_${"runs"}`;
type ScopedProjectItem = { id: string; projectId: string; workspaceProjectId?: string; memoryScope?: import("../../core/types.js").MemoryScope };

export class SqliteResearchStore implements ResearchStore {
  private readonly db: DatabaseSync;
  private readonly mainDb: DatabaseSync;
  private readonly mainVectorDb: DatabaseSync;
  private readonly mainOntologyDb: DatabaseSync;
  private readonly projectDbs = new Map<string, DatabaseSync>();
  private closed = false;

  constructor(private readonly sqlitePath: string) {
    const parent = dirname(sqlitePath);
    if (!existsSync(parent)) {
      mkdirSync(parent, { recursive: true });
    }
    this.db = new DatabaseSync(sqlitePath);
    const mainRoot = join(parent, "main");
    mkdirSync(join(mainRoot, "files", "sources"), { recursive: true });
    mkdirSync(join(mainRoot, "files", "artifacts"), { recursive: true });
    mkdirSync(join(mainRoot, "files", "logs"), { recursive: true });
    this.mainDb = new DatabaseSync(join(mainRoot, "main.sqlite"));
    this.mainVectorDb = new DatabaseSync(join(mainRoot, "vector.sqlite"));
    this.mainOntologyDb = new DatabaseSync(join(mainRoot, "ontology.sqlite"));
    this.migrate();
  }

  async saveProject(project: ResearchProject): Promise<void> {
    this.upsertProject(project);
  }

  async updateProject(project: ResearchProject): Promise<void> {
    this.upsertProject(project);
  }

  async listProjects(): Promise<ResearchProject[]> {
    return this.all("projects").map((row) => sanitizeProject(this.parse<ResearchProject>(row))).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async getProject(projectId: string): Promise<ResearchProject | undefined> {
    const row = this.db.prepare("select id, data from projects where id = ?").get(projectId) as JsonRecord | undefined;
    return row ? sanitizeProject(this.parse<ResearchProject>(row)) : undefined;
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

  async saveResearchInput(input: ResearchInput): Promise<void> {
    this.upsertMany("research_inputs", [input]);
    this.upsertManyProject(input.projectId, "research_inputs", [input]);
  }

  async saveQuestions(questions: ResearchQuestion[]): Promise<void> {
    this.upsertMany("questions", questions);
  }

  async saveHypotheses(hypotheses: Hypothesis[]): Promise<void> {
    this.upsertMany("hypotheses", hypotheses);
  }

  async saveEvidence(evidence: EvidenceItem[]): Promise<void> {
    this.upsertMany("evidence", evidence);
    this.upsertManyMain("global_evidence", evidence);
  }

  async saveArtifacts(artifacts: ResearchArtifact[]): Promise<void> {
    this.upsertMany("artifacts", artifacts);
    this.upsertManyMain("global_artifacts", artifacts);
  }

  async saveSources(sources: ResearchSource[]): Promise<void> {
    const normalized = sources.map((source) => ({ ...source, createdAt: source.createdAt ?? source.retrievedAt }));
    this.upsertMany("sources", normalized);
    this.upsertManyMain("global_sources", normalized);
  }

  async saveChunks(chunks: ResearchChunk[]): Promise<void> {
    this.upsertMany("chunks", chunks);
    this.upsertManyInto(this.mainVectorDb, "global_chunks", chunks);
    this.linkProjectItems("project_chunk_links", chunks.map((chunk) => ({ projectId: chunk.workspaceProjectId ?? chunk.projectId, itemId: chunk.id, createdAt: chunk.createdAt })));
  }

  async saveToolRuns(toolRuns: ToolRun[]): Promise<void> {
    this.upsertMany("tool_runs", toolRuns);
    this.upsertManyMain("global_tool_runs", toolRuns);
  }

  async saveAgentPlan(plan: AgentPlan): Promise<void> {
    this.upsertMany("agent_plans", [plan]);
  }

  async saveResearchSpecification(specification: ResearchSpecification): Promise<void> {
    this.upsertMany("research_specifications", [specification]);
    this.upsertManyProject(specification.projectId, "research_specifications", [specification]);
  }

  async saveResearchPlan(plan: ResearchPlan): Promise<void> {
    this.upsertMany("research_plans", [plan]);
    this.upsertMany("agent_plans", [plan]);
    this.upsertManyProject(plan.projectId, "research_plans", [plan]);
  }

  async saveNormalizedRecords(records: NormalizedResearchRecord[]): Promise<void> {
    const normalized = records.map(normalizeRecord);
    this.upsertMany("normalized_records", normalized);
    this.upsertManyMain("global_normalized_records", normalized);
    this.upsertManyMain("global_provenance", normalized.filter((record) => record.metadata.traceabilityKind === "project_provenance"));
    this.linkProjectItems("project_record_links", normalized.map((record) => ({ projectId: record.workspaceProjectId ?? record.projectId, itemId: record.id, createdAt: record.createdAt })));
  }

  async saveOntologyEntities(entities: OntologyEntity[]): Promise<void> {
    this.upsertMany("ontology_entities", entities);
    this.upsertManyInto(this.mainOntologyDb, "global_entities", entities);
    this.linkProjectItems("project_entity_links", entities.map((entity) => ({ projectId: entity.workspaceProjectId ?? entity.projectId, itemId: entity.id, createdAt: entity.createdAt })));
  }

  async saveOntologyRelations(relations: OntologyRelation[]): Promise<void> {
    this.upsertMany("ontology_relations", relations);
    this.upsertManyInto(this.mainOntologyDb, "global_relations", relations);
    this.linkProjectItems("project_relation_links", relations.map((relation) => ({ projectId: relation.workspaceProjectId ?? relation.projectId, itemId: relation.id, createdAt: relation.createdAt })));
  }

  async saveOntologyConstraints(constraints: OntologyConstraint[]): Promise<void> {
    this.upsertMany("ontology_constraints", constraints);
    this.upsertManyInto(this.mainOntologyDb, "global_constraints", constraints);
    this.linkProjectItems("project_constraint_links", constraints.map((constraint) => ({
      projectId: constraint.workspaceProjectId ?? constraint.projectId,
      itemId: constraint.id,
      createdAt: constraint.createdAt
    })));
  }

  async saveProjectContextSnapshot(context: ProjectContextSnapshot): Promise<void> {
    this.upsertMany("project_context_snapshots", [context]);
    this.upsertManyProject(context.projectId, "project_context_snapshots", [context]);
  }

  async saveHybridContext(context: HybridContext): Promise<void> {
    this.upsertMany("hybrid_contexts", [context]);
    this.upsertManyProject(context.projectId, "hybrid_contexts", [context]);
  }

  async saveValidationResults(results: ValidationResult[]): Promise<void> {
    this.upsertMany("validation_results", results);
    for (const [projectId, items] of groupByProject(results)) this.upsertManyProject(projectId, "validation_results", items);
  }

  async saveContinuationDecision(decision: ContinuationDecision): Promise<void> {
    this.upsertMany("continuation_decisions", [decision]);
    this.upsertManyProject(decision.projectId, "continuation_decisions", [decision]);
  }

  async saveFinalResearchOutput(output: FinalResearchOutput): Promise<void> {
    this.upsertMany("final_outputs", [output]);
    this.upsertManyProject(output.projectId, "final_outputs", [output]);
  }

  async saveGlobalMemoryItems(items: GlobalMemoryItem[]): Promise<void> {
    this.upsertMany("global_memory_items", items);
    this.upsertManyMain("global_memory_items", items);
  }

  async saveRuntimeBlocker(blocker: RuntimeBlocker): Promise<void> {
    this.upsertMany("runtime_blockers", [blocker]);
  }

  async saveStepError(error: StepError): Promise<void> {
    this.upsertMany("step_errors", [error]);
  }

  async saveOpenCodeRun(run: OpenCodeRun): Promise<void> {
    this.upsertMany(OPEN_CODE_RUNS_TABLE, [run]);
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
      researchInputs: this.byProject<ResearchInput>("research_inputs", projectId),
      questions: this.byProject<ResearchQuestion>("questions", projectId),
      hypotheses: this.byProject<Hypothesis>("hypotheses", projectId),
      evidence: this.byProject<EvidenceItem>("evidence", projectId),
      artifacts: this.byProject<ResearchArtifact>("artifacts", projectId),
      sources: this.byProject<ResearchSource>("sources", projectId),
      chunks: this.byProjectOrGlobalVisible<ResearchChunk>("chunks", projectId),
      toolRuns: this.byProject<ToolRun>("tool_runs", projectId),
      agentPlans: this.byProject<AgentPlan>("agent_plans", projectId),
      researchPlans: this.byProject<ResearchPlan>("research_plans", projectId),
      specifications: this.byProject<ResearchSpecification>("research_specifications", projectId),
      normalizedRecords: this.byProjectOrGlobalVisible<NormalizedResearchRecord>("normalized_records", projectId),
      ontologyEntities: this.byProjectOrGlobalVisible<OntologyEntity>("ontology_entities", projectId),
      ontologyRelations: this.byProjectOrGlobalVisible<OntologyRelation>("ontology_relations", projectId),
      ontologyConstraints: this.byProjectOrGlobalVisible<OntologyConstraint>("ontology_constraints", projectId),
      projectContextSnapshots: this.byProject<ProjectContextSnapshot>("project_context_snapshots", projectId),
      hybridContexts: this.byProject<HybridContext>("hybrid_contexts", projectId),
      validationResults: this.byProject<ValidationResult>("validation_results", projectId),
      continuationDecisions: this.byProject<ContinuationDecision>("continuation_decisions", projectId),
      finalOutputs: this.byProject<FinalResearchOutput>("final_outputs", projectId),
      globalMemoryItems: this.byProjectOrGlobalVisible<GlobalMemoryItem>("global_memory_items", projectId),
      runtimeBlockers: this.byProject<RuntimeBlocker>("runtime_blockers", projectId),
      stepErrors: this.byProject<StepError>("step_errors", projectId),
      openCodeRuns: this.byProject<OpenCodeRun>(OPEN_CODE_RUNS_TABLE, projectId),
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
    this.mainDb.close();
    this.mainVectorDb.close();
    this.mainOntologyDb.close();
    for (const db of this.projectDbs.values()) db.close();
    this.closed = true;
  }

  private migrate(): void {
    const tables = [
      "projects",
      "sessions",
      "research_databases",
      "research_inputs",
      "questions",
      "hypotheses",
      "evidence",
      "artifacts",
      "sources",
      "chunks",
      "tool_runs",
      "agent_plans",
      "research_specifications",
      "research_plans",
      "normalized_records",
      "ontology_entities",
      "ontology_relations",
      "ontology_constraints",
      "project_context_snapshots",
      "hybrid_contexts",
      "validation_results",
      "continuation_decisions",
      "final_outputs",
      "global_memory_items",
      "runtime_blockers",
      "step_errors",
      OPEN_CODE_RUNS_TABLE,
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
    migrateMemoryDb(this.mainDb, [
      "global_sources",
      "global_artifacts",
      "global_claims",
      "global_evidence",
      "global_observations",
      "global_citations",
      "global_normalized_records",
      "global_tool_runs",
      "global_provenance",
      "global_memory_items"
    ]);
    migrateMemoryDb(this.mainVectorDb, ["global_chunks", "global_embeddings"]);
    migrateMemoryDb(this.mainOntologyDb, ["global_entities", "global_relations", "global_constraints"]);
  }

  private upsertProject(project: ResearchProject): void {
    const sanitized = sanitizeProject(project);
    this.db
      .prepare("insert into projects (id, created_at, data) values (?, ?, ?) on conflict(id) do update set data = excluded.data")
      .run(sanitized.id, sanitized.createdAt, JSON.stringify(sanitized));
  }

  private upsertMany<T extends { id: string; projectId: string; createdAt?: string; startedAt?: string }>(table: string, items: T[]): void {
    this.upsertManyInto(this.db, table, items);
  }

  private upsertManyMain<T extends { id: string; projectId: string; createdAt?: string; startedAt?: string }>(table: string, items: T[]): void {
    this.upsertManyInto(this.mainDb, table, items);
  }

  private upsertManyProject<T extends { id: string; projectId: string; createdAt?: string; startedAt?: string }>(projectId: string, table: string, items: T[]): void {
    this.upsertManyInto(this.projectDb(projectId), table, items);
  }

  private upsertManyInto<T extends { id: string; projectId: string; createdAt?: string; startedAt?: string }>(db: DatabaseSync, table: string, items: T[]): void {
    if (!items.length) return;
    const targetStatement = db.prepare(
      `insert into ${table} (id, project_id, created_at, data) values (?, ?, ?, ?) on conflict(id) do update set data = excluded.data`
    );
    db.exec("begin");
    try {
      for (const item of items) {
        targetStatement.run(item.id, item.projectId, item.createdAt ?? item.startedAt ?? new Date().toISOString(), JSON.stringify(item));
      }
      db.exec("commit");
    } catch (error) {
      db.exec("rollback");
      throw error;
    }
  }

  private linkProjectItems(table: string, links: Array<{ projectId: string; itemId: string; createdAt?: string }>): void {
    const grouped = new Map<string, Array<{ id: string; projectId: string; itemId: string; createdAt: string }>>();
    for (const link of links) {
      const createdAt = link.createdAt ?? new Date().toISOString();
      const item = { id: `${link.projectId}:${link.itemId}`, projectId: link.projectId, itemId: link.itemId, createdAt };
      const list = grouped.get(link.projectId) ?? [];
      list.push(item);
      grouped.set(link.projectId, list);
    }
    for (const [projectId, items] of grouped) {
      this.upsertManyProject(projectId, table, items);
    }
  }

  private projectDb(projectId: string): DatabaseSync {
    const existing = this.projectDbs.get(projectId);
    if (existing) return existing;
    const project = this.getProjectSync(projectId);
    if (!project) throw new Error(`Research project not found: ${projectId}`);
    mkdirSync(project.projectRoot, { recursive: true });
    mkdirSync(join(project.projectRoot, "context"), { recursive: true });
    mkdirSync(join(project.projectRoot, "reports"), { recursive: true });
    mkdirSync(join(project.projectRoot, "knowledge"), { recursive: true });
    mkdirSync(join(project.projectRoot, "exports"), { recursive: true });
    mkdirSync(join(project.projectRoot, "logs"), { recursive: true });
    const db = new DatabaseSync(join(project.projectRoot, "project.sqlite"));
    migrateMemoryDb(db, [
      "research_inputs",
      "research_specifications",
      "research_plans",
      "project_record_links",
      "project_chunk_links",
      "project_entity_links",
      "project_relation_links",
      "project_constraint_links",
      "project_context_snapshots",
      "hybrid_contexts",
      "validation_results",
      "continuation_decisions",
      "final_outputs"
    ]);
    this.projectDbs.set(projectId, db);
    return db;
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

  private byProjectOrGlobalVisible<T extends ScopedProjectItem>(table: string, projectId: string): T[] {
    const rows = this.db.prepare(`select id, project_id, created_at, data from ${table} order by created_at asc`).all() as JsonRecord[];
    return rows.map((row) => this.parse<T>(row)).filter((item) =>
      item.projectId === projectId ||
      item.workspaceProjectId === projectId ||
      normalizeMemoryScope(item.memoryScope) === "global"
    );
  }

  private parse<T>(row: JsonRecord): T {
    const parsed = JSON.parse(row.data) as Record<string, unknown>;
    if ("currentStep" in parsed) {
      parsed.currentStep = normalizeResearchLoopStep(parsed.currentStep);
    }
    if ("step" in parsed) {
      parsed.step = normalizeResearchLoopStep(parsed.step);
    }
    if ("memoryScope" in parsed) {
      parsed.memoryScope = normalizeMemoryScope(parsed.memoryScope);
    }
    if (!("validationStatus" in parsed) && ("kind" in parsed || "sourceId" in parsed || "subjectId" in parsed)) {
      parsed.validationStatus = defaultValidationStatus(parsed);
    }
    return parsed as T;
  }

  private getProjectSync(projectId: string): ResearchProject | undefined {
    const row = this.db.prepare("select id, data from projects where id = ?").get(projectId) as JsonRecord | undefined;
    return row ? sanitizeProject(this.parse<ResearchProject>(row)) : undefined;
  }
}

function migrateMemoryDb(db: DatabaseSync, tables: string[]): void {
  db.exec("pragma journal_mode = WAL");
  for (const table of tables) {
    db.exec(`create table if not exists ${table} (id text primary key, project_id text not null, created_at text not null, data text not null)`);
    db.exec(`create index if not exists idx_${table}_project on ${table}(project_id, created_at)`);
  }
}

function defaultValidationStatus(parsed: Record<string, unknown>): import("../../core/types.js").ValidationStatus {
  if (parsed.memoryScope === "ephemeral") return "raw";
  const metadata = typeof parsed.metadata === "object" && parsed.metadata ? parsed.metadata as Record<string, unknown> : {};
  if (metadata.traceabilityKind === "external_source") return "normalized";
  if (metadata.traceabilityKind === "error") return "rejected";
  return "raw";
}

function normalizeRecord(record: NormalizedResearchRecord): NormalizedResearchRecord {
  return {
    ...record,
    memoryScope: normalizeMemoryScope(record.memoryScope),
    sourceProjectId: record.sourceProjectId ?? record.originProjectId ?? record.projectId,
    validationStatus: record.validationStatus ?? defaultValidationStatus(record as unknown as Record<string, unknown>)
  };
}

function groupByProject<T extends { projectId: string }>(items: T[]): Array<[string, T[]]> {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const list = groups.get(item.projectId) ?? [];
    list.push(item);
    groups.set(item.projectId, list);
  }
  return [...groups.entries()];
}

function sanitizeProject(project: ResearchProject): ResearchProject {
  return project;
}
