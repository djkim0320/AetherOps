import { createId, nowIso } from "../shared/ids.js";
import { EMPTY_EVIDENCE_GRAPH_PATH, graphPathByEvidenceId, isSupportEligibleEvidenceRecord, type EvidenceGraphPath } from "../evidence/evidenceEligibility.js";
import { isContextCompressionRecord } from "../memory/contextCompression.js";
import { normalizeMemoryScope } from "../memory/researchMemory.js";
import type { ProjectContextSnapshot, ResearchSnapshot, ResearchStore } from "../shared/types.js";

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
    return this.build(
      {
        ...input.snapshot,
        normalizedRecords: records,
        chunks,
        ontologyEntities: graph.entities,
        ontologyRelations: graph.relations,
        ontologyConstraints: graph.constraints
      },
      input.iteration,
      "Selected from Main Research Memory search API using the active ResearchPlan objective, target questions, target hypotheses, topic, scope, and evidence gaps."
    );
  }

  build(
    snapshot: ResearchSnapshot,
    iteration: number,
    selectionPrefix = "Selected from Main Research Memory using the active ResearchPlan objective, target questions, and target hypotheses."
  ): ProjectContextSnapshot {
    const query = buildProjectQuery(snapshot);
    const queryTokens = new Set(tokens(query));
    const eligibleRecordById = new Map<string, ResearchSnapshot["normalizedRecords"][number]>();
    let excludedEphemeral = 0;
    let excludedError = 0;
    let excludedRejected = 0;
    let excludedUnsupportedInternal = 0;
    let excludedWeakSupport = 0;
    let candidateGlobalRecords = 0;
    let excludedLowRelevanceGlobal = 0;
    const globalRecordRelevanceById = new Map<string, number>();
    for (const record of snapshot.normalizedRecords) {
      const scope = normalizeMemoryScope(record.memoryScope);
      if (scope === "ephemeral") excludedEphemeral += 1;
      if (record.kind === "error") excludedError += 1;
      if (record.validationStatus === "rejected") excludedRejected += 1;
      if (
        !isContextCompressionRecord(record) &&
        (record.metadata.traceabilityKind === "internal_artifact" || record.metadata.traceabilityKind === "project_provenance") &&
        record.metadata.canSupportHypothesis !== true
      )
        excludedUnsupportedInternal += 1;
      if (record.kind === "evidence" && SUPPORT_EXCLUDED_TIERS.has(String(record.metadata.sourceQualityTier ?? ""))) excludedWeakSupport += 1;
      if (scope === "global") {
        candidateGlobalRecords += 1;
        const relevance = lexicalScore(queryTokens, recordSearchText(record));
        globalRecordRelevanceById.set(record.id, relevance);
        if (relevance <= 0) excludedLowRelevanceGlobal += 1;
      }
      if (scope !== "ephemeral" && isEligibleRecord(record)) eligibleRecordById.set(record.id, record);
    }
    const rankedRecords: Array<{ record: ResearchSnapshot["normalizedRecords"][number]; relevance: number; score: number }> = [];
    for (const record of eligibleRecordById.values()) {
      const scope = normalizeMemoryScope(record.memoryScope);
      const relevance =
        scope === "global"
          ? (globalRecordRelevanceById.get(record.id) ?? lexicalScore(queryTokens, recordSearchText(record)))
          : lexicalScore(queryTokens, recordSearchText(record));
      if (scope === "global" && relevance <= 0) continue;
      insertTopRanked(
        rankedRecords,
        {
          record,
          relevance,
          score: relevance + statusBoost(record.validationStatus) + qualityBoost(record.metadata.sourceQualityTier) + contextCompressionBoost(record)
        },
        24
      );
    }

    const selectedRecordIds = new Set<string>();
    for (const { record } of rankedRecords) {
      selectedRecordIds.add(record.id);
    }
    const rankedChunks: Array<{ chunk: ResearchSnapshot["chunks"][number]; relevance: number; score: number }> = [];
    for (const chunk of snapshot.chunks) {
      const scope = normalizeMemoryScope(chunk.memoryScope);
      if (scope === "ephemeral") continue;
      if (chunk.recordId && !eligibleRecordById.has(chunk.recordId)) continue;
      const relevance = lexicalScore(queryTokens, `${chunk.text}\n${chunk.citation ?? ""}\n${chunk.recordKind ?? ""}\n${chunk.traceabilityKind ?? ""}`);
      if (scope === "global" && relevance <= 0) continue;
      insertTopRanked(rankedChunks, { chunk, relevance, score: relevance + statusBoost(chunk.validationStatus) + qualityBoost(chunk.sourceQualityTier) }, 16);
    }
    const selectedChunkIds: string[] = [];
    for (const { chunk } of rankedChunks) {
      selectedChunkIds.push(chunk.id);
      if (chunk.recordId && eligibleRecordById.has(chunk.recordId)) selectedRecordIds.add(chunk.recordId);
    }

    const rankedEntities: Array<{ entity: ResearchSnapshot["ontologyEntities"][number]; relevance: number; score: number }> = [];
    for (const entity of snapshot.ontologyEntities) {
      const scope = normalizeMemoryScope(entity.memoryScope);
      if (scope === "ephemeral") continue;
      if (entity.sourceRecordId && !eligibleRecordById.has(entity.sourceRecordId)) continue;
      const relevance = lexicalScore(queryTokens, `${entity.label}\n${entity.description ?? ""}\n${entity.type}`);
      if (scope === "global" && relevance <= 0) continue;
      insertTopRanked(rankedEntities, { entity, relevance, score: relevance + entity.confidence + statusBoost(entity.validationStatus) }, 18);
    }
    const selectedEntityIds: string[] = [];
    const selectedEntitySet = new Set<string>();
    for (const { entity } of rankedEntities) {
      selectedEntityIds.push(entity.id);
      selectedEntitySet.add(entity.id);
      if (entity.sourceRecordId && eligibleRecordById.has(entity.sourceRecordId)) selectedRecordIds.add(entity.sourceRecordId);
    }

    const rankedRelations: Array<{ relation: ResearchSnapshot["ontologyRelations"][number]; relevance: number; score: number }> = [];
    for (const relation of snapshot.ontologyRelations) {
      const scope = normalizeMemoryScope(relation.memoryScope);
      if (scope === "ephemeral") continue;
      if (relation.sourceRecordId && !eligibleRecordById.has(relation.sourceRecordId)) continue;
      const linkedToSelectedEntity = selectedEntitySet.has(relation.subjectId) || selectedEntitySet.has(relation.objectId);
      const predicateRelevance = linkedToSelectedEntity ? 0 : lexicalScore(queryTokens, relation.predicate);
      if (!linkedToSelectedEntity && predicateRelevance <= 0) continue;
      const relevance = lexicalScore(queryTokens, `${relation.subjectId}\n${relation.predicate}\n${relation.objectId}`);
      if (scope === "global" && relevance <= 0 && !linkedToSelectedEntity) continue;
      insertTopRanked(rankedRelations, { relation, relevance, score: relevance + relation.confidence + statusBoost(relation.validationStatus) }, 24);
    }
    const selectedRelationIds = new Set<string>();
    for (const { relation } of rankedRelations) {
      selectedRelationIds.add(relation.id);
      if (relation.sourceRecordId && eligibleRecordById.has(relation.sourceRecordId)) selectedRecordIds.add(relation.sourceRecordId);
    }

    if (!selectedRecordIds.size && !selectedChunkIds.length && !selectedEntityIds.length && !selectedRelationIds.size) {
      throw new ProjectContextSelectionError(snapshot.project.id, iteration, query);
    }
    const selectedRecords: Array<ResearchSnapshot["normalizedRecords"][number]> = [];
    for (const id of selectedRecordIds) {
      const record = eligibleRecordById.get(id);
      if (record) selectedRecords.push(record);
    }
    const selectedSourceIds = new Set<string>();
    for (const record of selectedRecords) {
      if (record.sourceId) selectedSourceIds.add(record.sourceId);
    }
    for (const { chunk } of rankedChunks) {
      if (chunk.sourceId) selectedSourceIds.add(chunk.sourceId);
    }
    const evidenceGraphPathById = graphPathByEvidenceId(snapshot);
    const evidenceGraphPathFor = (evidenceId: string | undefined): EvidenceGraphPath =>
      evidenceGraphPathById.get(evidenceId ?? "") ?? EMPTY_EVIDENCE_GRAPH_PATH;
    const eligibleEvidenceIds = new Set<string>();
    for (const record of eligibleRecordById.values()) {
      if (isSupportEligibleEvidenceRecord(record, evidenceGraphPathFor(record.evidenceId), { requireGraphPath: false }) && record.evidenceId) {
        eligibleEvidenceIds.add(record.evidenceId);
      }
    }
    const selectedEvidenceIds = new Set<string>();
    for (const record of selectedRecords) {
      if (isSupportEligibleEvidenceRecord(record, evidenceGraphPathFor(record.evidenceId), { requireGraphPath: false }) && record.evidenceId) {
        selectedEvidenceIds.add(record.evidenceId);
      }
    }
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
      for (const relationId of evidenceGraphPathById.get(evidenceId)?.relationIds ?? []) {
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
    let selectedGlobalRecords = 0;
    for (const record of selectedRecords) {
      if (normalizeMemoryScope(record.memoryScope) === "global") selectedGlobalRecords += 1;
    }
    const selectedProjectRecords = selectedRecords.length - selectedGlobalRecords;
    const candidateProjectRecords = snapshot.normalizedRecords.length - candidateGlobalRecords;
    let candidateChunks = 0;
    for (const chunk of snapshot.chunks) {
      if (normalizeMemoryScope(chunk.memoryScope) !== "ephemeral") candidateChunks += 1;
    }
    let candidateEntities = 0;
    for (const entity of snapshot.ontologyEntities) {
      if (normalizeMemoryScope(entity.memoryScope) !== "ephemeral") candidateEntities += 1;
    }
    let candidateRelations = 0;
    for (const relation of snapshot.ontologyRelations) {
      if (normalizeMemoryScope(relation.memoryScope) !== "ephemeral") candidateRelations += 1;
    }
    let reverseIncludedFromChunks = 0;
    for (const { chunk } of rankedChunks) {
      if (chunk.recordId && selectedRecordIds.has(chunk.recordId)) reverseIncludedFromChunks += 1;
    }
    let reverseIncludedFromGraphRecords = 0;
    let reverseIncludedFromGraphEvidence = 0;
    for (const { entity } of rankedEntities) {
      if (entity.sourceRecordId && selectedRecordIds.has(entity.sourceRecordId)) reverseIncludedFromGraphRecords += 1;
      if (entity.sourceEvidenceId && selectedEvidenceIds.has(entity.sourceEvidenceId)) reverseIncludedFromGraphEvidence += 1;
    }
    for (const { relation } of rankedRelations) {
      if (relation.sourceRecordId && selectedRecordIds.has(relation.sourceRecordId)) reverseIncludedFromGraphRecords += 1;
      if (relation.sourceEvidenceId && selectedEvidenceIds.has(relation.sourceEvidenceId)) reverseIncludedFromGraphEvidence += 1;
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
      selectedRelationIds: [...selectedRelationIds],
      citations: [...citations],
      selectionReason: [
        selectionPrefix,
        `Candidates: global=${candidateGlobalRecords}, project=${candidateProjectRecords}.`,
        `Context candidates: records=${snapshot.normalizedRecords.length}, chunks=${candidateChunks}, entities=${candidateEntities}, relations=${candidateRelations}.`,
        `Selected context: records=${selectedRecordIds.size}, chunks=${selectedChunkIds.length}, entities=${selectedEntityIds.length}, relations=${selectedRelationIds.size}, evidence=${selectedEvidenceIds.size}.`,
        `Selected records: global=${selectedGlobalRecords}, project=${selectedProjectRecords}, compressed=${countContextCompressionRecords(selectedRecords)}.`,
        `Reverse-included parents: fromChunks=${reverseIncludedFromChunks}, fromGraphRecords=${reverseIncludedFromGraphRecords}, fromGraphEvidence=${reverseIncludedFromGraphEvidence}.`,
        `Excluded records: ephemeral=${excludedEphemeral}, error=${excludedError}, rejected=${excludedRejected}, unsupportedInternal=${excludedUnsupportedInternal}, weakSupport=${excludedWeakSupport}, lowRelevanceGlobal=${excludedLowRelevanceGlobal}.`,
        "Ephemeral, error, rejected, unsupported internal, weak/general support, and low-relevance global records were excluded from ProjectContextSnapshot selection."
      ].join(" "),
      createdAt: nowIso()
    };
  }
}

