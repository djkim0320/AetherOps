import { chunkResearchSource } from "./chunking.js";
import type { EmbeddingProvider } from "./embeddingProvider.js";
import { createStableId, nowIso } from "./ids.js";
import type {
  AppSettings,
  NormalizedResearchRecord,
  NormalizedRecordKind,
  ResearchChunk,
  ResearchSnapshot,
  ResearchSource,
  ResearchSourceKind,
  TraceabilityKind
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
    for (const record of input.records.filter((item) => item.kind !== "error" && item.metadata.traceabilityKind !== "error")) {
      const source = sourceFromRecord(record);
      const traceabilityKind = getTraceabilityKind(record);
      const canSupportHypothesis = record.metadata.canSupportHypothesis === true;
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
          recordKind: record.kind,
          traceabilityKind,
          canSupportHypothesis,
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
    kind: sourceKindFromRecord(record),
    title: record.title,
    url: record.sourceUri,
    retrievedAt: record.createdAt,
    metadata: {
      recordId: record.id,
      citation: record.citation,
      confidence: record.confidence,
      recordKind: record.kind,
      traceabilityKind: getTraceabilityKind(record),
      canSupportHypothesis: record.metadata.canSupportHypothesis === true
    },
    createdAt: record.createdAt
  };
}

function sourceKindFromRecord(record: NormalizedResearchRecord): ResearchSourceKind {
  const sourceKind = typeof record.metadata.sourceKind === "string" ? record.metadata.sourceKind : undefined;
  if (sourceKind === "web" || sourceKind === "paper" || sourceKind === "file" || sourceKind === "artifact" || sourceKind === "log" || sourceKind === "conversation") {
    return sourceKind;
  }
  const traceabilityKind = getTraceabilityKind(record);
  const mapping: Record<NormalizedRecordKind, ResearchSourceKind> = {
    source: traceabilityKind === "external_source" && /^https?:\/\//i.test(record.sourceUri ?? "") ? "web" : "file",
    artifact: "artifact",
    claim: traceabilityKind === "project_provenance" ? "conversation" : "log",
    evidence: traceabilityKind === "external_source" && /^https?:\/\//i.test(record.sourceUri ?? "") ? "web" : "file",
    observation: "log",
    citation: /^https?:\/\//i.test(record.sourceUri ?? record.citation ?? "") ? "web" : "file",
    error: "log"
  };
  return mapping[record.kind];
}

function getTraceabilityKind(record: NormalizedResearchRecord): TraceabilityKind {
  const value = record.metadata.traceabilityKind;
  if (value === "internal_artifact" || value === "external_source" || value === "tool_observation" || value === "project_provenance" || value === "error") {
    return value;
  }
  return record.kind === "artifact" ? "internal_artifact" : record.kind === "error" ? "error" : "project_provenance";
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
