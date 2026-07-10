import { createId, nowIso } from "../shared/ids.js";
import { mergeEvidenceScorecards, scoreFinalResultClaims } from "./evidenceScorecard.js";
import type { EvidenceBasedResult, HybridContext, HypothesisStatus, ResearchSnapshot, ValidationResult } from "../shared/types.js";

export class ResultSynthesizer {
  synthesize(input: {
    snapshot: ResearchSnapshot;
    hybridContext: HybridContext;
    validationResults: ValidationResult[];
    forceStop?: boolean;
  }): EvidenceBasedResult {
    const validationSummary = summarizeValidationResults(input.validationResults);
    const needsMoreEvidence = !input.forceStop && validationSummary.hasEvidenceGaps;
    const needsMoreAnalysis = !input.forceStop && validationSummary.partially_supported > 0;
    const nextQuestions = needsMoreEvidence ? validationSummary.nextQuestions : [];
    const validationSynthesisMismatch =
      validationSummary.supported > 0 && needsMoreEvidence
        ? "At least one validation result is supported, but synthesis still needs more evidence because another hypothesis remains inconclusive/not_tested or has evidence gaps."
        : undefined;
    const answer = `${input.snapshot.project.topic} 연구의 현재 결론은 근거 추적 상태에 따라 제한적으로 판단해야 합니다. 검증 결과 ${input.validationResults.length}건 중 supported=${validationSummary.supported}, partially_supported=${validationSummary.partially_supported}, contradicted=${validationSummary.contradicted}, inconclusive=${validationSummary.inconclusive}, not_tested=${validationSummary.not_tested}입니다. ${
      input.hybridContext.citations.length
        ? `사용 가능한 citation/source는 ${input.hybridContext.citations.length}개입니다.`
        : "추적 가능한 citation/source가 부족합니다."
    }`;

    const result: EvidenceBasedResult = {
      id: createId("result"),
      projectId: input.snapshot.project.id,
      iteration: input.hybridContext.iteration,
      answer,
      hypothesisUpdates: hypothesisUpdates(input.snapshot, validationSummary.firstByHypothesisId, validationSynthesisMismatch),
      quantitativeResults: [
        `Evidence items: ${input.snapshot.evidence.length}`,
        `Normalized records: ${input.snapshot.normalizedRecords.length}`,
        `Vector chunks: ${input.snapshot.chunks.length}`,
        `Ontology entities: ${input.snapshot.ontologyEntities.length}`,
        `Ontology relations: ${input.snapshot.ontologyRelations.length}`,
        `Citations: ${input.hybridContext.citations.length}`
      ],
      qualitativeResults: validationSummary.qualitativeResults(input.hybridContext.vectorSummary, input.hybridContext.graphSummary),
      nextQuestions: uniqueStrings(nextQuestions),
      needsMoreEvidence,
      needsMoreAnalysis,
      validationResultIds: validationSummary.validationResultIds,
      hybridContextId: input.hybridContext.id,
      evidenceScorecard: undefined,
      metadata: validationSynthesisMismatch ? { validationSynthesisMismatch } : {},
      createdAt: nowIso()
    };
    const finalResultScorecard = scoreFinalResultClaims({
      snapshot: input.snapshot,
      hybridContext: input.hybridContext,
      validationResults: input.validationResults,
      result
    });
    return {
      ...result,
      evidenceScorecard: mergeEvidenceScorecards([...input.validationResults.map((validation) => validation.claimScorecard), finalResultScorecard])
    };
  }
}

function hypothesisUpdates(
  snapshot: ResearchSnapshot,
  firstByHypothesisId: Map<string, ValidationResult>,
  validationSynthesisMismatch: string | undefined
): EvidenceBasedResult["hypothesisUpdates"] {
  const updates: EvidenceBasedResult["hypothesisUpdates"] = [];
  for (const hypothesis of snapshot.hypotheses) {
    const validation = firstByHypothesisId.get(hypothesis.id);
    const rationale = validationSynthesisMismatch
      ? `${validation?.reasoningSummary ?? "No validation result was produced for this hypothesis."} Synthesis downgrade note: ${validationSynthesisMismatch}`
      : (validation?.reasoningSummary ?? "No validation result was produced for this hypothesis.");
    updates.push({
      hypothesisId: hypothesis.id,
      status: mapHypothesisStatus(validation?.status),
      confidence: validation?.confidence ?? Math.max(0.2, hypothesis.confidence * 0.8),
      rationale
    });
  }
  return updates;
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

function mapHypothesisStatus(status: ValidationResult["status"] | undefined): HypothesisStatus {
  if (status === "supported") return "supported";
  if (status === "contradicted") return "rejected";
  if (status === "partially_supported" || status === "inconclusive") return "needs_more_evidence";
  return "untested";
}

function summarizeValidationResults(results: ValidationResult[]): {
  supported: number;
  partially_supported: number;
  contradicted: number;
  inconclusive: number;
  not_tested: number;
  hasEvidenceGaps: boolean;
  nextQuestions: string[];
  validationResultIds: string[];
  firstByHypothesisId: Map<string, ValidationResult>;
  qualitativeResults: (vectorSummary: string, graphSummary: string) => string[];
} {
  let supported = 0;
  let partially_supported = 0;
  let contradicted = 0;
  let inconclusive = 0;
  let not_tested = 0;
  let hasEvidenceGaps = false;
  const nextQuestions: string[] = [];
  const validationResultIds: string[] = [];
  const firstByHypothesisId = new Map<string, ValidationResult>();

  for (const result of results) {
    validationResultIds.push(result.id);
    if (result.hypothesisId && !firstByHypothesisId.has(result.hypothesisId)) {
      firstByHypothesisId.set(result.hypothesisId, result);
    }
    if (result.status === "supported") supported += 1;
    else if (result.status === "partially_supported") partially_supported += 1;
    else if (result.status === "contradicted") contradicted += 1;
    else if (result.status === "inconclusive") inconclusive += 1;
    else if (result.status === "not_tested") not_tested += 1;

    if (result.status === "inconclusive" || result.status === "not_tested" || result.evidenceGaps.length > 0) {
      hasEvidenceGaps = true;
    }
    if (nextQuestions.length < 5) {
      for (const gap of result.evidenceGaps) {
        nextQuestions.push(`How can we resolve this evidence gap: ${gap}`);
        if (nextQuestions.length >= 5) break;
      }
    }
  }

  return {
    supported,
    partially_supported,
    contradicted,
    inconclusive,
    not_tested,
    hasEvidenceGaps,
    nextQuestions,
    validationResultIds,
    firstByHypothesisId,
    qualitativeResults(vectorSummary, graphSummary) {
      const values: string[] = [];
      if (vectorSummary) values.push(vectorSummary);
      if (graphSummary) values.push(graphSummary);
      for (const result of results) {
        const limitationCount = Math.min(result.limitations.length, 2);
        for (let index = 0; index < limitationCount; index += 1) {
          const limitation = result.limitations[index];
          if (limitation) values.push(limitation);
          if (values.length >= 12) return values;
        }
      }
      return values;
    }
  };
}
