import { createId, nowIso } from "./ids.js";
import { graphPathForEvidence, isSupportEligibleEvidenceRecord } from "./evidenceEligibility.js";
import type { HybridContext, ResearchSnapshot, ValidationResult } from "./types.js";
import type { ReasoningSummary } from "./reasoningEngine.js";

export class ValidationEngine {
  validate(snapshot: ResearchSnapshot, hybridContext: HybridContext, reasoning: ReasoningSummary[]): ValidationResult[] {
    const supportEligibleEvidenceIds = new Set(
      snapshot.normalizedRecords
        .filter((record) => record.evidenceId && isSupportEligibleEvidenceRecord(record, graphPathForEvidence(snapshot, record.evidenceId), { requireGraphPath: true }))
        .map((record) => record.evidenceId as string)
    );
    return reasoning.map((item) => {
      const supportingEvidenceIds = item.supportingEvidenceIds.filter((id) => supportEligibleEvidenceIds.has(id));
      const contradictingEvidenceIds = item.contradictingEvidenceIds.filter((id) => supportEligibleEvidenceIds.has(id));
      const contextEvidenceIds = new Set(hybridContext.evidenceIds);
      const evidence = snapshot.evidence.filter((entry) =>
        contextEvidenceIds.has(entry.id) && (supportingEvidenceIds.includes(entry.id) || contradictingEvidenceIds.includes(entry.id))
      );
      const citedEvidence = evidence.filter((entry) => entry.citation || entry.sourceUri || entry.sourceId);
      const citationCoverage = evidence.length ? citedEvidence.length / evidence.length : 0;
      const strongEvidence = evidence.filter((entry) => entry.evidenceStrength === "strong" || (entry.reliabilityScore ?? 0) >= 0.7);
      const gaps = [...item.evidenceGaps];
      if (!evidence.length) {
        gaps.push("No evidence is linked to this hypothesis.");
      }
      if (evidence.length && citationCoverage < 0.5) {
        gaps.push("Most linked evidence lacks citation/sourceUri/sourceId traceability.");
      }

      return {
        id: createId("validation"),
        projectId: snapshot.project.id,
        iteration: hybridContext.iteration,
        hypothesisId: item.hypothesisId,
        status: statusFor({
          supporting: supportingEvidenceIds.length,
          contradicting: contradictingEvidenceIds.length,
          strong: strongEvidence.length,
          gaps: gaps.length,
          citationCoverage
        }),
        confidence: confidenceFor(evidence, citationCoverage, gaps.length),
        supportingEvidenceIds,
        contradictingEvidenceIds,
        relatedEntityIds: hybridContext.ontologyEntityIds,
        relatedRelationIds: hybridContext.ontologyRelationIds,
        reasoningSummary: item.summary,
        limitations: [
          ...new Set(evidence.flatMap((entry) => entry.limitations ?? [])),
          ...(citationCoverage < 0.5 ? ["Citation coverage is weak."] : [])
        ],
        evidenceGaps: [...new Set(gaps)],
        createdAt: nowIso()
      };
    });
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

function confidenceFor(evidence: Array<{ reliabilityScore?: number; relevanceScore?: number }>, citationCoverage: number, gaps: number): number {
  if (!evidence.length) return 0.2;
  const average = evidence.reduce((sum, item) => sum + ((item.reliabilityScore ?? 0.35) + (item.relevanceScore ?? 0.45)) / 2, 0) / evidence.length;
  return Math.max(0.05, Math.min(0.95, average * 0.7 + citationCoverage * 0.25 - gaps * 0.05));
}
