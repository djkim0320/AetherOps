import { DatabaseSync } from "node:sqlite";
import type { Row } from "./repositorySupport.js";
import type { StorageEmbedding, StorageEmbeddingInput } from "./types.js";
import { json, nowIso, rowToEmbedding } from "./repositorySupport.js";
import { float32EmbeddingToBlob, normalizeFloat32Embedding } from "./embeddings.js";

export class EmbeddingRepository {
  constructor(private readonly db: DatabaseSync) {}

  upsert(input: StorageEmbeddingInput): void {
    const vector = normalizeFloat32Embedding(input.vector);
    const now = nowIso();
    const createdAt = input.createdAt ?? now;
    const updatedAt = input.updatedAt ?? now;
    this.db
      .prepare(
        `
        insert into embeddings_v2 (
          id, project_id, owner_table, owner_id, scope, dimensions, provider, model, embedding, created_at, updated_at, data
        )
        values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        on conflict(id) do update set
          project_id = excluded.project_id,
          owner_table = excluded.owner_table,
          owner_id = excluded.owner_id,
          scope = excluded.scope,
          dimensions = excluded.dimensions,
          provider = excluded.provider,
          model = excluded.model,
          embedding = excluded.embedding,
          updated_at = excluded.updated_at,
          data = excluded.data
      `
      )
      .run(
        input.id,
        input.projectId,
        input.ownerTable,
        input.ownerId,
        input.scope ?? null,
        vector.length,
        input.provider ?? null,
        input.model ?? null,
        float32EmbeddingToBlob(vector),
        createdAt,
        updatedAt,
        input.data === undefined ? null : json(input.data)
      );
  }

  getByOwner(ownerTable: string, ownerId: string): StorageEmbedding | undefined {
    const row = this.db.prepare("select * from embeddings_v2 where owner_table = ? and owner_id = ?").get(ownerTable, ownerId) as Row | undefined;
    return row ? rowToEmbedding(row) : undefined;
  }

  deleteByOwner(ownerTable: string, ownerId: string): void {
    this.db.prepare("delete from embeddings_v2 where owner_table = ? and owner_id = ?").run(ownerTable, ownerId);
  }
}
