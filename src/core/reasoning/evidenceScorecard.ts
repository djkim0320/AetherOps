import { createStableId } from "../shared/ids.js";
import { EMPTY_EVIDENCE_GRAPH_PATH, graphPathByEvidenceId, isSupportEligibleEvidenceRecord } from "../evidence/evidenceEligibility.js";
import {
  claimKey,
  claimRank,
  claimsAreEquivalent,
  cleanText,
  emptyStatusCounts,
  idsOf,
  intersectInOrder,
  isClaimLike,
  lexicalOverlapScore,
  normalizeClaimText,
  normalizeForComparison,
  splitPotentialClaims,
  uniqueStrings
} from "./evidenceText.js";
import type {
  EvidenceBasedResult,
  EvidenceClaimScore,
  EvidenceClaimStatus,
  EvidenceItem,
  EvidenceScorecard,
  HybridContext,
  ResearchSnapshot,
  ValidationResult
} from "../shared/types.js";
import type { ReasoningSummary } from "./reasoningEngine.js";

export interface BuildEvidenceClaimScoreInput {
  snapshot: ResearchSnapshot;
  reasoning: ReasoningSummary;
  contextEvidence: EvidenceItem[];
  candidateEvidence?: EvidenceItem[];
  supportEligibleEvidenceIds: Set<string>;
  supportingEvidenceIds: string[];
  contradictingEvidenceIds: string[];
  confidence: number;
  evidenceGaps: string[];
}

export function buildEvidenceClaimScore(input: BuildEvidenceClaimScoreInput): EvidenceClaimScore {
  const claim = claimText(input.reasoning);
  const candidateEvidence = input.candidateEvidence ?? candidateEvidenceForReasoning(input.reasoning, input.contextEvidence);
  const candidateEvidenceIds = idsOf(candidateEvidence);
  const citedEvidenceIds = idsOf(candidateEvidence.filter(hasCitationTrace));
  const supportingEvidenceIds = intersectInOrder(input.supportingEvidenceIds, candidateEvidenceIds);
  const contradictingEvidenceIds = intersectInOrder(input.contradictingEvidenceIds, candidateEvidenceIds);
  const faithfulEvidenceIds = uniqueStrings([...supportingEvidenceIds, ...contradictingEvidenceIds].filter((id) => citedEvidenceIds.includes(id)));
  const unfaithfulEvidenceIds = unfaithfulCitationIds(candidateEvidence, input.supportEligibleEvidenceIds, contradictingEvidenceIds);
  const failedToolRuns = input.snapshot.toolRuns.filter((run) => run.status === "failed");
  const status = claimStatus({
    supportingEvidenceIds,
    contradictingEvidenceIds,
    candidateEvidenceIds,
    citedEvidenceIds,
    faithfulEvidenceIds,
    unfaithfulEvidenceIds,
    failedToolRunCount: failedToolRuns.length
  });
  const evidenceGaps = claimEvidenceGaps(status, input.evidenceGaps, failedToolRuns);

  return {
    id: createStableId("claim_score", `${input.snapshot.project.id}:${input.reasoning.hypothesisId ?? "project"}:${claim}`),
    claim,
    hypothesisId: input.reasoning.hypothesisId,
    status,
    correctness: {
      status: correctnessStatus(status),
      confidence: input.confidence,
      supportingEvidenceIds,
      contradictingEvidenceIds,
      rationale: correctnessRationale(status, supportingEvidenceIds, contradictingEvidenceIds)
    },
    citationFaithfulness: {
      status: citationFaithfulnessStatus(status, citedEvidenceIds, faithfulEvidenceIds, unfaithfulEvidenceIds),
      citedEvidenceIds,
      faithfulEvidenceIds,
      unfaithfulEvidenceIds,
      rationale: citationFaithfulnessRationale(status, citedEvidenceIds, faithfulEvidenceIds, unfaithfulEvidenceIds)
    },
    evidenceGaps
  };
}

export function evidenceScorecardFromClaims(claims: EvidenceClaimScore[]): EvidenceScorecard {
  const statusCounts = emptyStatusCounts();
  for (const claim of claims) statusCounts[claim.status] += 1;
  return {
    claimCount: claims.length,
    statusCounts,
    claims
  };
}

