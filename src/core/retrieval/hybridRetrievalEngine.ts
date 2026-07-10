import { cosineSimilarity, type EmbeddingProvider } from "../providers/embeddingProvider.js";
import { createId, nowIso } from "../shared/ids.js";
import type { HybridContext, ProjectContextSnapshot, ResearchSnapshot } from "../shared/types.js";

export class HybridRetrievalEngine {
  constructor(private readonly embeddingProvider: EmbeddingProvider) {}

  async buildContextFromProjectContext(snapshot: ResearchSnapshot, contextSnapshot: ProjectContextSnapshot, iteration?: number): Promise<HybridContext> {
    return this.buildContextInternal(snapshot, contextSnapshot, iteration);
  }

  private async buildContextInternal(snapshot: ResearchSnapshot, contextSnapshot: ProjectContextSnapshot, iteration?: number): Promise<HybridContext> {
    const activeQuery = contextSnapshot.query;
    const queryEmbedding = await this.embeddingProvider.embed(activeQuery);
    const queryTokens = new Set(tokens(activeQuery));
    const allowedChunkIds = new Set(contextSnapshot.selectedChunkIds);
    const allowedEntityIds = new Set(contextSnapshot.selectedEntityIds);
    const allowedRelationIds = new Set(contextSnapshot.selectedRelationIds);
    const allowedEvidenceIds = new Set(contextSnapshot.selectedEvidenceIds);
    const allowedSourceIds = new Set(contextSnapshot.selectedSourceIds);
    const selectedRecordIds = new Set(contextSnapshot.selectedRecordIds);
    let sourceById: Map<string, ResearchSnapshot["sources"][number]> | undefined;
    const vectorHits: Array<{ chunk: ResearchSnapshot["chunks"][number]; score: number }> = [];
    for (const chunk of snapshot.chunks) {
      if (!allowedChunkIds.has(chunk.id)) continue;
      vectorHits.push({
        chunk,
        score: chunk.embedding?.length ? cosineSimilarity(queryEmbedding, chunk.embedding) : lexicalScore(queryTokens, chunk.text)
      });
    }
    vectorHits.sort((a, b) => b.score - a.score);
    vectorHits.length = Math.min(vectorHits.length, 8);

    const entityHits: Array<{ entity: ResearchSnapshot["ontologyEntities"][number]; score: number }> = [];
    for (const entity of snapshot.ontologyEntities) {
      if (!allowedEntityIds.has(entity.id)) continue;
      entityHits.push({ entity, score: lexicalScore(queryTokens, `${entity.label} ${entity.description ?? ""}`) + entity.confidence });
    }
    entityHits.sort((a, b) => b.score - a.score);
    entityHits.length = Math.min(entityHits.length, 8);
    const relationHits: ResearchSnapshot["ontologyRelations"] = [];
    for (const relation of snapshot.ontologyRelations) {
      if (!allowedRelationIds.has(relation.id)) continue;
      relationHits.push(relation);
      if (relationHits.length >= 12) break;
    }
    const evidenceIds = new Set<string>();
    const artifactIds = new Set<string>();
    const citations = new Set<string>();

    for (const { chunk } of vectorHits) {
      if (chunk.evidenceId && allowedEvidenceIds.has(chunk.evidenceId)) evidenceIds.add(chunk.evidenceId);
      if (chunk.citation) citations.add(chunk.citation);
      if (allowedSourceIds.has(chunk.sourceId)) {
        sourceById ??= indexById(snapshot.sources);
        const source = sourceById.get(chunk.sourceId);
        if (source?.url || source?.doi || source?.rawPath) citations.add(source.url ?? source.doi ?? source.rawPath ?? source.title);
      }
    }
    for (const relation of relationHits) {
      if (relation.sourceEvidenceId && allowedEvidenceIds.has(relation.sourceEvidenceId)) evidenceIds.add(relation.sourceEvidenceId);
    }
    for (const id of allowedEvidenceIds) evidenceIds.add(id);
    if (evidenceIds.size) {
      const evidenceById = indexById(snapshot.evidence, evidenceIds);
      for (const evidenceId of evidenceIds) {
        const evidence = evidenceById.get(evidenceId);
        if (evidence?.citation || evidence?.sourceUri || evidence?.sourceId) {
          citations.add(evidence.citation ?? evidence.sourceUri ?? evidence.sourceId ?? evidence.title);
        }
      }
    }
    for (const record of snapshot.normalizedRecords) {
      if (!selectedRecordIds.has(record.id) || !record.artifactId) continue;
      artifactIds.add(record.artifactId as string);
    }
    for (const citation of contextSnapshot.citations) citations.add(citation);

    const vectorSummary = vectorHits.length ? buildVectorSummary(vectorHits) : "No vector chunks were available.";
    const graphSummary = entityHits.length ? buildGraphSummary(entityHits, relationHits) : "No ontology graph entities were available.";
    const citationList = [...citations];
    const retrievalScores: Record<string, number> = {};
    const vectorChunkIds: string[] = [];
    for (const { chunk, score } of vectorHits) {
      retrievalScores[chunk.id] = Number(score.toFixed(4));
      vectorChunkIds.push(chunk.id);
    }
    const ontologyEntityIds: string[] = [];
    for (const { entity, score } of entityHits) {
      retrievalScores[entity.id] = Number(score.toFixed(4));
      ontologyEntityIds.push(entity.id);
    }
    const ontologyRelationIds: string[] = [];
    for (const relation of relationHits) {
      retrievalScores[relation.id] = Number(relation.confidence.toFixed(4));
      ontologyRelationIds.push(relation.id);
    }
    const evidenceIdList = [...evidenceIds];
    const artifactIdList = [...artifactIds];

    return {
      id: createId("hybrid"),
      projectId: snapshot.project.id,
      iteration: contextSnapshot.iteration ?? iteration ?? Math.max(snapshot.openCodeRuns.length, snapshot.researchPlans.at(-1)?.iteration ?? 1),
      query: activeQuery,
      vectorChunkIds,
      ontologyEntityIds,
      ontologyRelationIds,
      evidenceIds: evidenceIdList,
      artifactIds: artifactIdList,
      citations: citationList,
      vectorSummary,
      graphSummary,
      contextText: [activeQuery, "## Vector Context", vectorSummary, "## Graph Context", graphSummary, "## Citations", citationList.join("\n")].join("\n\n"),
      retrievalScores,
      createdAt: nowIso()
    };
  }
}

