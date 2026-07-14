import type { ContextPackPersistenceReceipt } from "../../core/context/public.js";
import type { ResearchSnapshot } from "../../core/shared/evaluationTypes.js";
import type { ResearchSpecification } from "../../core/shared/researchTypes.js";

const MAX_CONTEXT_EVIDENCE = 512;
const MAX_CONTEXT_ARTIFACTS = 512;
const MAX_CONTEXT_MEMORIES = 64;
const MAX_CONTEXT_PRIOR_OUTPUTS = 24;

export function selectCanonicalContextCandidates(
  snapshot: ResearchSnapshot,
  specification: ResearchSpecification,
  resumeBinding?: ContextPackPersistenceReceipt
) {
  const selected = selectCanonicalContextCandidatesUnbound(snapshot, specification);
  return resumeBinding ? bindCheckpointCandidates(selected, resumeBinding) : selected;
}

function bindCheckpointCandidates(
  selected: ReturnType<typeof selectCanonicalContextCandidatesUnbound>,
  binding: ContextPackPersistenceReceipt
): ReturnType<typeof selectCanonicalContextCandidatesUnbound> {
  const sectionIds = (kind: "evidence" | "memory" | "artifacts" | "history") =>
    new Set(binding.sections.find((section) => section.kind === kind)?.entries.map((entry) => entry.id) ?? []);
  const evidenceIds = sectionIds("evidence");
  const memoryIds = sectionIds("memory");
  const artifactIds = sectionIds("artifacts");
  const historyIds = sectionIds("history");
  return {
    evidence: { ...selected.evidence, items: selected.evidence.items.filter((item) => evidenceIds.has(item.id)) },
    artifacts: { ...selected.artifacts, items: selected.artifacts.items.filter((item) => artifactIds.has(`artifact:${item.artifactId}`)) },
    memories: {
      items: selected.memories.items.filter((item) => memoryIds.has(item.id)),
      receipt: boundSelectionReceipt(binding.receipts.candidateSelections.memory)
    },
    priorOutputs: {
      items: selected.priorOutputs.items.filter((item) => item.artifactHandles.every((handle) => historyIds.has(`history:${item.id}:${handle.artifactId}`))),
      receipt: boundSelectionReceipt(binding.receipts.candidateSelections.priorOutputs)
    }
  };
}

function boundSelectionReceipt(receipt: ContextPackPersistenceReceipt["receipts"]["candidateSelections"]["memory"]): ReturnType<typeof selectionReceipt> {
  if (receipt.status === "selected") {
    return {
      source: receipt.source,
      status: "selected",
      candidateCount: receipt.candidateCount,
      selectedIds: [...receipt.selectedIds],
      omittedCount: receipt.omittedCount
    };
  }
  if (!receipt.emptyReason) throw new Error("Checkpoint-bound empty candidate selection is missing its reason.");
  return {
    source: receipt.source,
    status: "empty",
    candidateCount: receipt.candidateCount,
    selectedIds: [],
    omittedCount: receipt.omittedCount,
    emptyReason: receipt.emptyReason
  };
}

function selectCanonicalContextCandidatesUnbound(snapshot: ResearchSnapshot, specification: ResearchSpecification) {
  return {
    evidence: selectRelevantEvidence(snapshot),
    artifacts: selectPromotedArtifacts(snapshot),
    memories: selectProjectMemory(snapshot, specification),
    priorOutputs: selectRecentConversationHandles(snapshot)
  };
}

function selectRelevantEvidence(snapshot: ResearchSnapshot) {
  const receiptIds = new Map<string, string[]>();
  for (const validation of snapshot.validationResults) {
    for (const id of [...validation.supportingEvidenceIds, ...validation.contradictingEvidenceIds]) {
      receiptIds.set(id, [...(receiptIds.get(id) ?? []), validation.id]);
    }
  }
  const all = snapshot.evidence
    .filter((item) => receiptIds.has(item.id) && item.metadata?.quarantined !== true)
    .map((item) => ({
      id: item.id,
      projectId: item.projectId,
      text: `${item.title}\n${item.summary}`,
      priority: evidencePriority(item.reliabilityScore, item.relevanceScore),
      trust: hasVerificationReceipt(item.metadata) ? ("verified" as const) : ("untrusted" as const),
      sourceRefs: [
        ...new Set([
          ...(item.sourceId ? [item.sourceId] : []),
          ...(receiptIds.get(item.id) ?? []),
          ...(hasVerificationReceipt(item.metadata) ? [item.metadata.verificationReceiptId] : [])
        ])
      ].sort()
    }))
    .sort((left, right) => right.priority - left.priority || left.id.localeCompare(right.id));
  return { items: all.slice(0, MAX_CONTEXT_EVIDENCE), omitted: Math.max(0, all.length - MAX_CONTEXT_EVIDENCE) };
}

function selectPromotedArtifacts(snapshot: ResearchSnapshot) {
  const all = snapshot.artifacts
    .filter((item) => item.category !== "conversation_memo" && item.metadata?.quarantined !== true)
    .flatMap((item) => {
      const sha256 = item.metadata?.sha256;
      return typeof sha256 === "string" && /^[a-f0-9]{64}$/i.test(sha256)
        ? [{ artifactId: item.id, projectId: item.projectId, kind: item.category, sha256: sha256.toLowerCase(), priority: 800, trust: "tool" as const }]
        : [];
    })
    .sort((left, right) => left.artifactId.localeCompare(right.artifactId));
  return { items: all.slice(0, MAX_CONTEXT_ARTIFACTS), omitted: Math.max(0, all.length - MAX_CONTEXT_ARTIFACTS) };
}

