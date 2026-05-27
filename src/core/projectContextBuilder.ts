import { createId, nowIso } from "./ids.js";
import { graphPathForEvidence, isSupportEligibleEvidenceRecord } from "./evidenceEligibility.js";
import { normalizeMemoryScope } from "./researchMemory.js";
import type { ProjectContextSnapshot, ResearchSnapshot, ResearchStore } from "./types.js";

export class ProjectContextSelectionError extends Error {
  constructor(
    readonly projectId: string,
    readonly iteration: number,
    readonly query: string
  ) {
    super(`ProjectContextSnapshot could not select any eligible records for project ${projectId} iteration ${iteration}.`);
    this.name = "ProjectContextSelectionError";
  }
}

export class ProjectContextBuilder {
  async buildFromMainMemory(input: {
    snapshot: ResearchSnapshot;
    iteration: number;
    store: Pick<ResearchStore, "searchGlobalRecords" | "searchGlobalChunks" | "searchGlobalGraph">;
  }): Promise<ProjectContextSnapshot> {
    const query = buildProjectQuery(input.snapshot);
    const [records, chunks, graph] = await Promise.all([
      input.store.searchGlobalRecords(query, { projectId: input.snapshot.project.id, limit: 64 }),
      input.store.searchGlobalChunks(query, { projectId: input.snapshot.project.id, limit: 32 }),
      input.store.searchGlobalGraph(query, { projectId: input.snapshot.project.id, limit: 32 })
    ]);
    return this.build({
      ...input.snapshot,
      normalizedRecords: records,
      chunks,
      ontologyEntities: graph.entities,
      ontologyRelations: graph.relations,
      ontologyConstraints: graph.constraints
    }, input.iteration, "Selected from Main Research Memory search API using the active ResearchPlan objective, target questions, target hypotheses, topic, scope, and evidence gaps.");
  }

