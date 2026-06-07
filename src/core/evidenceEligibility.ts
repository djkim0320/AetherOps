import { normalizeMemoryScope } from "./researchMemory.js";
import type { NormalizedResearchRecord, OntologyRelation, ResearchSnapshot } from "./types.js";

export interface EvidenceGraphPath {
  hasSourcePath: boolean;
  hasCitationPath: boolean;
  relationIds: string[];
}

export const EMPTY_EVIDENCE_GRAPH_PATH: EvidenceGraphPath = {
  hasSourcePath: false,
  hasCitationPath: false,
  relationIds: []
};

export function graphPathForEvidence(snapshot: ResearchSnapshot, evidenceId: string): EvidenceGraphPath {
  const relationIds: string[] = [];
  let hasSourcePath = false;
  let hasCitationPath = false;
  for (const relation of snapshot.ontologyRelations) {
    if (relation.sourceEvidenceId !== evidenceId) continue;
    relationIds.push(relation.id);
    if (relation.predicate === "derivedFrom" || relation.predicate === "cites") hasSourcePath = true;
    if (relation.predicate === "cites" || relation.predicate === "supports" || relation.predicate === "contradicts") hasCitationPath = true;
  }
  return { hasSourcePath, hasCitationPath, relationIds };
}

export function graphPathByEvidenceId(snapshot: ResearchSnapshot): Map<string, EvidenceGraphPath> {
  const paths = new Map<string, EvidenceGraphPath>();
  for (const relation of snapshot.ontologyRelations) {
    if (relation.sourceEvidenceId === undefined) continue;
    let path = paths.get(relation.sourceEvidenceId);
    if (!path) {
      path = { hasSourcePath: false, hasCitationPath: false, relationIds: [] };
      paths.set(relation.sourceEvidenceId, path);
    }
    path.relationIds.push(relation.id);
    if (relation.predicate === "derivedFrom" || relation.predicate === "cites") path.hasSourcePath = true;
    if (relation.predicate === "cites" || relation.predicate === "supports" || relation.predicate === "contradicts") path.hasCitationPath = true;
  }
  return paths;
}

export function relationBackedEvidenceIds(relations: OntologyRelation[]): Set<string> {
  const evidenceIds = new Set<string>();
  for (const relation of relations) {
    if (
      relation.sourceEvidenceId &&
      (relation.predicate === "derivedFrom" || relation.predicate === "cites" || relation.predicate === "supports" || relation.predicate === "contradicts")
    ) {
      evidenceIds.add(relation.sourceEvidenceId);
    }
  }
  return evidenceIds;
}

export function isSupportEligibleEvidenceRecord(
  record: NormalizedResearchRecord,
  graphPath?: EvidenceGraphPath,
  options: { requireGraphPath?: boolean; preferSpan?: boolean } = {}
): boolean {
  const traceabilityKind = String(record.metadata.traceabilityKind ?? "");
  const sourceQualityTier = String(record.metadata.sourceQualityTier ?? "");
  const hasCitation = Boolean(record.citation || record.sourceUri || record.metadata.doi || record.metadata.pdfUrl);
  const hasSpan = Boolean(record.metadata.page || record.metadata.spanStart !== undefined || record.metadata.spanEnd !== undefined || record.metadata.quote || record.metadata.extractionMethod === "pdf_text_span");
  const graphOk = !options.requireGraphPath || Boolean(graphPath?.hasSourcePath || graphPath?.hasCitationPath);
  return record.kind === "evidence" &&
    record.metadata.canSupportHypothesis === true &&
    record.metadata.sourceCanSupportHypothesis !== false &&
    (traceabilityKind === "external_source" || traceabilityKind === "tool_observation") &&
    !SUPPORT_EXCLUDED_TIERS.has(sourceQualityTier) &&
    normalizeMemoryScope(record.memoryScope) !== "ephemeral" &&
    record.validationStatus !== "rejected" &&
    hasCitation &&
    (!options.preferSpan || hasSpan || traceabilityKind === "tool_observation") &&
    graphOk;
}

const SUPPORT_EXCLUDED_TIERS = new Set(["weak", "excluded", "general_web"]);