export function mergeEvidenceScorecards(scorecards: Array<EvidenceScorecard | undefined>): EvidenceScorecard | undefined {
  const byClaimKey = new Map<string, EvidenceClaimScore>();
  for (const scorecard of scorecards) {
    if (!scorecard) continue;
    for (const claim of scorecard.claims) {
      const key = claimKey(claim);
      const existing = byClaimKey.get(key);
      if (!existing || claimRank(claim) > claimRank(existing)) {
        byClaimKey.set(key, claim);
      }
    }
  }
  const claims = [...byClaimKey.values()];
  return claims.length ? evidenceScorecardFromClaims(claims) : undefined;
}

export function scoreFinalResultClaims(input: {
  snapshot: ResearchSnapshot;
  hybridContext: HybridContext;
  validationResults: ValidationResult[];
  result: Pick<EvidenceBasedResult, "answer" | "hypothesisUpdates" | "quantitativeResults" | "qualitativeResults">;
}): EvidenceScorecard | undefined {
  const claims = extractAtomicClaimsFromResult(input.result);
  if (!claims.length) return undefined;

  const supportEligibleEvidenceIds = supportEligibleEvidenceIdsFor(input.snapshot);
  const contextEvidence = orderedContextEvidence(input.snapshot, input.hybridContext);
  const scores: EvidenceClaimScore[] = [];

  for (const claim of claims) {
    const hypothesisId = inferHypothesisId(claim, input.snapshot);
    const matchedValidationEvidence = matchingValidationEvidenceIds(claim, input.validationResults);
    const candidateEvidence = candidateEvidenceForClaim(claim, contextEvidence, matchedValidationEvidence.all);
    const supportingEvidenceIds: string[] = [];
    const contradictingEvidenceIds: string[] = [];

    for (const evidence of candidateEvidence) {
      if (matchedValidationEvidence.contradicting.has(evidence.id) || isContradictingEvidence(evidence)) {
        if (supportEligibleEvidenceIds.has(evidence.id)) contradictingEvidenceIds.push(evidence.id);
        continue;
      }
      if (supportEligibleEvidenceIds.has(evidence.id) || matchedValidationEvidence.supporting.has(evidence.id)) {
        supportingEvidenceIds.push(evidence.id);
      }
    }

    scores.push(
      buildEvidenceClaimScore({
        snapshot: input.snapshot,
        reasoning: {
          hypothesisId,
          claim,
          supportingEvidenceIds,
          contradictingEvidenceIds,
          evidenceGaps: [],
          summary: claim
        },
        contextEvidence,
        candidateEvidence,
        supportEligibleEvidenceIds,
        supportingEvidenceIds,
        contradictingEvidenceIds,
        confidence: confidenceForClaimEvidence(candidateEvidence, supportingEvidenceIds, contradictingEvidenceIds),
        evidenceGaps: candidateEvidence.length ? [] : [`No context evidence matched final result claim: ${claim}`]
      })
    );
  }

  return scores.length ? evidenceScorecardFromClaims(scores) : undefined;
}

export function extractAtomicClaimsFromResult(
  result: Pick<EvidenceBasedResult, "answer" | "hypothesisUpdates" | "quantitativeResults" | "qualitativeResults">,
  options: { limit?: number } = {}
): string[] {
  const raw: string[] = [];
  raw.push(...splitPotentialClaims(result.answer));
  for (const item of result.quantitativeResults) raw.push(...splitPotentialClaims(item));
  for (const item of result.qualitativeResults) raw.push(...splitPotentialClaims(item));

  const limit = options.limit ?? 16;
  const claims: string[] = [];
  const seen = new Set<string>();
  for (const value of raw) {
    const claim = normalizeClaimText(value);
    if (!isClaimLike(claim)) continue;
    const key = normalizeForComparison(claim);
    if (seen.has(key)) continue;
    seen.add(key);
    claims.push(claim);
    if (claims.length >= limit) break;
  }
  return claims;
}

function claimText(reasoning: ReasoningSummary): string {
  return cleanText(reasoning.claim) || cleanText(reasoning.summary) || "Unspecified claim";
}

function candidateEvidenceForReasoning(reasoning: ReasoningSummary, contextEvidence: EvidenceItem[]): EvidenceItem[] {
  if (!reasoning.hypothesisId) return contextEvidence;
  return contextEvidence.filter((evidence) => evidence.linkedHypothesisIds.includes(reasoning.hypothesisId as string));
}

