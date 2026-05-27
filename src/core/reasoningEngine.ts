import { graphPathForEvidence, isSupportEligibleEvidenceRecord } from "./evidenceEligibility.js";
import type { HybridContext, ResearchSnapshot } from "./types.js";

export interface ReasoningSummary {
  hypothesisId?: string;
  supportingEvidenceIds: string[];
  contradictingEvidenceIds: string[];
  evidenceGaps: string[];
  summary: string;
}

export class ReasoningEngine {
  reason(snapshot: ResearchSnapshot, hybridContext: HybridContext): ReasoningSummary[] {
    const supportEligibleEvidenceIds = new Set(
      snapshot.normalizedRecords
        .filter((record) => record.evidenceId && isSupportEligibleEvidenceRecord(record, graphPathForEvidence(snapshot, record.evidenceId), { requireGraphPath: true }))
        .map((record) => record.evidenceId as string)
    );
    return snapshot.hypotheses.map((hypothesis) => {
      const contextEvidenceIds = new Set(hybridContext.evidenceIds);
      const linkedEvidence = snapshot.evidence.filter((evidence) =>
        evidence.linkedHypothesisIds.includes(hypothesis.id) && contextEvidenceIds.has(evidence.id)
      );
      const supportableEvidence = linkedEvidence.filter((evidence) => supportEligibleEvidenceIds.has(evidence.id));
      const supporting = supportableEvidence
        .filter((evidence) => !evidence.keywords.includes("contradicts") && !evidence.keywords.includes("rejected"))
        .map((evidence) => evidence.id);
      const contradicting = supportableEvidence
        .filter((evidence) => evidence.keywords.includes("contradicts") || evidence.keywords.includes("rejected"))
        .map((evidence) => evidence.id);
      const gaps = linkedEvidence
        .filter((evidence) => evidence.keywords.includes("evidence_gap") || evidence.keywords.includes("tool_unavailable"))
        .map((evidence) => evidence.summary);
      const cited = supportableEvidence.filter((evidence) => evidence.citation || evidence.sourceUri || evidence.sourceId).length;
      return {
        hypothesisId: hypothesis.id,
        supportingEvidenceIds: supporting,
        contradictingEvidenceIds: contradicting,
        evidenceGaps: gaps,
        summary: [
          `Hypothesis: ${hypothesis.statement}`,
          `Support-eligible evidence: ${cited}/${linkedEvidence.length}`,
          `Hybrid citations: ${hybridContext.citations.length}`,
          gaps.length ? `Evidence gaps remain: ${gaps.join("; ")}` : "No explicit evidence_gap record is linked."
        ].join(" ")
      };
    });
  }
}