function buildVectorSummary(vectorHits: Array<{ chunk: ResearchSnapshot["chunks"][number]; score: number }>): string {
  const lines: string[] = [];
  for (let index = 0; index < vectorHits.length; index += 1) {
    const hit = vectorHits[index];
    if (hit) lines.push(`${index + 1}. ${hit.chunk.text.slice(0, 180)}`);
  }
  return lines.join("\n");
}

function buildGraphSummary(
  entityHits: Array<{ entity: ResearchSnapshot["ontologyEntities"][number]; score: number }>,
  relationHits: ResearchSnapshot["ontologyRelations"]
): string {
  const lines: string[] = [];
  for (const { entity } of entityHits) {
    lines.push(`Entity: ${entity.type} - ${entity.label}`);
  }
  for (const relation of relationHits) {
    lines.push(`Relation: ${relation.subjectId} ${relation.predicate} ${relation.objectId}`);
  }
  return lines.join("\n");
}

function lexicalScore(queryTokens: Set<string>, text: string): number {
  if (!queryTokens.size) return 0;
  let score = 0;
  const weight = 1 / queryTokens.size;
  for (const token of tokens(text)) {
    if (queryTokens.has(token)) score += weight;
  }
  return score;
}

function indexById<T extends { id: string }>(items: T[], allowedIds?: Set<string>): Map<string, T> {
  const byId = new Map<string, T>();
  for (const item of items) {
    if (allowedIds && !allowedIds.has(item.id)) continue;
    if (!byId.has(item.id)) byId.set(item.id, item);
  }
  return byId;
}

function tokens(text: string): string[] {
  return (
    text
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s-]/gu, " ")
      .match(/\S+/g) ?? []
  );
}
