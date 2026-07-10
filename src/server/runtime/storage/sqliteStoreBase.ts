import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { normalizeMemoryScope } from "../../../core/memory/researchMemory.js";
import { normalizeResearchLoopStep, type MainMemorySearchOptions, type OntologyRelation, type ResearchProject } from "../../../core/shared/types.js";
import { defaultValidationStatus, isVisibleScopedItem, sanitizeProject, type ScopedProjectItem } from "./sqliteStoreSupport.js";

export type JsonRecord = { id: string; project_id?: string; created_at?: string; data: string };
export const OPEN_CODE_RUNS_TABLE = `opencode_${"runs"}`;

export abstract class SqliteStoreBase {
  protected readonly db: DatabaseSync;
  protected readonly mainDb: DatabaseSync;
  protected readonly mainVectorDb: DatabaseSync;
  protected readonly mainOntologyDb: DatabaseSync;
  private readonly projectDbs = new Map<string, DatabaseSync>();
  private closed = false;

  constructor(private readonly sqlitePath: string) {
    const parent = dirname(sqlitePath);
    mkdirSync(parent, { recursive: true });
    this.db = new DatabaseSync(sqlitePath);
    const mainRoot = join(parent, "main");
    for (const folder of ["sources", "artifacts", "logs"]) mkdirSync(join(mainRoot, "files", folder), { recursive: true });
    this.mainDb = new DatabaseSync(join(mainRoot, "main.sqlite"));
    this.mainVectorDb = new DatabaseSync(join(mainRoot, "vector.sqlite"));
    this.mainOntologyDb = new DatabaseSync(join(mainRoot, "ontology.sqlite"));
    this.migrate();
  }

  close(): void {
    if (this.closed) return;
    this.db.close();
    this.mainDb.close();
    this.mainVectorDb.close();
    this.mainOntologyDb.close();
    for (const db of this.projectDbs.values()) db.close();
    this.closed = true;
  }

  protected upsertProject(project: ResearchProject): void {
    const sanitized = sanitizeProject(project);
    this.db
      .prepare("insert into projects (id, created_at, data) values (?, ?, ?) on conflict(id) do update set data = excluded.data")
      .run(sanitized.id, sanitized.createdAt, JSON.stringify(sanitized));
  }

  protected upsertMany<T extends Persistable>(table: string, items: T[]): void {
    this.upsertManyInto(this.db, table, items);
  }
  protected upsertManyMain<T extends Persistable>(table: string, items: T[]): void {
    this.upsertManyInto(this.mainDb, table, items);
  }
  protected upsertManyProject<T extends Persistable>(projectId: string, table: string, items: T[]): void {
    this.upsertManyInto(this.projectDb(projectId), table, items);
  }

  protected upsertManyInto<T extends Persistable>(db: DatabaseSync, table: string, items: T[]): void {
    if (!items.length) return;
    const statement = db.prepare(
      `insert into ${table} (id, project_id, created_at, data) values (?, ?, ?, ?) on conflict(id) do update set data = excluded.data`
    );
    db.exec("begin");
    try {
      for (const item of items) {
        const createdAt = item.createdAt ?? item.startedAt;
        if (!createdAt) throw new Error(`Cannot persist ${table}:${item.id} without createdAt or startedAt.`);
        statement.run(item.id, item.projectId, createdAt, JSON.stringify(item));
      }
      db.exec("commit");
    } catch (error) {
      db.exec("rollback");
      throw error;
    }
  }

  protected linkProjectItems(table: string, links: Array<{ projectId: string; itemId: string; createdAt?: string }>): void {
    const grouped = new Map<string, Array<{ id: string; projectId: string; itemId: string; createdAt: string }>>();
    for (const link of links) {
      if (!link.createdAt) throw new Error(`Cannot persist ${table}:${link.projectId}:${link.itemId} without createdAt.`);
      const list = grouped.get(link.projectId) ?? [];
      list.push({ id: `${link.projectId}:${link.itemId}`, projectId: link.projectId, itemId: link.itemId, createdAt: link.createdAt });
      grouped.set(link.projectId, list);
    }
    for (const [projectId, items] of grouped) this.upsertManyProject(projectId, table, items);
  }

