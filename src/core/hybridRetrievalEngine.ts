import { cosineSimilarity, type EmbeddingProvider } from "./embeddingProvider.js";
import { createId, nowIso } from "./ids.js";
import type { HybridContext, ResearchSnapshot } from "./types.js";

export class HybridRetrievalEngine {
  constructor(private readonly embeddingProvider: EmbeddingProvider) {}

  async buildContext(snapshot: ResearchSnapshot, query?: string, iteration?: number): Promise<HybridContext> {
    const activeQuery = query || buildQuery(snapshot);
    const queryEmbedding = await this.embeddingProvider.embed(activeQuery);
    const vectorHits = snapshot.chunks
      .map((chunk) => ({
        chunk,
        score: chunk.embedding?.length ? cosineSimilarity(queryEmbedding, chunk.embedding) : lexicalScore(activeQuery, chunk.text)
      }))
      .sort((a, b) => b.score - a.score)
      .slice(0, 8);

    const queryTokens = new Set(tokens(activeQuery));
    const entityHits = snapshot.ontologyEntities
      .map((entity) => ({ entity, score: lexicalScore([...queryTokens].join(" "), `${entity.label} ${entity.description ?? ""}`) + entity.confidence }))
      .sort((a, b) => b.score - a.score)
      .slice(0, 8);
    const entityIds = new Set(entityHits.map(({ entity }) => entity.id));
    const relationHits = snapshot.ontologyRelations
      .filter((relation) => entityIds.has(relation.subjectId) || entityIds.has(relation.objectId))
      .slice(0, 12);
    const evidenceIds = new Set<string>();
    const artifactIds = new Set<string>();
    const citations = new Set<string>();

    for (const { chunk } of vectorHits) {
      if (chunk.evidenceId) evidenceIds.add(chunk.evidenceId);
      if (chunk.citation) citations.add(chunk.citation);
      const source = snapshot.sources.find((item) => item.id === chunk.sourceId);
      if (source?.url || source?.doi || source?.rawPath) citations.add(source.url ?? source.doi ?? source.rawPath ?? source.title);
    }
    for (const relation of relationHits) {
      if (relation.sourceEvidenceId) evidenceIds.add(relation.sourceEvidenceId);
    }
    for (const evidenceId of evidenceIds) {
      const evidence = snapshot.evidence.find((item) => item.id === evidenceId);
      if (evidence?.citation || evidence?.sourceUri || evidence?.sourceId) {
        citations.add(evidence.citation ?? evidence.sourceUri ?? evidence.sourceId ?? evidence.title);
      }
    }
    for (const artifact of snapshot.artifacts.slice(-8)) {
      artifactIds.add(artifact.id);
    }

    const vectorSummary = vectorHits.length
      ? vectorHits.map(({ chunk }, index) => `${index + 1}. ${chunk.text.slice(0, 180)}`).join("\n")
      : "No vector chunks were available.";
    const graphSummary = entityHits.length
      ? [
          ...entityHits.map(({ entity }) => `Entity: ${entity.type} - ${entity.label}`),
          ...relationHits.map((relation) => `Relation: ${relation.subjectId} ${relation.predicate} ${relation.objectId}`)
        ].join("\n")
      : "No ontology graph entities were available.";

    return {
      id: createId("hybrid"),
      projectId: snapshot.project.id,
      iteration: iteration ?? Math.max(snapshot.openCodeRuns.length, snapshot.researchPlans.at(-1)?.iteration ?? 1),
      query: activeQuery,
      vectorChunkIds: vectorHits.map(({ chunk }) => chunk.id),
      ontologyEntityIds: entityHits.map(({ entity }) => entity.id),
      ontologyRelationIds: relationHits.map((relation) => relation.id),
      evidenceIds: [...evidenceIds],
      artifactIds: [...artifactIds],
      citations: [...citations],
      vectorSummary,
      graphSummary,
      contextText: [activeQuery, "## Vector Context", vectorSummary, "## Graph Context", graphSummary, "## Citations", [...citations].join("\n")].join("\n\n"),
      retrievalScores: Object.fromEntries([
        ...vectorHits.map(({ chunk, score }) => [chunk.id, Number(score.toFixed(4))]),
        ...entityHits.map(({ entity, score }) => [entity.id, Number(score.toFixed(4))]),
        ...relationHits.map((relation) => [relation.id, Number(relation.confidence.toFixed(4))])
      ]),
      createdAt: nowIso()
    };
  }
}

function buildQuery(snapshot: ResearchSnapshot): string {
  const plan = snapshot.researchPlans.at(-1);
  return [
    snapshot.project.topic,
    snapshot.project.goal,
    plan?.objective,
    ...snapshot.questions.map((item) => item.text),
    ...snapshot.hypotheses.map((item) => item.statement),
    ...(snapshot.continuationDecisions.at(-1)?.evidenceGaps ?? [])
  ].filter(Boolean).join("\n");
}

function lexicalScore(query: string, text: string): number {
  const queryTokens = new Set(tokens(query));
  if (!queryTokens.size) return 0;
  return tokens(text).reduce((score, token) => score + (queryTokens.has(token) ? 1 / queryTokens.size : 0), 0);
}

function tokens(text: string): string[] {
  return text.toLowerCase().replace(/[^\p{L}\p{N}\s-]/gu, " ").split(/\s+/).filter(Boolean);
}
