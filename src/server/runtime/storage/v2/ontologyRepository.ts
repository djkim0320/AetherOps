import { DatabaseSync } from "node:sqlite";
import type {
  StorageOntologyConstraintPayload,
  StorageOntologyEntityPayload,
  StorageOntologyRelationPayload,
  StorageOntologyRun,
  StorageOntologyRunStatus,
  StorageSearchOptions,
  StorageSearchResult
} from "./types.js";
import {
  json,
  normalizeLimit,
  nowIso,
  ontologyProjectWhere,
  parseJson,
  rankScore,
  replaceOntologyFts,
  requiredOntologyRun,
  rowToOntologyRun,
  runAtomically,
  toFtsQuery,
  type Row
} from "./repositorySupport.js";

type OntologyPayload = StorageOntologyEntityPayload | StorageOntologyRelationPayload | StorageOntologyConstraintPayload;

export class OntologyRepository {
  constructor(private readonly db: DatabaseSync) {}
  upsertEntities(values: StorageOntologyEntityPayload[]): void {
    runAtomically(this.db, () =>
      values.forEach((value) => {
        this.db
          .prepare(
            `insert into ontology_entities_v2 (id, project_id, workspace_project_id, source_project_id,
        memory_scope, validation_status, label, type, confidence, source_record_id, source_evidence_id, created_at, data)
        values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) on conflict(id) do update set
        workspace_project_id=excluded.workspace_project_id, source_project_id=excluded.source_project_id,
        memory_scope=excluded.memory_scope, validation_status=excluded.validation_status, label=excluded.label,
        type=excluded.type, confidence=excluded.confidence, source_record_id=excluded.source_record_id,
        source_evidence_id=excluded.source_evidence_id, data=excluded.data`
          )
          .run(
            value.id,
            value.projectId,
            value.workspaceProjectId ?? null,
            value.sourceProjectId ?? value.originProjectId ?? null,
            value.memoryScope ?? null,
            value.validationStatus ?? null,
            value.label,
            value.type,
            value.confidence,
            value.sourceRecordId ?? null,
            value.sourceEvidenceId ?? null,
            value.createdAt,
            json(value)
          );
        replaceOntologyFts(this.db, value.id, value.projectId, "entity", value.label, `${value.type}\n${value.description ?? ""}`);
      })
    );
  }
  upsertRelations(values: StorageOntologyRelationPayload[]): void {
    runAtomically(this.db, () =>
      values.forEach((value) => {
        this.db
          .prepare(
            `insert into ontology_relations_v2 (id, project_id, workspace_project_id, source_project_id,
        memory_scope, validation_status, subject_id, predicate, object_id, confidence, source_record_id,
        source_evidence_id, created_at, data) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        on conflict(id) do update set workspace_project_id=excluded.workspace_project_id,
        source_project_id=excluded.source_project_id, memory_scope=excluded.memory_scope,
        validation_status=excluded.validation_status, subject_id=excluded.subject_id, predicate=excluded.predicate,
        object_id=excluded.object_id, confidence=excluded.confidence, source_record_id=excluded.source_record_id,
        source_evidence_id=excluded.source_evidence_id, data=excluded.data`
          )
          .run(
            value.id,
            value.projectId,
            value.workspaceProjectId ?? null,
            value.sourceProjectId ?? value.originProjectId ?? null,
            value.memoryScope ?? null,
            value.validationStatus ?? null,
            value.subjectId,
            value.predicate,
            value.objectId,
            value.confidence,
            value.sourceRecordId ?? null,
            value.sourceEvidenceId ?? null,
            value.createdAt,
            json(value)
          );
        replaceOntologyFts(this.db, value.id, value.projectId, "relation", value.predicate, `${value.subjectId}\n${value.objectId}`);
      })
    );
  }
  upsertConstraints(values: StorageOntologyConstraintPayload[]): void {
    runAtomically(this.db, () =>
      values.forEach((value) => {
        this.db
          .prepare(
            `insert into ontology_constraints_v2 (id, project_id, workspace_project_id, source_project_id,
        memory_scope, validation_status, label, rule_type, applies_to_entity_type, confidence, source_record_id, created_at, data)
        values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) on conflict(id) do update set
        workspace_project_id=excluded.workspace_project_id, source_project_id=excluded.source_project_id,
        memory_scope=excluded.memory_scope, validation_status=excluded.validation_status, label=excluded.label,
        rule_type=excluded.rule_type, applies_to_entity_type=excluded.applies_to_entity_type,
        confidence=excluded.confidence, source_record_id=excluded.source_record_id, data=excluded.data`
          )
          .run(
            value.id,
            value.projectId,
            value.workspaceProjectId ?? null,
            value.sourceProjectId ?? value.originProjectId ?? null,
            value.memoryScope ?? null,
            value.validationStatus ?? null,
            value.label,
            value.ruleType,
            value.appliesToEntityType ?? null,
            value.confidence,
            value.sourceRecordId ?? null,
            value.createdAt,
            json(value)
          );
        replaceOntologyFts(this.db, value.id, value.projectId, "constraint", value.label, `${value.ruleType}\n${value.appliesToEntityType ?? ""}`);
      })
    );
  }
  search(query: string, options: StorageSearchOptions = {}): StorageSearchResult<OntologyPayload>[] {
    const scope = ontologyProjectWhere("f", options);
    const rows = this.db
      .prepare(
        `select f.id, f.kind, bm25(ontology_v2_fts) rank from ontology_v2_fts f
      where ontology_v2_fts match ? and ${scope.where} order by rank limit ?`
      )
      .all(toFtsQuery(query), ...scope.params, normalizeLimit(options.limit)) as Row[];
    return rows.map((row) => ({ item: this.payload(String(row.kind), String(row.id)), score: rankScore(row.rank) }));
  }
  startRun(value: StorageOntologyRun): StorageOntologyRun {
    this.db
      .prepare(
        `insert into ontology_runs (id, project_id, job_id, mode, status, entity_count, relation_count,
      constraint_count, error, started_at, completed_at, data) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        value.id,
        value.projectId,
        value.jobId ?? null,
        value.mode,
        value.status,
        value.entityCount,
        value.relationCount,
        value.constraintCount,
        value.error ?? null,
        value.startedAt,
        value.completedAt ?? null,
        value.data === undefined ? null : json(value.data)
      );
    return requiredOntologyRun(this.getRun(value.id), value.id);
  }
  finishRun(
    runId: string,
    patch: {
      status: StorageOntologyRunStatus;
      entityCount?: number;
      relationCount?: number;
      constraintCount?: number;
      error?: string;
      data?: unknown;
      completedAt?: string;
    }
  ): StorageOntologyRun {
    const current = requiredOntologyRun(this.getRun(runId), runId);
    this.db
      .prepare(
        `update ontology_runs set status=?, entity_count=?, relation_count=?, constraint_count=?,
      error=?, completed_at=?, data=? where id=?`
      )
      .run(
        patch.status,
        patch.entityCount ?? current.entityCount,
        patch.relationCount ?? current.relationCount,
        patch.constraintCount ?? current.constraintCount,
        patch.error ?? null,
        patch.completedAt ?? nowIso(),
        patch.data === undefined ? (current.data === undefined ? null : json(current.data)) : json(patch.data),
        runId
      );
    return requiredOntologyRun(this.getRun(runId), runId);
  }
  private getRun(id: string): StorageOntologyRun | undefined {
    const row = this.db.prepare("select * from ontology_runs where id=?").get(id) as Row | undefined;
    return row ? rowToOntologyRun(row) : undefined;
  }
  private payload(kind: string, id: string): OntologyPayload {
    const table = kind === "entity" ? "ontology_entities_v2" : kind === "relation" ? "ontology_relations_v2" : "ontology_constraints_v2";
    const row = this.db.prepare(`select data from ${table} where id=?`).get(id) as Row | undefined;
    if (!row) throw new Error(`Ontology ${kind} not found: ${id}`);
    return parseJson<OntologyPayload>(row.data);
  }
}