function candidateEvidenceForClaim(claim: string, contextEvidence: EvidenceItem[], matchedValidationEvidenceIds: Set<string>): EvidenceItem[] {
  const candidates: Array<{ evidence: EvidenceItem; score: number; index: number }> = [];
  for (let index = 0; index < contextEvidence.length; index += 1) {
    const evidence = contextEvidence[index];
    if (!evidence) continue;
    const directTrace = claimMentionsEvidenceTrace(claim, evidence);
    const overlap = lexicalOverlapScore(claim, evidenceSearchText(evidence));
    const validationMatched = matchedValidationEvidenceIds.has(evidence.id);
    if (!directTrace && !validationMatched && overlap < 0.35) continue;
    candidates.push({
      evidence,
      score: directTrace ? 1 : Math.max(overlap, validationMatched ? 0.9 : 0),
      index
    });
  }
  candidates.sort((left, right) => right.score - left.score || left.index - right.index);
  return candidates.map((candidate) => candidate.evidence);
}

function orderedContextEvidence(snapshot: ResearchSnapshot, hybridContext: HybridContext): EvidenceItem[] {
  const contextIds = new Set(hybridContext.evidenceIds);
  const ordered: EvidenceItem[] = [];
  for (const evidence of snapshot.evidence) {
    if (contextIds.has(evidence.id)) ordered.push(evidence);
  }
  return ordered;
}

function matchingValidationEvidenceIds(claim: string, results: ValidationResult[]): { supporting: Set<string>; contradicting: Set<string>; all: Set<string> } {
  const supporting = new Set<string>();
  const contradicting = new Set<string>();
  for (const result of results) {
    const scorecardClaims = result.claimScorecard?.claims ?? [];
    const matchesClaimScore = scorecardClaims.some((score) => claimsAreEquivalent(claim, score.claim));
    const matchesReasoningSummary = !scorecardClaims.length && lexicalOverlapScore(claim, result.reasoningSummary) >= 0.7;
    if (!matchesClaimScore && !matchesReasoningSummary) continue;
    for (const id of result.supportingEvidenceIds) supporting.add(id);
    for (const id of result.contradictingEvidenceIds) contradicting.add(id);
    for (const score of scorecardClaims) {
      if (!claimsAreEquivalent(claim, score.claim)) continue;
      for (const id of score.correctness.supportingEvidenceIds) supporting.add(id);
      for (const id of score.correctness.contradictingEvidenceIds) contradicting.add(id);
    }
  }
  return { supporting, contradicting, all: new Set([...supporting, ...contradicting]) };
}