  build(snapshot: ResearchSnapshot, iteration: number, selectionPrefix = "Selected from Main Research Memory using the active ResearchPlan objective, target questions, and target hypotheses."): ProjectContextSnapshot {
    const query = buildProjectQuery(snapshot);
    const scopedRecords = snapshot.normalizedRecords.map((record) => ({ record, scope: normalizeMemoryScope(record.memoryScope) }));
    const eligibleRecordById = new Map(
      scopedRecords
        .filter(({ scope }) => scope !== "ephemeral")
        .map(({ record }) => record)
        .filter(isEligibleRecord)
        .map((record) => [record.id, record])
    );
    const excludedEphemeral = scopedRecords.filter(({ scope }) => scope === "ephemeral").length;
    const excludedError = scopedRecords.filter(({ record }) => record.kind === "error").length;
    const excludedRejected = scopedRecords.filter(({ record }) => record.validationStatus === "rejected").length;
    const excludedUnsupportedInternal = scopedRecords.filter(({ record }) =>
      (record.metadata.traceabilityKind === "internal_artifact" || record.metadata.traceabilityKind === "project_provenance") &&
      record.metadata.canSupportHypothesis !== true
    ).length;
    const excludedWeakSupport = scopedRecords.filter(({ record }) =>
      record.kind === "evidence" &&
      ["weak", "excluded", "general_web"].includes(String(record.metadata.sourceQualityTier ?? ""))
    ).length;
    const rankedRecords = [...eligibleRecordById.values()]
      .map((record) => {
        const relevance = lexicalScore(query, `${record.title}\n${record.content}\n${JSON.stringify(record.metadata)}`);
        return { record, relevance, score: relevance + statusBoost(record.validationStatus) + qualityBoost(record.metadata.sourceQualityTier) };
      })
      .filter(({ record, relevance }) => normalizeMemoryScope(record.memoryScope) !== "global" || relevance > 0)
      .sort((left, right) => right.score - left.score)
      .slice(0, 24);

    const selectedRecordIds = new Set(rankedRecords.map(({ record }) => record.id));
    const rankedChunks = snapshot.chunks
      .filter((chunk) => normalizeMemoryScope(chunk.memoryScope) !== "ephemeral")
      .filter((chunk) => !chunk.recordId || eligibleRecordById.has(chunk.recordId))
      .map((chunk) => {
        const relevance = lexicalScore(query, `${chunk.text}\n${chunk.citation ?? ""}\n${chunk.recordKind ?? ""}\n${chunk.traceabilityKind ?? ""}`);
        return { chunk, relevance, score: relevance + statusBoost(chunk.validationStatus) + qualityBoost(chunk.sourceQualityTier) };
      })
      .filter(({ chunk, relevance }) => normalizeMemoryScope(chunk.memoryScope) !== "global" || relevance > 0)
      .sort((left, right) => right.score - left.score)
      .slice(0, 16);
    const selectedChunkIds = rankedChunks.map(({ chunk }) => chunk.id);
    for (const { chunk } of rankedChunks) {
      if (chunk.recordId && eligibleRecordById.has(chunk.recordId)) selectedRecordIds.add(chunk.recordId);
    }

    const rankedEntities = snapshot.ontologyEntities
      .filter((entity) => normalizeMemoryScope(entity.memoryScope) !== "ephemeral")
      .filter((entity) => !entity.sourceRecordId || eligibleRecordById.has(entity.sourceRecordId))
      .map((entity) => {
        const relevance = lexicalScore(query, `${entity.label}\n${entity.description ?? ""}\n${entity.type}`);
        return { entity, relevance, score: relevance + entity.confidence + statusBoost(entity.validationStatus) };
      })
      .filter(({ entity, relevance }) => normalizeMemoryScope(entity.memoryScope) !== "global" || relevance > 0)
      .sort((left, right) => right.score - left.score)
      .slice(0, 18);
    const selectedEntityIds = rankedEntities.map(({ entity }) => entity.id);
    const selectedEntitySet = new Set(selectedEntityIds);
    for (const { entity } of rankedEntities) {
      if (entity.sourceRecordId && eligibleRecordById.has(entity.sourceRecordId)) selectedRecordIds.add(entity.sourceRecordId);
    }

    const rankedRelations = snapshot.ontologyRelations
      .filter((relation) => normalizeMemoryScope(relation.memoryScope) !== "ephemeral")
      .filter((relation) => !relation.sourceRecordId || eligibleRecordById.has(relation.sourceRecordId))
      .filter((relation) => selectedEntitySet.has(relation.subjectId) || selectedEntitySet.has(relation.objectId) || lexicalScore(query, relation.predicate) > 0)
      .map((relation) => {
        const relevance = lexicalScore(query, `${relation.subjectId}\n${relation.predicate}\n${relation.objectId}`);
        return { relation, relevance, score: relevance + relation.confidence + statusBoost(relation.validationStatus) };
      })
      .filter(({ relation, relevance }) => normalizeMemoryScope(relation.memoryScope) !== "global" || relevance > 0 || selectedEntitySet.has(relation.subjectId) || selectedEntitySet.has(relation.objectId))
      .sort((left, right) => right.score - left.score)
      .slice(0, 24);
    const selectedRelationIds = new Set(rankedRelations.map(({ relation }) => relation.id));
    for (const { relation } of rankedRelations) {
      if (relation.sourceRecordId && eligibleRecordById.has(relation.sourceRecordId)) selectedRecordIds.add(relation.sourceRecordId);
    }

    if (!selectedRecordIds.size && !selectedChunkIds.length && !selectedEntityIds.length && !selectedRelationIds.size) {
      throw new ProjectContextSelectionError(snapshot.project.id, iteration, query);
    }
    const selectedRecords = [...selectedRecordIds].map((id) => eligibleRecordById.get(id)).filter((record): record is NonNullable<typeof record> => Boolean(record));
    const selectedSourceIds = new Set([
      ...selectedRecords.map((record) => record.sourceId).filter((id): id is string => Boolean(id)),
      ...rankedChunks.map(({ chunk }) => chunk.sourceId).filter((id): id is string => Boolean(id))
    ]);
    const eligibleEvidenceIds = new Set(
      [...eligibleRecordById.values()]
        .filter((record) => isSupportEligibleEvidenceRecord(record, graphPathForEvidence(snapshot, record.evidenceId ?? ""), { requireGraphPath: false }))
        .map((record) => record.evidenceId)
        .filter((id): id is string => Boolean(id))
    );
    const selectedEvidenceIds = new Set(
      selectedRecords
        .filter((record) => isSupportEligibleEvidenceRecord(record, graphPathForEvidence(snapshot, record.evidenceId ?? ""), { requireGraphPath: false }))
        .map((record) => record.evidenceId)
        .filter((id): id is string => Boolean(id))
    );
    for (const { chunk } of rankedChunks) {
      if (chunk.evidenceId && eligibleEvidenceIds.has(chunk.evidenceId)) selectedEvidenceIds.add(chunk.evidenceId);
    }
    for (const { entity } of rankedEntities) {
      if (entity.sourceEvidenceId && eligibleEvidenceIds.has(entity.sourceEvidenceId)) selectedEvidenceIds.add(entity.sourceEvidenceId);
    }
    for (const { relation } of rankedRelations) {
      if (relation.sourceEvidenceId && eligibleEvidenceIds.has(relation.sourceEvidenceId)) selectedEvidenceIds.add(relation.sourceEvidenceId);
    }
    for (const evidenceId of selectedEvidenceIds) {
      for (const relationId of graphPathForEvidence(snapshot, evidenceId).relationIds) {
        selectedRelationIds.add(relationId);
      }
    }
    const citations = new Set<string>();
    for (const record of selectedRecords) {
      if (record.kind === "evidence" || record.kind === "citation" || record.kind === "source") {
        const citation = record.citation ?? record.sourceUri;
        if (citation && !isInternalCitation(citation)) citations.add(citation);
      }
    }
    for (const { chunk } of rankedChunks) {
      if (chunk.citation && !isInternalCitation(chunk.citation)) citations.add(chunk.citation);
    }
    const selectedGlobalRecords = selectedRecords.filter((record) => normalizeMemoryScope(record.memoryScope) === "global").length;
    const selectedProjectRecords = selectedRecords.length - selectedGlobalRecords;
    const candidateGlobalRecords = scopedRecords.filter(({ scope }) => scope === "global").length;
    const candidateProjectRecords = scopedRecords.length - candidateGlobalRecords;
    const candidateChunks = snapshot.chunks.filter((chunk) => normalizeMemoryScope(chunk.memoryScope) !== "ephemeral").length;
    const candidateEntities = snapshot.ontologyEntities.filter((entity) => normalizeMemoryScope(entity.memoryScope) !== "ephemeral").length;
    const candidateRelations = snapshot.ontologyRelations.filter((relation) => normalizeMemoryScope(relation.memoryScope) !== "ephemeral").length;
    const excludedLowRelevanceGlobal = scopedRecords.filter(({ record, scope }) =>
      scope === "global" && lexicalScore(query, `${record.title}\n${record.content}\n${JSON.stringify(record.metadata)}`) <= 0
    ).length;

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
      selectedRelationIds: [...selectedRelationIds],
      citations: [...citations],
      selectionReason: [
        selectionPrefix,
        `Candidates: global=${candidateGlobalRecords}, project=${candidateProjectRecords}.`,
        `Context candidates: records=${scopedRecords.length}, chunks=${candidateChunks}, entities=${candidateEntities}, relations=${candidateRelations}.`,
        `Selected context: records=${selectedRecordIds.size}, chunks=${selectedChunkIds.length}, entities=${selectedEntityIds.length}, relations=${selectedRelationIds.size}, evidence=${selectedEvidenceIds.size}.`,
        `Selected records: global=${selectedGlobalRecords}, project=${selectedProjectRecords}.`,
        `Reverse-included parents: fromChunks=${rankedChunks.filter(({ chunk }) => chunk.recordId && selectedRecordIds.has(chunk.recordId)).length}, fromGraphRecords=${[...rankedEntities.map(({ entity }) => entity.sourceRecordId), ...rankedRelations.map(({ relation }) => relation.sourceRecordId)].filter((id) => id && selectedRecordIds.has(id)).length}, fromGraphEvidence=${[...rankedEntities.map(({ entity }) => entity.sourceEvidenceId), ...rankedRelations.map(({ relation }) => relation.sourceEvidenceId)].filter((id) => id && selectedEvidenceIds.has(id)).length}.`,
        `Excluded records: ephemeral=${excludedEphemeral}, error=${excludedError}, rejected=${excludedRejected}, unsupportedInternal=${excludedUnsupportedInternal}, weakSupport=${excludedWeakSupport}, lowRelevanceGlobal=${excludedLowRelevanceGlobal}.`,
        "Ephemeral, error, rejected, unsupported internal, weak/general support, and low-relevance global records were excluded from ProjectContextSnapshot selection."
      ].join(" "),
      createdAt: nowIso()
    };
  }
}

function isEligibleRecord(record: ResearchSnapshot["normalizedRecords"][number]): boolean {
  return record.kind !== "error" &&
    record.validationStatus !== "rejected" &&
    !(record.kind === "evidence" && ["weak", "excluded", "general_web"].includes(String(record.metadata.sourceQualityTier ?? ""))) &&
    !((record.metadata.traceabilityKind === "internal_artifact" || record.metadata.traceabilityKind === "project_provenance") && record.metadata.canSupportHypothesis !== true);
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

function qualityBoost(tier: unknown): number {
  if (tier === "scholarly" || tier === "public_authority" || tier === "standard") return 0.2;
  if (tier === "education" || tier === "credible_web") return 0.1;
  if (tier === "weak" || tier === "excluded" || tier === "general_web") return -0.3;
  return 0;
}

function isInternalCitation(value: string): boolean {
  return /^(project:\/\/|artifacts\/|logs\/|reports\/|knowledge\/|ontology\/|exports\/)/i.test(value.replace(/\\/g, "/"));
}
