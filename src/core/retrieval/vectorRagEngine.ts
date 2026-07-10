import { createId, nowIso } from "../shared/ids.js";
import { cosineSimilarity, type EmbeddingProvider } from "../providers/embeddingProvider.js";
import type { RagContext, RagEngine, ResearchChunk, ResearchSnapshot } from "../shared/types.js";

export class VectorRagEngine implements RagEngine {
  constructor(
    private readonly embeddingProvider: EmbeddingProvider,
    private readonly topK = 8
  ) {}

  async buildContext(snapshot: ResearchSnapshot): Promise<RagContext> {
    const queryParts = [snapshot.project.topic, snapshot.project.goal];
    for (const question of snapshot.questions) queryParts.push(question.text);
    for (const hypothesis of snapshot.hypotheses) queryParts.push(hypothesis.statement);
    const query = queryParts.join("\n");
    const queryEmbedding = await this.embeddingProvider.embed(query);

    const scoringTasks: Array<Promise<{ chunk: ResearchChunk; score: number }>> = [];
    for (const chunk of snapshot.chunks) {
      scoringTasks.push(
        (async () => {
          const embedding = chunk.embedding?.length ? chunk.embedding : await this.embeddingProvider.embed(chunk.text);
          return {
            chunk,
            score: cosineSimilarity(queryEmbedding, embedding)
          };
        })()
      );
    }
    const scored = await Promise.all(scoringTasks);

    const includeNonPositiveScores = scored.length <= this.topK;
    scored.sort((a, b) => b.score - a.score);
    const selected: Array<{ chunk: ResearchChunk; score: number }> = [];
    const selectedLimit = Math.min(scored.length, this.topK);
    for (let index = 0; index < selectedLimit; index += 1) {
      const item = scored[index];
      if (item && (item.score > 0 || includeNonPositiveScores)) selected.push(item);
    }

    const evidenceIds = new Set<string>();
    const artifactIds = new Set<string>();
    const citations: string[] = [];
    const retrievalScores: Record<string, number> = {};
    const sourceById = firstById(snapshot.sources);
    const evidenceBySourceId = firstBySourceId(snapshot.evidence);
    const artifactBySourceId = firstBySourceId(snapshot.artifacts);
    const citationBySourceId = new Map<string, string>();
    const contextParts: string[] = [];
    const chunkIds: string[] = [];

    for (let index = 0; index < selected.length; index += 1) {
      const { chunk, score } = selected[index] as { chunk: ResearchChunk; score: number };
      retrievalScores[chunk.id] = Number(score.toFixed(4));
      let citation = citationBySourceId.get(chunk.sourceId);
      if (citation === undefined) {
        citation = this.citationForChunk(chunk, sourceById);
        citationBySourceId.set(chunk.sourceId, citation);
      }
      chunkIds.push(chunk.id);
      contextParts.push(`[${index + 1}] score=${score.toFixed(3)} ${citation}\n${chunk.text}`);
      if (citation) {
        citations.push(citation);
      }
      const evidence = evidenceBySourceId.get(chunk.sourceId);
      if (evidence) {
        evidenceIds.add(evidence.id);
      }
      const artifact = artifactBySourceId.get(chunk.sourceId);
      if (artifact) {
        artifactIds.add(artifact.id);
      }
    }

    const contextText = contextParts.join("\n\n");

    return {
      id: createId("rag"),
      projectId: snapshot.project.id,
      query,
      evidenceIds: [...evidenceIds],
      artifactIds: [...artifactIds],
      summary: selected.length
        ? `Vector RAG retrieved ${selected.length} chunks with ${citations.length} traceable citations.`
        : "검색 가능한 chunk가 부족합니다. 다음 루프에서 자료 수집 또는 산출물 생성이 필요합니다.",
      chunkIds,
      citations: uniqueStrings(citations),
      retrievalScores,
      contextText,
      createdAt: nowIso()
    };
  }

  private citationForChunk(chunk: ResearchChunk, sourceById: Map<string, ResearchSnapshot["sources"][number]>): string {
    const source = sourceById.get(chunk.sourceId);
    if (!source) {
      return chunk.sourceId;
    }
    const uri = source.url || source.doi || source.rawPath || source.title;
    return source.doi ? `${source.title} (${source.doi})` : `${source.title}${uri ? ` - ${uri}` : ""}`;
  }
}

function firstById<T extends { id: string }>(items: T[]): Map<string, T> {
  const byId = new Map<string, T>();
  for (const item of items) {
    if (!byId.has(item.id)) byId.set(item.id, item);
  }
  return byId;
}

function firstBySourceId<T extends { id: string; sourceId?: string }>(items: T[]): Map<string, T> {
  const bySourceId = new Map<string, T>();
  for (const item of items) {
    if (item.sourceId && !bySourceId.has(item.sourceId)) bySourceId.set(item.sourceId, item);
    const generatedSourceId = `source_${item.id}`;
    if (!bySourceId.has(generatedSourceId)) bySourceId.set(generatedSourceId, item);
  }
  return bySourceId;
}

function uniqueStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const value of values) {
    if (seen.has(value)) continue;
    seen.add(value);
    unique.push(value);
  }
  return unique;
}
