import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync, type StatementSync } from "node:sqlite";

export interface LazyJsonUpserter {
  upsert(table: string, id: string, projectId: string, createdAt: string, data: unknown): void;
  close(): void;
}

export function migrateResearchDb(path: string): void {
  migrateJsonDb(path, [
    "sources",
    "artifacts",
    "tool_runs",
    "agent_plans",
    "research_inputs",
    "research_specifications",
    "research_plans",
    "project_record_links",
    "project_chunk_links",
    "project_entity_links",
    "project_relation_links",
    "project_context_snapshots",
    "normalized_records",
    "hybrid_contexts",
    "validation_results",
    "continuation_decisions",
    "final_outputs",
    "run_audit_outputs",
    "benchmark_plans",
    "runtime_blockers",
    "step_errors",
    "reports"
  ]);
}

export function migrateVectorDb(path: string): void {
  migrateJsonDb(path, ["chunks"]);
}

export function migrateOntologyDb(path: string): void {
  migrateJsonDb(path, ["ontology_entities", "ontology_relations", "ontology_constraints"]);
}

export function migrateJsonDb(path: string, tables: string[]): void {
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  try {
    db.exec("pragma journal_mode = WAL");
    for (const table of tables) {
      db.exec(`create table if not exists ${table} (id text primary key, project_id text not null, created_at text not null, data text not null)`);
      db.exec(`create index if not exists idx_${table}_project on ${table}(project_id, created_at)`);
    }
  } finally {
    db.close();
  }
}

export function upsertJson(path: string, table: string, id: string, projectId: string, createdAt: string, data: unknown): void {
  withJsonUpserter(path, (sqlite) => sqlite.upsert(table, id, projectId, createdAt, data));
}

export function withJsonUpserter<T>(path: string, write: (sqlite: LazyJsonUpserter) => T): T {
  const sqlite = createLazyJsonUpserter(path);
  try {
    return write(sqlite);
  } finally {
    sqlite.close();
  }
}

export function createLazyJsonUpserter(path: string): LazyJsonUpserter {
  let db: DatabaseSync | undefined;
  let upsert: ReturnType<typeof createJsonUpserter> | undefined;
  return {
    upsert(table, id, projectId, createdAt, data) {
      if (!upsert) {
        db = new DatabaseSync(path);
        upsert = createJsonUpserter(db);
      }
      upsert(table, id, projectId, createdAt, data);
    },
    close() {
      db?.close();
      db = undefined;
      upsert = undefined;
    }
  };
}

function createJsonUpserter(db: DatabaseSync) {
  const statements = new Map<string, StatementSync>();
  return (table: string, id: string, projectId: string, createdAt: string, data: unknown) => {
    let statement = statements.get(table);
    if (!statement) {
      statement = db.prepare(`insert into ${table} (id, project_id, created_at, data) values (?, ?, ?, ?) on conflict(id) do update set data = excluded.data`);
      statements.set(table, statement);
    }
    statement.run(id, projectId, createdAt, JSON.stringify(data));
  };
}
