import { DatabaseSync } from "node:sqlite";
import type { Row } from "./repositorySupport.js";
import type { StorageEmbeddingInput, StorageMemoryPayload, StorageSearchOptions, StorageSearchResult } from "./types.js";
import { json, normalizeLimit, parseJson, projectVisibilityWhere, rankScore, replaceFts, runAtomically, toFtsQuery } from "./repositorySupport.js";
import { EmbeddingRepository } from "./embeddingRepository.js";

export class MemoryRepository {
  constructor(
    private readonly db: DatabaseSync,
    private readonly embeddings: EmbeddingRepository
  ) {}

  upsertItem(item: Extract<StorageMemoryPayload, { validationResultId: string }>): void {
    this.upsertProjected({
      id: item.id,
      projectId: item.projectId,
      sourceProjectId: item.sourceProjectId,
      kind: "global_item",
      memoryScope: item.memoryScope ?? "global",
      validationStatus: item.validationStatus,
      title: item.title,
      content: item.content,
      createdAt: item.createdAt,
      data: item
    });
  }

  upsertChunk(chunk: Extract<StorageMemoryPayload, { chunkIndex: number }>): void {
    this.upsertProjected({
      id: chunk.id,
      projectId: chunk.projectId,
      workspaceProjectId: chunk.workspaceProjectId,
      sourceProjectId: chunk.sourceProjectId ?? chunk.originProjectId,
      kind: "chunk",
      memoryScope: chunk.memoryScope ?? "project_only",
      validationStatus: chunk.validationStatus ?? "indexed",
      title: `${chunk.sourceId}:${chunk.chunkIndex}`,
      content: chunk.text,
      sourceId: chunk.sourceId,
      recordId: chunk.recordId,
      evidenceId: chunk.evidenceId,
      createdAt: chunk.createdAt,
      data: chunk,
      embedding: chunk.embedding
        ? {
            id: `emb_${chunk.id}`,
            projectId: chunk.projectId,
            ownerTable: "memory_items_v2",
            ownerId: chunk.id,
            vector: chunk.embedding,
            provider: chunk.embeddingProvider,
            model: chunk.embeddingModel,
            scope: chunk.memoryScope ?? "project_only",
            createdAt: chunk.createdAt,
            updatedAt: chunk.createdAt
          }
        : undefined
    });
  }

  get(memoryId: string): StorageMemoryPayload | undefined {
    const row = this.db.prepare("select data from memory_items_v2 where id = ?").get(memoryId) as Row | undefined;
    return row ? parseJson<StorageMemoryPayload>(row.data) : undefined;
  }

  search(query: string, options: StorageSearchOptions = {}): StorageSearchResult<StorageMemoryPayload>[] {
    const ftsQuery = toFtsQuery(query);
    if (!ftsQuery) {
      return this.listByProjectOrAll(options).map((item) => ({ item, score: 0 }));
    }
    const { where, params } = projectVisibilityWhere("m", options);
    const rows = this.db
      .prepare(
        `
        select m.data, bm25(memory_items_v2_fts) as rank
        from memory_items_v2_fts
        join memory_items_v2 m on m.id = memory_items_v2_fts.id
        where memory_items_v2_fts match ? ${where}
        order by rank
        limit ?
      `
      )
      .all(ftsQuery, ...params, normalizeLimit(options.limit)) as Row[];
    return rows.map((row) => ({ item: parseJson<StorageMemoryPayload>(row.data), score: rankScore(row.rank) }));
  }

  private upsertProjected(input: {
    id: string;
    projectId: string;
    workspaceProjectId?: string;
    sourceProjectId?: string;
    kind: string;
    memoryScope: string;
    validationStatus: string;
    title: string;
    content: string;
    sourceId?: string;
    recordId?: string;
    evidenceId?: string;
    createdAt: string;
    data: StorageMemoryPayload;
    embedding?: StorageEmbeddingInput;
  }): void {
    runAtomically(this.db, () => {
      this.db
        .prepare(
          `
          insert into memory_items_v2 (
            id, project_id, workspace_project_id, source_project_id, kind, memory_scope, validation_status,
            title, content, source_id, record_id, evidence_id, created_at, data
          )
          values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
            record_id = excluded.record_id,
            evidence_id = excluded.evidence_id,
            created_at = excluded.created_at,
            data = excluded.data
        `
        )
        .run(
          input.id,
          input.projectId,
          input.workspaceProjectId ?? null,
          input.sourceProjectId ?? null,
          input.kind,
          input.memoryScope,
          input.validationStatus,
          input.title,
          input.content,
          input.sourceId ?? null,
          input.recordId ?? null,
          input.evidenceId ?? null,
          input.createdAt,
          json(input.data)
        );
      replaceFts(this.db, "memory_items_v2_fts", input.id, input.projectId, input.title, input.content);
      if (input.embedding) {
        this.embeddings.upsert(input.embedding);
      }
    });
  }

  private listByProjectOrAll(options: StorageSearchOptions): StorageMemoryPayload[] {
    if (options.projectId) {
      const includeGlobal = options.includeGlobal ? 1 : 0;
      const rows = this.db
        .prepare(
          `
          select data from memory_items_v2
          where project_id = ? or workspace_project_id = ? or (? = 1 and memory_scope = 'global')
          order by created_at desc
          limit ?
        `
        )
        .all(options.projectId, options.projectId, includeGlobal, normalizeLimit(options.limit)) as Row[];
      return rows.map((row) => parseJson<StorageMemoryPayload>(row.data));
    }
    const rows = this.db.prepare("select data from memory_items_v2 order by created_at desc limit ?").all(normalizeLimit(options.limit)) as Row[];
    return rows.map((row) => parseJson<StorageMemoryPayload>(row.data));
  }
}
