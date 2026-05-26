import { createId, nowIso } from "./ids.js";
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
    const rankedRecords = scopedRecords
      .filter(({ scope }) => scope !== "ephemeral")
      .map(({ record }) => record)
      .filter((record) => record.kind !== "error" && record.validationStatus !== "rejected")
      .filter((record) =>
        !(record.kind === "evidence" && ["weak", "excluded", "general_web"].includes(String(record.metadata.sourceQualityTier ?? "")))
      )
      .filter((record) =>
        !((record.metadata.traceabilityKind === "internal_artifact" || record.metadata.traceabilityKind === "project_provenance") && record.metadata.canSupportHypothesis !== true)
      )
      .map((record) => {
        const relevance = lexicalScore(query, `${record.title}\n${record.content}\n${JSON.stringify(record.metadata)}`);
        return { record, relevance, score: relevance + statusBoost(record.validationStatus) + qualityBoost(record.metadata.sourceQualityTier) };
      })
      .filter(({ record, relevance }) => normalizeMemoryScope(record.memoryScope) !== "global" || relevance > 0)
      .sort((left, right) => right.score - left.score)
      .slice(0, 24);

    const selectedRecordIds = new Set(rankedRecords.map(({ record }) => record.id));
    if (!selectedRecordIds.size) {
      throw new ProjectContextSelectionError(snapshot.project.id, iteration, query);
    }
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
    const selectedGlobalRecords = rankedRecords.filter(({ record }) => normalizeMemoryScope(record.memoryScope) === "global").length;
    const selectedProjectRecords = rankedRecords.length - selectedGlobalRecords;
    const candidateGlobalRecords = scopedRecords.filter(({ scope }) => scope === "global").length;
    const candidateProjectRecords = scopedRecords.length - candidateGlobalRecords;
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
      selectedRelationIds,
      citations: [...citations],
      selectionReason: [
        selectionPrefix,
        `Candidates: global=${candidateGlobalRecords}, project=${candidateProjectRecords}.`,
        `Selected records: global=${selectedGlobalRecords}, project=${selectedProjectRecords}.`,
        `Excluded records: ephemeral=${excludedEphemeral}, error=${excludedError}, rejected=${excludedRejected}, unsupportedInternal=${excludedUnsupportedInternal}, weakSupport=${excludedWeakSupport}, lowRelevanceGlobal=${excludedLowRelevanceGlobal}.`,
        "Ephemeral, error, rejected, unsupported internal, weak/general support, and low-relevance global records were excluded from ProjectContextSnapshot selection."
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

function qualityBoost(tier: unknown): number {
  if (tier === "scholarly" || tier === "public_authority" || tier === "standard") return 0.2;
  if (tier === "education" || tier === "credible_web") return 0.1;
  if (tier === "weak" || tier === "excluded" || tier === "general_web") return -0.3;
  return 0;
}

function isInternalCitation(value: string): boolean {
  return /^(project:\/\/|artifacts\/|logs\/|reports\/|knowledge\/|ontology\/|exports\/)/i.test(value.replace(/\\/g, "/"));
}
