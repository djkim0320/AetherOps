import { createId, nowIso } from "./ids.js";
import { cosineSimilarity, LocalHashEmbeddingProvider, type EmbeddingProvider } from "./embeddingProvider.js";
import type { RagContext, RagEngine, ResearchChunk, ResearchSnapshot } from "./types.js";

export class VectorRagEngine implements RagEngine {
  constructor(
    private readonly embeddingProvider: EmbeddingProvider = new LocalHashEmbeddingProvider(),
    private readonly topK = 8
  ) {}

  async buildContext(snapshot: ResearchSnapshot): Promise<RagContext> {
    const query = [
      snapshot.project.topic,
      snapshot.project.goal,
      ...snapshot.questions.map((item) => item.text),
      ...snapshot.hypotheses.map((item) => item.statement)
    ].join("\n");
    const queryEmbedding = await this.embeddingProvider.embed(query);

    const scored = await Promise.all(
      snapshot.chunks.map(async (chunk) => {
        const embedding = chunk.embedding?.length ? chunk.embedding : await this.embeddingProvider.embed(chunk.text);
        return {
          chunk,
          score: cosineSimilarity(queryEmbedding, embedding)
        };
      })
    );

    const selected = scored
      .sort((a, b) => b.score - a.score)
      .slice(0, this.topK)
      .filter((item) => item.score > 0 || scored.length <= this.topK);

    const evidenceIds = new Set<string>();
    const artifactIds = new Set<string>();
    const citations: string[] = [];
    const retrievalScores: Record<string, number> = {};

    for (const { chunk, score } of selected) {
      retrievalScores[chunk.id] = Number(score.toFixed(4));
      const citation = this.citationForChunk(chunk, snapshot);
      if (citation) {
        citations.push(citation);
      }
      const evidence = snapshot.evidence.find((item) => item.sourceId === chunk.sourceId || `source_${item.id}` === chunk.sourceId);
      if (evidence) {
        evidenceIds.add(evidence.id);
      }
      const artifact = snapshot.artifacts.find((item) => `source_${item.id}` === chunk.sourceId);
      if (artifact) {
        artifactIds.add(artifact.id);
      }
    }

    const contextText = selected
      .map(({ chunk, score }, index) => `[${index + 1}] score=${score.toFixed(3)} ${this.citationForChunk(chunk, snapshot)}\n${chunk.text}`)
      .join("\n\n");

    return {
      id: createId("rag"),
      projectId: snapshot.project.id,
      query,
      evidenceIds: [...evidenceIds],
      artifactIds: [...artifactIds],
      summary: selected.length
        ? `Vector RAG retrieved ${selected.length} chunks with ${citations.length} traceable citations.`
        : "검색 가능한 chunk가 부족합니다. 다음 루프에서 자료 수집 또는 산출물 생성이 필요합니다.",
      chunkIds: selected.map((item) => item.chunk.id),
      citations: [...new Set(citations)],
      retrievalScores,
      contextText,
      createdAt: nowIso()
    };
  }

  private citationForChunk(chunk: ResearchChunk, snapshot: ResearchSnapshot): string {
    const source = snapshot.sources.find((item) => item.id === chunk.sourceId);
    if (!source) {
      return chunk.sourceId;
    }
    const uri = source.url || source.doi || source.rawPath || source.title;
    return source.doi ? `${source.title} (${source.doi})` : `${source.title}${uri ? ` - ${uri}` : ""}`;
  }
}
