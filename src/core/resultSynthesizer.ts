import { createId, nowIso } from "./ids.js";
import type {
  EvidenceBasedResult,
  HybridContext,
  HypothesisStatus,
  ResearchSnapshot,
  ValidationResult
} from "./types.js";

export class ResultSynthesizer {
  synthesize(input: {
    snapshot: ResearchSnapshot;
    hybridContext: HybridContext;
    validationResults: ValidationResult[];
    forceStop?: boolean;
  }): EvidenceBasedResult {
    const needsMoreEvidence = !input.forceStop && input.validationResults.some((result) =>
      result.status === "inconclusive" || result.status === "not_tested" || result.evidenceGaps.length > 0
    );
    const needsMoreAnalysis = !input.forceStop && input.validationResults.some((result) => result.status === "partially_supported");
    const nextQuestions = needsMoreEvidence
      ? input.validationResults.flatMap((result) => result.evidenceGaps.map((gap) => `How can we resolve this evidence gap: ${gap}`)).slice(0, 5)
      : [];
    const validationSynthesisMismatch = input.validationResults.some((result) => result.status === "supported") && needsMoreEvidence
      ? "At least one validation result is supported, but synthesis still needs more evidence because another hypothesis remains inconclusive/not_tested or has evidence gaps."
      : undefined;

    return {
      id: createId("result"),
      projectId: input.snapshot.project.id,
      iteration: input.hybridContext.iteration,
      answer: [
        `${input.snapshot.project.topic} 연구의 현재 결론은 근거 추적 상태에 따라 제한적으로 판단해야 합니다.`,
        `검증 결과 ${input.validationResults.length}건 중 supported=${count(input.validationResults, "supported")}, partially_supported=${count(input.validationResults, "partially_supported")}, contradicted=${count(input.validationResults, "contradicted")}, inconclusive=${count(input.validationResults, "inconclusive")}, not_tested=${count(input.validationResults, "not_tested")}입니다.`,
        input.hybridContext.citations.length
          ? `사용 가능한 citation/source는 ${input.hybridContext.citations.length}개입니다.`
          : "추적 가능한 citation/source가 부족합니다."
      ].join(" "),
      hypothesisUpdates: input.snapshot.hypotheses.map((hypothesis) => {
        const validation = input.validationResults.find((result) => result.hypothesisId === hypothesis.id);
        return {
          hypothesisId: hypothesis.id,
          status: mapHypothesisStatus(validation?.status),
          confidence: validation?.confidence ?? Math.max(0.2, hypothesis.confidence * 0.8),
          rationale: [
            validation?.reasoningSummary ?? "No validation result was produced for this hypothesis.",
            validationSynthesisMismatch ? `Synthesis downgrade note: ${validationSynthesisMismatch}` : ""
          ].filter(Boolean).join(" ")
        };
      }),
      quantitativeResults: [
        `Evidence items: ${input.snapshot.evidence.length}`,
        `Normalized records: ${input.snapshot.normalizedRecords.length}`,
        `Vector chunks: ${input.snapshot.chunks.length}`,
        `Ontology entities: ${input.snapshot.ontologyEntities.length}`,
        `Ontology relations: ${input.snapshot.ontologyRelations.length}`,
        `Citations: ${input.hybridContext.citations.length}`
      ],
      qualitativeResults: [
        input.hybridContext.vectorSummary,
        input.hybridContext.graphSummary,
        ...input.validationResults.flatMap((result) => result.limitations.slice(0, 2))
      ].filter(Boolean).slice(0, 12),
      nextQuestions: [...new Set(nextQuestions)],
      needsMoreEvidence,
      needsMoreAnalysis,
      validationResultIds: input.validationResults.map((result) => result.id),
      hybridContextId: input.hybridContext.id,
      metadata: validationSynthesisMismatch ? { validationSynthesisMismatch } : {},
      createdAt: nowIso()
    };
  }
}

function mapHypothesisStatus(status: ValidationResult["status"] | undefined): HypothesisStatus {
  if (status === "supported") return "supported";
  if (status === "contradicted") return "rejected";
  if (status === "partially_supported" || status === "inconclusive") return "needs_more_evidence";
  return "untested";
}

function count(results: ValidationResult[], status: ValidationResult["status"]): number {
  return results.filter((result) => result.status === status).length;
}