const SUPPORT_EXCLUDED_TIERS = new Set(["weak", "excluded", "general_web"]);
const INTERNAL_CITATION_PATTERN = /^(project:\/\/|artifacts\/|logs\/|reports\/|knowledge\/|ontology\/|exports\/)/i;

function isEligibleRecord(record: ResearchSnapshot["normalizedRecords"][number]): boolean {
  return (
    record.kind !== "error" &&
    record.validationStatus !== "rejected" &&
    !(record.kind === "evidence" && SUPPORT_EXCLUDED_TIERS.has(String(record.metadata.sourceQualityTier ?? ""))) &&
    (isContextCompressionRecord(record) ||
      !(
        (record.metadata.traceabilityKind === "internal_artifact" || record.metadata.traceabilityKind === "project_provenance") &&
        record.metadata.canSupportHypothesis !== true
      ))
  );
}

function buildProjectQuery(snapshot: ResearchSnapshot): string {
  const plan = snapshot.researchPlans.at(-1);
  const lines: string[] = [];
  pushLine(lines, snapshot.project.topic);
  pushLine(lines, snapshot.project.goal);
  pushLine(lines, plan?.objective);
  for (const question of plan?.targetQuestions ?? []) {
    pushLine(lines, question);
  }
  for (const hypothesis of plan?.targetHypotheses ?? []) {
    pushLine(lines, hypothesis);
  }
  for (const question of snapshot.questions) {
    pushLine(lines, question.text);
  }
  for (const hypothesis of snapshot.hypotheses) {
    pushLine(lines, hypothesis.statement);
  }
  return lines.join("\n");
}