  protected all(table: string): JsonRecord[] {
    return this.db.prepare(`select id, data from ${table}`).all() as JsonRecord[];
  }
  protected allFrom(db: DatabaseSync, table: string): JsonRecord[] {
    return db.prepare(`select id, project_id, created_at, data from ${table} order by created_at asc`).all() as JsonRecord[];
  }
  protected allParsedFrom<T>(db: DatabaseSync, table: string): T[] {
    return this.allFrom(db, table).map((row) => this.parse<T>(row));
  }
  protected byProject<T>(table: string, projectId: string): T[] {
    return (
      this.db.prepare(`select id, project_id, created_at, data from ${table} where project_id = ? order by created_at asc`).all(projectId) as JsonRecord[]
    ).map((row) => this.parse<T>(row));
  }

  protected byProjectOrGlobalVisible<T extends ScopedProjectItem>(table: string, projectId: string): T[] {
    return (this.db.prepare(`select id, project_id, created_at, data from ${table} order by created_at asc`).all() as JsonRecord[])
      .map((row) => this.parse<T>(row))
      .filter((item) => item.projectId === projectId || item.workspaceProjectId === projectId || normalizeMemoryScope(item.memoryScope) === "global");
  }

  protected visibleRelationsForEntities(entityIds: Set<string>, options: MainMemorySearchOptions, limit: number): OntologyRelation[] {
    if (limit <= 0) return [];
    const relations: OntologyRelation[] = [];
    for (const row of this.allFrom(this.mainOntologyDb, "global_relations")) {
      const relation = this.parse<OntologyRelation>(row);
      if (!isVisibleScopedItem(relation, options) || (!entityIds.has(relation.subjectId) && !entityIds.has(relation.objectId))) continue;
      relations.push(relation);
      if (relations.length >= limit) break;
    }
    return relations;
  }

  protected parse<T>(row: JsonRecord): T {
    const parsed = JSON.parse(row.data) as Record<string, unknown>;
    if ("currentStep" in parsed) parsed.currentStep = normalizeResearchLoopStep(parsed.currentStep);
    if ("step" in parsed) parsed.step = normalizeResearchLoopStep(parsed.step);
    if ("memoryScope" in parsed) parsed.memoryScope = normalizeMemoryScope(parsed.memoryScope);
    if (!("validationStatus" in parsed) && ("kind" in parsed || "sourceId" in parsed || "subjectId" in parsed))
      parsed.validationStatus = defaultValidationStatus(parsed);
    return parsed as T;
  }

  protected getProjectSync(projectId: string): ResearchProject | undefined {
    const row = this.db.prepare("select id, data from projects where id = ?").get(projectId) as JsonRecord | undefined;
    return row ? sanitizeProject(this.parse<ResearchProject>(row)) : undefined;
  }

  private projectDb(projectId: string): DatabaseSync {
    const existing = this.projectDbs.get(projectId);
    if (existing) return existing;
    const project = this.getProjectSync(projectId);
    if (!project) throw new Error(`Research project not found: ${projectId}`);
    for (const folder of ["", "context", "reports", "knowledge", "exports", "logs"]) mkdirSync(join(project.projectRoot, folder), { recursive: true });
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
      "final_outputs",
      "run_audit_outputs",
      "benchmark_plans"
    ]);
    this.projectDbs.set(projectId, db);
    return db;
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
      "run_audit_outputs",
      "benchmark_plans",
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
      this.db.exec(
        table === "projects"
          ? `create table if not exists ${table} (id text primary key, created_at text not null, data text not null)`
          : `create table if not exists ${table} (id text primary key, project_id text not null, created_at text not null, data text not null)`
      );
      if (table !== "projects") this.db.exec(`create index if not exists idx_${table}_project on ${table}(project_id, created_at)`);
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
}

interface Persistable {
  id: string;
  projectId: string;
  createdAt?: string;
  startedAt?: string;
}

function migrateMemoryDb(db: DatabaseSync, tables: string[]): void {
  db.exec("pragma journal_mode = WAL");
  for (const table of tables) {
    db.exec(`create table if not exists ${table} (id text primary key, project_id text not null, created_at text not null, data text not null)`);
    db.exec(`create index if not exists idx_${table}_project on ${table}(project_id, created_at)`);
  }
}