function selectProjectMemory(snapshot: ResearchSnapshot, specification: ResearchSpecification) {
  const projectId = snapshot.project.id;
  const validations = new Map(snapshot.validationResults.filter((item) => item.projectId === projectId).map((item) => [item.id, item]));
  const evidenceIds = new Set(snapshot.evidence.filter((item) => item.projectId === projectId && item.metadata?.quarantined !== true).map((item) => item.id));
  const queryTerms = contextQueryTerms(snapshot, specification);
  const eligible = (snapshot.globalMemoryItems ?? [])
    .filter((item) => item.projectId === projectId || item.sourceProjectId === projectId)
    .filter((item) => item.validationStatus === "validated")
    .flatMap((item) => {
      const validation = validations.get(item.validationResultId);
      if (!validation || !["supported", "partially_supported"].includes(validation.status)) return [];
      if (!item.supportingEvidenceIds.length || item.supportingEvidenceIds.some((id) => !evidenceIds.has(id))) return [];
      const relevance = lexicalRelevance(queryTerms, `${item.title}\n${item.content}`);
      return relevance ? [{ item, relevance }] : [];
    })
    .sort(
      (left, right) => right.relevance - left.relevance || right.item.createdAt.localeCompare(left.item.createdAt) || left.item.id.localeCompare(right.item.id)
    );
  const selected = eligible.slice(0, MAX_CONTEXT_MEMORIES).map(({ item, relevance }) => ({
    id: item.id,
    projectId,
    text: `${item.title}\n${item.content}`,
    priority: Math.min(900, 700 + relevance * 10),
    trust: "verified" as const,
    stale: false,
    sourceRefs: [...new Set([item.validationResultId, ...item.supportingRecordIds, ...item.supportingEvidenceIds])].sort()
  }));
  return {
    items: selected,
    receipt: selectionReceipt(
      "snapshot.global_memory_items",
      eligible.length,
      selected.map((item) => item.id),
      "no_project_validated_candidates"
    )
  };
}

function selectRecentConversationHandles(snapshot: ResearchSnapshot) {
  const eligible = snapshot.artifacts
    .filter((item) => item.projectId === snapshot.project.id && item.category === "conversation_memo" && item.metadata?.quarantined !== true)
    .flatMap((item) => {
      const sha256 = item.metadata?.sha256;
      return typeof sha256 === "string" && /^[a-f0-9]{64}$/i.test(sha256) ? [{ item, sha256: sha256.toLowerCase() }] : [];
    })
    .sort((left, right) => right.item.createdAt.localeCompare(left.item.createdAt) || left.item.id.localeCompare(right.item.id));
  const selected = eligible.slice(0, MAX_CONTEXT_PRIOR_OUTPUTS).map(({ item, sha256 }, index) => ({
    id: `prior:${item.id}`,
    projectId: snapshot.project.id,
    priority: 800 - index,
    trust: "project" as const,
    artifactHandles: [{ artifactId: item.id, kind: "conversation_memo", sha256 }]
  }));
  return {
    items: selected,
    receipt: selectionReceipt(
      "snapshot.conversation_artifacts",
      eligible.length,
      selected.map((item) => item.id),
      "no_hash_bearing_conversation_artifacts"
    )
  };
}

function selectionReceipt(
  source: "snapshot.global_memory_items" | "snapshot.conversation_artifacts",
  candidateCount: number,
  selectedIds: string[],
  emptyReason: "no_project_validated_candidates" | "no_hash_bearing_conversation_artifacts"
) {
  const omittedCount = candidateCount - selectedIds.length;
  return selectedIds.length
    ? { source, status: "selected" as const, candidateCount, selectedIds: [...selectedIds].sort(), omittedCount }
    : { source, status: "empty" as const, candidateCount: 0, selectedIds: [], omittedCount: 0, emptyReason };
}

function contextQueryTerms(snapshot: ResearchSnapshot, specification: ResearchSpecification): Set<string> {
  return new Set(
    [
      snapshot.project.goal,
      snapshot.project.topic,
      snapshot.project.scope,
      specification.scope,
      ...specification.researchQuestions,
      ...specification.refinedHypotheses
    ]
      .flatMap((value) => value.toLocaleLowerCase("en-US").match(/[\p{L}\p{N}]+/gu) ?? [])
      .filter((term) => term.length >= 2)
  );
}

function lexicalRelevance(queryTerms: Set<string>, value: string): number {
  const terms = new Set((value.toLocaleLowerCase("en-US").match(/[\p{L}\p{N}]+/gu) ?? []).filter((term) => term.length >= 2));
  let matches = 0;
  for (const term of queryTerms) if (terms.has(term)) matches += 1;
  return matches;
}

function evidencePriority(reliability?: number, relevance?: number): number {
  const normalized = [reliability, relevance].filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  if (!normalized.length) return 700;
  return Math.max(1, Math.min(900, Math.round((normalized.reduce((sum, value) => sum + value, 0) / normalized.length) * 100)));
}

function hasVerificationReceipt(metadata: Record<string, unknown> | undefined): metadata is Record<string, unknown> & { verificationReceiptId: string } {
  return typeof metadata?.verificationReceiptId === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(metadata.verificationReceiptId);
}