function inferHypothesisId(claim: string, snapshot: ResearchSnapshot): string | undefined {
  let best: { hypothesisId: string; score: number } | undefined;
  for (const hypothesis of snapshot.hypotheses) {
    const score = lexicalOverlapScore(claim, hypothesis.statement);
    if (score < 0.55) continue;
    if (!best || score > best.score) best = { hypothesisId: hypothesis.id, score };
  }
  return best?.hypothesisId;
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

function unfaithfulCitationIds(candidateEvidence: EvidenceItem[], supportEligibleEvidenceIds: Set<string>, contradictingEvidenceIds: string[]): string[] {
  const contradicting = new Set(contradictingEvidenceIds);
  const ids: string[] = [];
  for (const evidence of candidateEvidence) {
    if (!hasCitationTrace(evidence)) continue;
    if (supportEligibleEvidenceIds.has(evidence.id)) continue;
    if (contradicting.has(evidence.id)) continue;
    ids.push(evidence.id);
  }
  return uniqueStrings(ids);
}

function claimStatus(input: {
  supportingEvidenceIds: string[];
  contradictingEvidenceIds: string[];
  candidateEvidenceIds: string[];
  citedEvidenceIds: string[];
  faithfulEvidenceIds: string[];
  unfaithfulEvidenceIds: string[];
  failedToolRunCount: number;
}): EvidenceClaimStatus {
  if (input.contradictingEvidenceIds.length > 0) return "contradicted";
  if (input.unfaithfulEvidenceIds.length > 0) return "attribution_unfaithful";
  if (input.supportingEvidenceIds.length > 0 && input.faithfulEvidenceIds.length > 0) return "supported";
  if (input.candidateEvidenceIds.length === 0 && input.failedToolRunCount > 0) return "unknown";
  if (input.candidateEvidenceIds.length === 0 || input.citedEvidenceIds.length === 0) return "missing_evidence";
  return "unknown";
}

function correctnessStatus(status: EvidenceClaimStatus): EvidenceClaimScore["correctness"]["status"] {
  if (status === "supported") return "supported";
  if (status === "contradicted") return "contradicted";
  if (status === "missing_evidence" || status === "attribution_unfaithful") return "insufficient";
  return "unknown";
}

function citationFaithfulnessStatus(
  status: EvidenceClaimStatus,
  citedEvidenceIds: string[],
  faithfulEvidenceIds: string[],
  unfaithfulEvidenceIds: string[]
): EvidenceClaimScore["citationFaithfulness"]["status"] {
  if (status === "attribution_unfaithful" || unfaithfulEvidenceIds.length > 0) return "unfaithful";
  if (faithfulEvidenceIds.length > 0) return "faithful";
  if (citedEvidenceIds.length === 0) return "missing";
  return "unknown";
}

function claimEvidenceGaps(status: EvidenceClaimStatus, existingGaps: string[], failedToolRuns: ResearchSnapshot["toolRuns"]): string[] {
  const gaps = [...existingGaps];
  if (status === "missing_evidence") gaps.push("No citation-faithful support evidence was found for this claim.");
  if (status === "attribution_unfaithful") gaps.push("At least one cited evidence item was not eligible to support the claim.");
  if (status === "unknown" && failedToolRuns.length > 0) {
    gaps.push(`Tool failure prevented claim assessment: ${failedToolRuns.map((run) => `${run.toolName}${run.error ? `: ${run.error}` : ""}`).join("; ")}`);
  }
  return uniqueStrings(gaps);
}

function correctnessRationale(status: EvidenceClaimStatus, supportingEvidenceIds: string[], contradictingEvidenceIds: string[]): string {
  if (status === "supported") return `Claim has citation-faithful support evidence: ${supportingEvidenceIds.join(", ")}.`;
  if (status === "contradicted") return `Claim has contradiction evidence: ${contradictingEvidenceIds.join(", ")}.`;
  if (status === "attribution_unfaithful") return "Claim cannot be treated as supported because cited evidence was not support-eligible.";
  if (status === "missing_evidence") return "Claim has no citation-faithful support evidence.";
  return "Claim could not be assessed from the available evidence.";
}

function citationFaithfulnessRationale(
  status: EvidenceClaimStatus,
  citedEvidenceIds: string[],
  faithfulEvidenceIds: string[],
  unfaithfulEvidenceIds: string[]
): string {
  if (status === "attribution_unfaithful") return `Unfaithful cited evidence: ${unfaithfulEvidenceIds.join(", ")}.`;
  if (faithfulEvidenceIds.length > 0) return `Faithful cited evidence: ${faithfulEvidenceIds.join(", ")}.`;
  if (!citedEvidenceIds.length) return "No citation/source trace is available for this claim.";
  return `Citations exist but support faithfulness is unresolved: ${citedEvidenceIds.join(", ")}.`;
}

function hasCitationTrace(evidence: EvidenceItem): boolean {
  return Boolean(evidence.citation || evidence.sourceUri || evidence.sourceId || evidence.doi);
}

function claimMentionsEvidenceTrace(claim: string, evidence: EvidenceItem): boolean {
  const normalizedClaim = normalizeForComparison(claim);
  const traceValues = [evidence.id, evidence.citation, evidence.sourceUri, evidence.sourceId, evidence.doi];
  for (const value of traceValues) {
    const trace = normalizeForComparison(value ?? "");
    if (trace && normalizedClaim.includes(trace)) return true;
  }
  return false;
}

function isContradictingEvidence(evidence: EvidenceItem): boolean {
  const text = normalizeForComparison([evidence.title, evidence.summary, evidence.quote, evidence.keywords.join(" ")].join(" "));
  return /\b(contradict|contradicts|contradicted|refute|refutes|rejected|opposes|does not support|fails to support)\b/.test(text);
}

function confidenceForClaimEvidence(candidateEvidence: EvidenceItem[], supportingEvidenceIds: string[], contradictingEvidenceIds: string[]): number {
  const assessedIds = new Set([...supportingEvidenceIds, ...contradictingEvidenceIds]);
  const assessed = candidateEvidence.filter((evidence) => assessedIds.has(evidence.id));
  if (!assessed.length) return candidateEvidence.length ? 0.25 : 0.15;
  let total = 0;
  for (const evidence of assessed) {
    total += ((evidence.reliabilityScore ?? 0.35) + (evidence.relevanceScore ?? 0.45)) / 2;
  }
  return Math.max(0.05, Math.min(0.95, total / assessed.length));
}

function evidenceSearchText(evidence: EvidenceItem): string {
  return [
    evidence.title,
    evidence.summary,
    evidence.quote,
    evidence.citation,
    evidence.sourceUri,
    evidence.sourceId,
    evidence.doi,
    evidence.keywords.join(" "),
    evidence.limitations?.join(" ")
  ]
    .filter(Boolean)
    .join(" ");
}
