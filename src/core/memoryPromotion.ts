import { createStableId, nowIso } from "./ids.js";
import type { GlobalMemoryItem, ResearchSnapshot, ValidationResult } from "./types.js";

export class MemoryPromotionEngine {
  promote(snapshot: ResearchSnapshot): GlobalMemoryItem[] {
    const recordsByEvidence = new Map<string, string[]>();
    for (const record of snapshot.normalizedRecords) {
      if (record.evidenceId) {
        const existing = recordsByEvidence.get(record.evidenceId) ?? [];
        existing.push(record.id);
        recordsByEvidence.set(record.evidenceId, existing);
      }
    }

    return snapshot.validationResults
      .filter(isPromotableValidation)
      .flatMap((validation) => {
        const evidenceIds = [...new Set([...validation.supportingEvidenceIds, ...validation.contradictingEvidenceIds])];
        const evidence = snapshot.evidence.filter((item) => evidenceIds.includes(item.id) && (item.citation || item.sourceUri || item.sourceId));
        return evidence
          .filter((item) => {
            const record = snapshot.normalizedRecords.find((candidate) => candidate.evidenceId === item.id && candidate.kind === "evidence");
            return record?.validationStatus === "validated" && record.metadata.traceabilityKind === "external_source";
          })
          .map((item): GlobalMemoryItem => ({
            id: createStableId("memory", `${validation.id}:${item.id}`),
            projectId: snapshot.project.id,
            sourceProjectId: snapshot.project.id,
            memoryScope: "global",
            title: item.title,
            content: item.summary,
            validationResultId: validation.id,
            supportingRecordIds: recordsByEvidence.get(item.id) ?? [],
            supportingEvidenceIds: [item.id],
            citations: [item.citation ?? item.sourceUri ?? item.sourceId ?? item.title],
            promotionReason: `Validation ${validation.status} with citation-backed external evidence.`,
            validationStatus: "validated",
            createdAt: nowIso()
          }));
      });
  }
}

function isPromotableValidation(validation: ValidationResult): boolean {
  return validation.status === "supported" || validation.status === "contradicted";
}
