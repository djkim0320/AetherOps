import { chunkResearchSource } from "./chunking.js";
import type { EmbeddingProvider } from "./embeddingProvider.js";
import { createStableId, nowIso } from "./ids.js";
import type {
  AppSettings,
  NormalizedResearchRecord,
  ResearchChunk,
  ResearchSnapshot,
  ResearchSource
} from "./types.js";

export class VectorIndexEngine {
  constructor(private readonly embeddingProvider: EmbeddingProvider) {}

  async buildIndex(input: {
    snapshot: ResearchSnapshot;
    records: NormalizedResearchRecord[];
    settings?: AppSettings;
  }): Promise<ResearchChunk[]> {
    const existing = new Set(input.snapshot.chunks.map((chunk) => chunk.id));
    const chunks: ResearchChunk[] = [];
    for (const record of input.records) {
      const source = sourceFromRecord(record);
      for (const chunk of chunkResearchSource(source, record.content)) {
        const id = createStableId("chunk", `${record.id}:${chunk.chunkIndex}:${chunk.text}`);
        if (existing.has(id)) {
          continue;
        }
        const embedding = await this.embeddingProvider.embed(chunk.text);
        chunks.push({
          ...chunk,
          id,
          recordId: record.id,
          evidenceId: record.evidenceId,
          citation: record.citation ?? record.sourceUri,
          embedding,
          embeddingProvider: providerName(input.settings),
          embeddingModel: input.settings?.embedding.model ?? "configured-embedding-model",
          embeddingDimensions: embedding.length,
          createdAt: nowIso()
        });
      }
    }
    return chunks;
  }
}

function sourceFromRecord(record: NormalizedResearchRecord): ResearchSource {
  return {
    id: record.sourceId ?? `source_${record.id}`,
    projectId: record.projectId,
    kind: record.kind === "citation" ? "file" : record.kind === "artifact" ? "artifact" : "log",
    title: record.title,
    url: record.sourceUri,
    retrievedAt: record.createdAt,
    metadata: { recordId: record.id, citation: record.citation, confidence: record.confidence },
    createdAt: record.createdAt
  };
}

function providerName(settings?: AppSettings): string {
  if (!settings) {
    return "configured";
  }
  if (settings.embedding.provider === "local") {
    return "blocked_local_embedding";
  }
  return settings.embedding.provider;
}
