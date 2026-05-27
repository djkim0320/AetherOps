import { normalizeMemoryScope } from "./researchMemory.js";
import type { NormalizedResearchRecord, OntologyRelation, ResearchSnapshot } from "./types.js";

export interface EvidenceGraphPath {
  hasSourcePath: boolean;
  hasCitationPath: boolean;
  relationIds: string[];
}

export function graphPathForEvidence(snapshot: ResearchSnapshot, evidenceId: string): EvidenceGraphPath {
  const relations = snapshot.ontologyRelations.filter((relation) => relation.sourceEvidenceId === evidenceId);
  const hasSourcePath = relations.some((relation) => relation.predicate === "derivedFrom" || relation.predicate === "cites");
  const hasCitationPath = relations.some((relation) => relation.predicate === "cites" || relation.predicate === "supports" || relation.predicate === "contradicts");
  return {
    hasSourcePath,
    hasCitationPath,
    relationIds: relations.map((relation) => relation.id)
  };
}

export function relationBackedEvidenceIds(relations: OntologyRelation[]): Set<string> {
  return new Set(
    relations
      .filter((relation) => relation.sourceEvidenceId && (relation.predicate === "derivedFrom" || relation.predicate === "cites" || relation.predicate === "supports" || relation.predicate === "contradicts"))
      .map((relation) => relation.sourceEvidenceId as string)
  );
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
    !["weak", "excluded", "general_web"].includes(sourceQualityTier) &&
    normalizeMemoryScope(record.memoryScope) !== "ephemeral" &&
    record.validationStatus !== "rejected" &&
    hasCitation &&
    (!options.preferSpan || hasSpan || traceabilityKind === "tool_observation") &&
    graphOk;
}
