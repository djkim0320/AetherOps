import { EMPTY_EVIDENCE_GRAPH_PATH, graphPathByEvidenceId, isSupportEligibleEvidenceRecord } from "../evidence/evidenceEligibility.js";
import type { HybridContext, ResearchSnapshot } from "../shared/types.js";

export interface ReasoningSummary {
  hypothesisId?: string;
  claim?: string;
  supportingEvidenceIds: string[];
  contradictingEvidenceIds: string[];
  evidenceGaps: string[];
  summary: string;
}

export class ReasoningEngine {
  reason(snapshot: ResearchSnapshot, hybridContext: HybridContext): ReasoningSummary[] {
    const supportEligibleEvidenceIds = supportEligibleEvidenceIdsFor(snapshot);
    const contextEvidenceIds = new Set(hybridContext.evidenceIds);
    const hypothesisIds = new Set<string>();
    for (const hypothesis of snapshot.hypotheses) hypothesisIds.add(hypothesis.id);
    const contextEvidenceByHypothesisId = new Map<string, ResearchSnapshot["evidence"]>();
    for (const evidence of snapshot.evidence) {
      if (!contextEvidenceIds.has(evidence.id)) continue;
      for (const hypothesisId of new Set(evidence.linkedHypothesisIds)) {
        if (!hypothesisIds.has(hypothesisId)) continue;
        const linkedEvidence = contextEvidenceByHypothesisId.get(hypothesisId);
        if (linkedEvidence) {
          linkedEvidence.push(evidence);
        } else {
          contextEvidenceByHypothesisId.set(hypothesisId, [evidence]);
        }
      }
    }

    const summaries: ReasoningSummary[] = [];
    for (const hypothesis of snapshot.hypotheses) {
      const linkedEvidence = contextEvidenceByHypothesisId.get(hypothesis.id) ?? [];
      const supporting: string[] = [];
      const contradicting: string[] = [];
      const gaps: string[] = [];
      let cited = 0;
      for (const evidence of linkedEvidence) {
        const isContradicting = evidence.keywords.includes("contradicts") || evidence.keywords.includes("rejected");
        if (evidence.keywords.includes("evidence_gap") || evidence.keywords.includes("tool_unavailable")) {
          gaps.push(evidence.summary);
        }
        if (!supportEligibleEvidenceIds.has(evidence.id)) continue;
        if (evidence.citation || evidence.sourceUri || evidence.sourceId) cited += 1;
        if (isContradicting) {
          contradicting.push(evidence.id);
        } else {
          supporting.push(evidence.id);
        }
      }

      summaries.push({
        hypothesisId: hypothesis.id,
        claim: hypothesis.statement,
        supportingEvidenceIds: supporting,
        contradictingEvidenceIds: contradicting,
        evidenceGaps: gaps,
        summary: `Hypothesis: ${hypothesis.statement} Support-eligible evidence: ${cited}/${linkedEvidence.length} Hybrid citations: ${hybridContext.citations.length} ${gaps.length ? `Evidence gaps remain: ${gaps.join("; ")}` : "No explicit evidence_gap record is linked."}`
      });
    }
    return summaries;
  }
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