function recordSearchText(record: ResearchSnapshot["normalizedRecords"][number]): string {
  return `${record.title}\n${record.content}\n${JSON.stringify(record.metadata)}`;
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

function insertTopRanked<T extends { score: number }>(ranked: T[], entry: T, limit: number): void {
  let insertAt = ranked.length;
  for (let index = 0; index < ranked.length; index += 1) {
    if (entry.score > ranked[index].score) {
      insertAt = index;
      break;
    }
  }
  if (insertAt >= limit) return;
  ranked.splice(insertAt, 0, entry);
  if (ranked.length > limit) ranked.pop();
}

function tokens(text: string): string[] {
  return (
    text
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s-]/gu, " ")
      .match(/\S+/g) ?? []
  );
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
  if (typeof tier === "string" && SUPPORT_EXCLUDED_TIERS.has(tier)) return -0.3;
  return 0;
}

function contextCompressionBoost(record: ResearchSnapshot["normalizedRecords"][number]): number {
  return isContextCompressionRecord(record) ? 0.35 : 0;
}

function countContextCompressionRecords(records: Array<ResearchSnapshot["normalizedRecords"][number]>): number {
  let count = 0;
  for (const record of records) {
    if (isContextCompressionRecord(record)) count += 1;
  }
  return count;
}

function isInternalCitation(value: string): boolean {
  const normalized = value.includes("\\") ? value.replace(/\\/g, "/") : value;
  return INTERNAL_CITATION_PATTERN.test(normalized);
}

function pushLine(lines: string[], value: string | undefined): void {
  if (value) lines.push(value);
}
