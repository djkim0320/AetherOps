import { createStableId, nowIso } from "./ids.js";
import type { GlobalMemoryItem, ResearchSnapshot, ValidationResult } from "./types.js";

export class MemoryPromotionEngine {
  promote(snapshot: ResearchSnapshot): GlobalMemoryItem[] {
    const recordsByEvidence = new Map<string, string[]>();
    const firstEvidenceRecordByEvidence = new Map<string, ResearchSnapshot["normalizedRecords"][number]>();
    for (const record of snapshot.normalizedRecords) {
      if (record.evidenceId) {
        let existing = recordsByEvidence.get(record.evidenceId);
        if (!existing) {
          existing = [];
          recordsByEvidence.set(record.evidenceId, existing);
        }
        existing.push(record.id);
        if (record.kind === "evidence" && !firstEvidenceRecordByEvidence.has(record.evidenceId)) {
          firstEvidenceRecordByEvidence.set(record.evidenceId, record);
        }
      }
    }

    const memoryItems: GlobalMemoryItem[] = [];
    for (const validation of snapshot.validationResults) {
      if (!isPromotableValidation(validation)) continue;
      const evidenceIds = new Set<string>();
      for (const id of validation.supportingEvidenceIds) evidenceIds.add(id);
      for (const id of validation.contradictingEvidenceIds) evidenceIds.add(id);
      for (const item of snapshot.evidence) {
        if (!evidenceIds.has(item.id) || !(item.citation || item.sourceUri || item.sourceId)) continue;
        const record = firstEvidenceRecordByEvidence.get(item.id);
        if (record?.validationStatus !== "validated" || record.metadata.traceabilityKind !== "external_source") continue;
        memoryItems.push({
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
        });
      }
    }
    return memoryItems;
  }
}

function isPromotableValidation(validation: ValidationResult): boolean {
  return validation.status === "supported" || validation.status === "contradicted";
}
