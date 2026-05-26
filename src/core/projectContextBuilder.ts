import { createId, nowIso } from "./ids.js";
import { normalizeMemoryScope } from "./researchMemory.js";
import type { ProjectContextSnapshot, ResearchSnapshot } from "./types.js";

export class ProjectContextBuilder {
  build(snapshot: ResearchSnapshot, iteration: number): ProjectContextSnapshot {
    const query = buildProjectQuery(snapshot);
    const rankedRecords = snapshot.normalizedRecords
      .filter((record) => normalizeMemoryScope(record.memoryScope) !== "ephemeral")
      .filter((record) => record.kind !== "error" && record.validationStatus !== "rejected")
      .map((record) => ({ record, score: lexicalScore(query, `${record.title}\n${record.content}`) + statusBoost(record.validationStatus) }))
      .sort((left, right) => right.score - left.score)
      .slice(0, 24);

    const selectedRecordIds = new Set(rankedRecords.map(({ record }) => record.id));
    const selectedSourceIds = new Set(rankedRecords.map(({ record }) => record.sourceId).filter((id): id is string => Boolean(id)));
    const selectedEvidenceIds = new Set(
      rankedRecords
        .filter(({ record }) => record.kind === "evidence" && record.metadata.canSupportHypothesis === true)
        .map(({ record }) => record.evidenceId)
        .filter((id): id is string => Boolean(id))
    );
    const selectedChunkIds = snapshot.chunks
      .filter((chunk) => chunk.recordId && selectedRecordIds.has(chunk.recordId))
      .filter((chunk) => normalizeMemoryScope(chunk.memoryScope) !== "ephemeral")
      .slice(0, 16)
      .map((chunk) => chunk.id);
    const selectedEntityIds = snapshot.ontologyEntities
      .filter((entity) => entity.sourceRecordId && selectedRecordIds.has(entity.sourceRecordId))
      .slice(0, 18)
      .map((entity) => entity.id);
    const selectedEntitySet = new Set(selectedEntityIds);
    const selectedRelationIds = snapshot.ontologyRelations
      .filter((relation) =>
        relation.sourceRecordId &&
        selectedRecordIds.has(relation.sourceRecordId) &&
        (selectedEntitySet.has(relation.subjectId) || selectedEntitySet.has(relation.objectId))
      )
      .slice(0, 24)
      .map((relation) => relation.id);
    const citations = new Set<string>();
    for (const { record } of rankedRecords) {
      if (record.kind === "evidence" || record.kind === "citation" || record.kind === "source") {
        const citation = record.citation ?? record.sourceUri;
        if (citation && !isInternalCitation(citation)) citations.add(citation);
      }
    }

    return {
      id: createId("project-context"),
      projectId: snapshot.project.id,
      iteration,
      query,
      selectedRecordIds: [...selectedRecordIds],
      selectedSourceIds: [...selectedSourceIds],
      selectedEvidenceIds: [...selectedEvidenceIds],
      selectedChunkIds,
      selectedEntityIds,
      selectedRelationIds,
      citations: [...citations],
      selectionReason: [
        "Selected from Main Research Memory using the active ResearchPlan objective, target questions, and target hypotheses.",
        "Ephemeral, error, rejected, and unsupported internal records were excluded from support evidence selection."
      ].join(" "),
      createdAt: nowIso()
    };
  }
}

function buildProjectQuery(snapshot: ResearchSnapshot): string {
  const plan = snapshot.researchPlans.at(-1);
  return [
    snapshot.project.topic,
    snapshot.project.goal,
    plan?.objective,
    ...(plan?.targetQuestions ?? []),
    ...(plan?.targetHypotheses ?? []),
    ...snapshot.questions.map((question) => question.text),
    ...snapshot.hypotheses.map((hypothesis) => hypothesis.statement)
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

function statusBoost(status: string | undefined): number {
  if (status === "validated") return 0.4;
  if (status === "graph_linked" || status === "indexed") return 0.2;
  if (status === "normalized") return 0.1;
  return 0;
}

function isInternalCitation(value: string): boolean {
  return /^(project:\/\/|artifacts\/|logs\/|reports\/|knowledge\/|ontology\/|exports\/)/i.test(value.replace(/\\/g, "/"));
}
