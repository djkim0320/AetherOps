import { chunkResearchSource } from "./chunking.js";
import type { EmbeddingProvider } from "../providers/embeddingProvider.js";
import { createStableId, nowIso } from "../shared/ids.js";
import { normalizeMemoryScope, tagMemoryScope } from "../memory/researchMemory.js";
import type {
  AppSettings,
  NormalizedResearchRecord,
  NormalizedRecordKind,
  ResearchChunk,
  ResearchSnapshot,
  ResearchSource,
  ResearchSourceKind,
  TraceabilityKind
} from "../shared/types.js";

export class VectorIndexEngine {
  constructor(private readonly embeddingProvider: EmbeddingProvider) {}

  async buildIndex(input: { snapshot: ResearchSnapshot; records: NormalizedResearchRecord[]; settings?: AppSettings }): Promise<ResearchChunk[]> {
    const existing = new Set<string>();
    for (const chunk of input.snapshot.chunks) existing.add(chunk.id);
    const chunks: ResearchChunk[] = [];
    const embeddingProviderName = providerName(input.settings);
    const embeddingModel = input.settings?.embedding.model ?? "configured-embedding-model";
    for (const record of input.records) {
      if (record.kind === "error" || record.metadata.traceabilityKind === "error" || normalizeMemoryScope(record.memoryScope) === "ephemeral") {
        continue;
      }
      const traceabilityKind = getTraceabilityKind(record);
      const source = sourceFromRecord(record, traceabilityKind);
      const canSupportHypothesis = record.metadata.canSupportHypothesis === true;
      const memoryScope = normalizeMemoryScope(record.memoryScope);
      for (const chunk of chunkResearchSource(source, record.content)) {
        const id = createStableId("chunk", `${memoryScope}:${record.originProjectId ?? record.projectId}:${record.id}:${chunk.chunkIndex}:${chunk.text}`);
        if (existing.has(id)) {
          continue;
        }
        const embedding = await this.embeddingProvider.embed(chunk.text);
        chunks.push(
          tagMemoryScope(
            {
              ...chunk,
              id,
              recordId: record.id,
              evidenceId: record.evidenceId,
              citation: record.citation ?? record.sourceUri,
              recordKind: record.kind,
              traceabilityKind,
              canSupportHypothesis,
              sourceProjectId: record.sourceProjectId ?? record.originProjectId ?? record.projectId,
              validationStatus: record.validationStatus === "normalized" ? "indexed" : record.validationStatus,
              sourceQualityTier: typeof record.metadata.sourceQualityTier === "string" ? record.metadata.sourceQualityTier : undefined,
              sourceQualityLabel: typeof record.metadata.sourceQualityLabel === "string" ? record.metadata.sourceQualityLabel : undefined,
              sourceCanSupportHypothesis:
                typeof record.metadata.sourceCanSupportHypothesis === "boolean" ? record.metadata.sourceCanSupportHypothesis : undefined,
              embedding,
              embeddingProvider: embeddingProviderName,
              embeddingModel,
              embeddingDimensions: embedding.length,
              createdAt: nowIso()
            },
            memoryScope,
            record.originProjectId ?? record.projectId,
            record.workspaceProjectId ?? record.projectId
          )
        );
      }
    }
    return chunks;
  }
}

const HTTP_URL_PATTERN = /^https?:\/\//i;

function sourceFromRecord(record: NormalizedResearchRecord, traceabilityKind = getTraceabilityKind(record)): ResearchSource {
  return {
    id: record.sourceId ?? `source_${record.id}`,
    projectId: record.projectId,
    kind: sourceKindFromRecord(record, traceabilityKind),
    title: record.title,
    url: record.sourceUri,
    retrievedAt: record.createdAt,
    metadata: {
      recordId: record.id,
      citation: record.citation,
      confidence: record.confidence,
      recordKind: record.kind,
      traceabilityKind,
      canSupportHypothesis: record.metadata.canSupportHypothesis === true,
      sourceQualityTier: record.metadata.sourceQualityTier,
      sourceQualityLabel: record.metadata.sourceQualityLabel,
      sourceCanSupportHypothesis: record.metadata.sourceCanSupportHypothesis
    },
    createdAt: record.createdAt
  };
}

function sourceKindFromRecord(record: NormalizedResearchRecord, traceabilityKind = getTraceabilityKind(record)): ResearchSourceKind {
  const sourceKind = typeof record.metadata.sourceKind === "string" ? record.metadata.sourceKind : undefined;
  if (
    sourceKind === "web" ||
    sourceKind === "paper" ||
    sourceKind === "file" ||
    sourceKind === "artifact" ||
    sourceKind === "log" ||
    sourceKind === "conversation"
  ) {
    return sourceKind;
  }
  const mapping: Record<NormalizedRecordKind, ResearchSourceKind> = {
    source: traceabilityKind === "external_source" && HTTP_URL_PATTERN.test(record.sourceUri ?? "") ? "web" : "file",
    artifact: "artifact",
    claim: traceabilityKind === "project_provenance" ? "conversation" : "log",
    evidence: traceabilityKind === "external_source" && HTTP_URL_PATTERN.test(record.sourceUri ?? "") ? "web" : "file",
    observation: "log",
    citation: HTTP_URL_PATTERN.test(record.sourceUri ?? record.citation ?? "") ? "web" : "file",
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
