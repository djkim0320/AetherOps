import { createId, nowIso } from "./ids.js";
import { EMPTY_EVIDENCE_GRAPH_PATH, graphPathByEvidenceId, isSupportEligibleEvidenceRecord } from "./evidenceEligibility.js";
import type { HybridContext, ResearchSnapshot, ValidationResult } from "./types.js";
import type { ReasoningSummary } from "./reasoningEngine.js";

export class ValidationEngine {
  validate(snapshot: ResearchSnapshot, hybridContext: HybridContext, reasoning: ReasoningSummary[]): ValidationResult[] {
    const supportEligibleEvidenceIds = supportEligibleEvidenceIdsFor(snapshot);
    const contextEvidenceIds = new Set(hybridContext.evidenceIds);
    const orderedContextEvidence: Array<ResearchSnapshot["evidence"][number]> = [];
    for (let order = 0; order < snapshot.evidence.length; order += 1) {
      const entry = snapshot.evidence[order];
      if (!entry || !contextEvidenceIds.has(entry.id)) continue;
      orderedContextEvidence.push(entry);
    }

    const validationResults: ValidationResult[] = [];
    for (const item of reasoning) {
      const supportingEvidenceIds: string[] = [];
      const contradictingEvidenceIds: string[] = [];
      const selectedEvidenceIds = new Set<string>();
      for (const id of item.supportingEvidenceIds) {
        if (!supportEligibleEvidenceIds.has(id)) continue;
        supportingEvidenceIds.push(id);
        selectedEvidenceIds.add(id);
      }
      for (const id of item.contradictingEvidenceIds) {
        if (!supportEligibleEvidenceIds.has(id)) continue;
        contradictingEvidenceIds.push(id);
        selectedEvidenceIds.add(id);
      }
      const limitations = new Set<string>();
      let evidenceCount = 0;
      let citedEvidenceCount = 0;
      let strongEvidenceCount = 0;
      let confidenceTotal = 0;
      for (const entry of orderedContextEvidence) {
        if (!selectedEvidenceIds.has(entry.id)) continue;
        evidenceCount += 1;
        confidenceTotal += ((entry.reliabilityScore ?? 0.35) + (entry.relevanceScore ?? 0.45)) / 2;
        if (entry.citation || entry.sourceUri || entry.sourceId) citedEvidenceCount += 1;
        if (entry.evidenceStrength === "strong" || (entry.reliabilityScore ?? 0) >= 0.7) strongEvidenceCount += 1;
        for (const limitation of entry.limitations ?? []) limitations.add(limitation);
      }
      const citationCoverage = evidenceCount ? citedEvidenceCount / evidenceCount : 0;
      const gaps = [...item.evidenceGaps];
      if (!evidenceCount) {
        gaps.push("No evidence is linked to this hypothesis.");
      }
      if (evidenceCount && citationCoverage < 0.5) {
        gaps.push("Most linked evidence lacks citation/sourceUri/sourceId traceability.");
      }

      const result: ValidationResult = {
        id: createId("validation"),
        projectId: snapshot.project.id,
        iteration: hybridContext.iteration,
        hypothesisId: item.hypothesisId,
        status: statusFor({
          supporting: supportingEvidenceIds.length,
          contradicting: contradictingEvidenceIds.length,
          strong: strongEvidenceCount,
          gaps: gaps.length,
          citationCoverage
        }),
        confidence: confidenceFor(confidenceTotal, evidenceCount, citationCoverage, gaps.length),
        supportingEvidenceIds,
        contradictingEvidenceIds,
        relatedEntityIds: hybridContext.ontologyEntityIds,
        relatedRelationIds: hybridContext.ontologyRelationIds,
        reasoningSummary: item.summary,
        limitations: validationLimitations(limitations, citationCoverage),
        evidenceGaps: uniqueStrings(gaps),
        createdAt: nowIso()
      };
      validationResults.push(result);
    }
    return validationResults;
  }
}

function statusFor(input: {
  supporting: number;
  contradicting: number;
  strong: number;
  gaps: number;
  citationCoverage: number;
}): ValidationResult["status"] {
  if (!input.supporting && !input.contradicting) return "not_tested";
  if (input.contradicting > input.supporting && input.citationCoverage >= 0.4) return "contradicted";
  if (input.supporting > 0 && input.gaps === 0 && input.citationCoverage >= 0.6 && input.strong > 0) return "supported";
  if (input.supporting > 0 && input.citationCoverage >= 0.3) return "partially_supported";
  return "inconclusive";
}

function confidenceFor(totalEvidenceScore: number, evidenceCount: number, citationCoverage: number, gaps: number): number {
  if (!evidenceCount) return 0.2;
  const average = totalEvidenceScore / evidenceCount;
  return Math.max(0.05, Math.min(0.95, average * 0.7 + citationCoverage * 0.25 - gaps * 0.05));
}

function validationLimitations(limitations: Set<string>, citationCoverage: number): string[] {
  const values: string[] = [];
  for (const limitation of limitations) values.push(limitation);
  if (citationCoverage < 0.5) values.push("Citation coverage is weak.");
  return values;
}

function uniqueStrings(items: string[]): string[] {
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const item of items) {
    if (seen.has(item)) continue;
    seen.add(item);
    unique.push(item);
  }
  return unique;
}

function supportEligibleEvidenceIdsFor(snapshot: ResearchSnapshot): Set<string> {
  const graphPaths = graphPathByEvidenceId(snapshot);
  const supportEligibleEvidenceIds = new Set<string>();
  for (const record of snapshot.normalizedRecords) {
    if (!record.evidenceId) continue;
    const graphPath = graphPaths.get(record.evidenceId) ?? EMPTY_EVIDENCE_GRAPH_PATH;
    if (isSupportEligibleEvidenceRecord(record, graphPath, { requireGraphPath: true })) {
      supportEligibleEvidenceIds.add(record.evidenceId);
    }
  }
  return supportEligibleEvidenceIds;
}
