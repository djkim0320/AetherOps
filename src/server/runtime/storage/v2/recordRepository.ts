import { DatabaseSync } from "node:sqlite";
import type { Row } from "./repositorySupport.js";
import type { StorageEmbeddingInput, StorageRecordPayload, StorageSearchOptions, StorageSearchResult } from "./types.js";
import { json, normalizeLimit, parseJson, projectVisibilityWhere, rankScore, replaceFts, runAtomically, toFtsQuery } from "./repositorySupport.js";
import { EmbeddingRepository } from "./embeddingRepository.js";

export class RecordRepository {
  constructor(
    private readonly db: DatabaseSync,
    private readonly embeddings: EmbeddingRepository
  ) {}

  upsert(record: StorageRecordPayload, embedding?: Omit<StorageEmbeddingInput, "id" | "projectId" | "ownerTable" | "ownerId">): void {
    runAtomically(this.db, () => {
      this.db
        .prepare(
          `
          insert into records_v2 (
            id, project_id, workspace_project_id, source_project_id, kind, memory_scope, validation_status,
            title, content, source_id, artifact_id, evidence_id, citation, created_at, data
          )
          values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          on conflict(id) do update set
            project_id = excluded.project_id,
            workspace_project_id = excluded.workspace_project_id,
            source_project_id = excluded.source_project_id,
            kind = excluded.kind,
            memory_scope = excluded.memory_scope,
            validation_status = excluded.validation_status,
            title = excluded.title,
            content = excluded.content,
            source_id = excluded.source_id,
            artifact_id = excluded.artifact_id,
            evidence_id = excluded.evidence_id,
            citation = excluded.citation,
            created_at = excluded.created_at,
            data = excluded.data
        `
        )
        .run(
          record.id,
          record.projectId,
          record.workspaceProjectId ?? null,
          record.sourceProjectId ?? record.originProjectId ?? null,
          record.kind,
          record.memoryScope,
          record.validationStatus,
          record.title,
          record.content,
          record.sourceId ?? null,
          record.artifactId ?? null,
          record.evidenceId ?? null,
          record.citation ?? null,
          record.createdAt,
          json(record)
        );
      replaceFts(this.db, "records_v2_fts", record.id, record.projectId, record.title, record.content);
      if (embedding?.vector) {
        this.embeddings.upsert({
          ...embedding,
          id: `emb_${record.id}`,
          projectId: record.projectId,
          ownerTable: "records_v2",
          ownerId: record.id,
          scope: embedding.scope ?? record.memoryScope
        });
      }
    });
  }

  get(recordId: string): StorageRecordPayload | undefined {
    const row = this.db.prepare("select data from records_v2 where id = ?").get(recordId) as Row | undefined;
    return row ? parseJson<StorageRecordPayload>(row.data) : undefined;
  }

  listByProject(projectId: string, options: Pick<StorageSearchOptions, "includeGlobal" | "limit"> = {}): StorageRecordPayload[] {
    const includeGlobal = options.includeGlobal ? 1 : 0;
    const rows = this.db
      .prepare(
        `
        select data from records_v2
        where project_id = ? or workspace_project_id = ? or (? = 1 and memory_scope = 'global')
        order by created_at asc
        limit ?
      `
      )
      .all(projectId, projectId, includeGlobal, normalizeLimit(options.limit)) as Row[];
    return rows.map((row) => parseJson<StorageRecordPayload>(row.data));
  }

  search(query: string, options: StorageSearchOptions = {}): StorageSearchResult<StorageRecordPayload>[] {
    const ftsQuery = toFtsQuery(query);
    if (!ftsQuery) {
      return this.listByProjectOrAll(options).map((item) => ({ item, score: 0 }));
    }
    const { where, params } = projectVisibilityWhere("r", options);
    const rows = this.db
      .prepare(
        `
        select r.data, bm25(records_v2_fts) as rank
        from records_v2_fts
        join records_v2 r on r.id = records_v2_fts.id
        where records_v2_fts match ? ${where}
        order by rank
        limit ?
      `
      )
      .all(ftsQuery, ...params, normalizeLimit(options.limit)) as Row[];
    return rows.map((row) => ({ item: parseJson<StorageRecordPayload>(row.data), score: rankScore(row.rank) }));
  }

  private listByProjectOrAll(options: StorageSearchOptions): StorageRecordPayload[] {
    if (options.projectId) {
      return this.listByProject(options.projectId, options);
    }
    const rows = this.db.prepare("select data from records_v2 order by created_at desc limit ?").all(normalizeLimit(options.limit)) as Row[];
    return rows.map((row) => parseJson<StorageRecordPayload>(row.data));
  }
}
