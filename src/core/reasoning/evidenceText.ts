import type { EvidenceClaimScore, EvidenceClaimStatus, EvidenceItem } from "../shared/types.js";

export function splitPotentialClaims(value: string | undefined): string[] {
  if (!value) return [];
  const withoutMarkdown = value
    .replace(/\r\n?/g, "\n")
    .replace(/^[>#]+\s*/gm, "")
    .replace(/^\s*[-*]\s+/gm, "");
  const lines = withoutMarkdown.split(/\n+|[;]+/g);
  const chunks: string[] = [];
  for (const line of lines) {
    const trimmedLine = line.trim();
    if (/^(citation|citations) preserved\s*:/i.test(trimmedLine)) continue;
    if (/\b(supported|partially_supported|contradicted|inconclusive|not_tested)=\d+/i.test(trimmedLine)) continue;
    const matches = line.match(/[^.!?]+[.!?]+|[^.!?]+$/g);
    if (!matches) continue;
    for (const match of matches) chunks.push(match);
  }
  return chunks;
}

export function normalizeClaimText(value: string): string {
  return value
    .replace(/\[[^\]]+\]\([^)]+\)/g, "")
    .replace(/\s+/g, " ")
    .replace(/^[-*\d.)\s]+/, "")
    .trim();
}

export function isClaimLike(value: string): boolean {
  if (value.length < 12) return false;
  if (value.endsWith("?")) return false;
  if (/^https?:\/\//i.test(value)) return false;
  if (/^[\w.-]+\/[\w./-]+$/i.test(value)) return false;
  if (/^(evidence items|normalized records|vector chunks|ontology entities|ontology relations|citations|entities|relations|claims)\s*:/i.test(value))
    return false;
  if (/^[a-z][a-z\s-]+:\s*\d+(\.\d+)?$/i.test(value)) return false;
  if (/^(citation|citations) preserved\s*:/i.test(value)) return false;
  if (/\b(supported|partially_supported|contradicted|inconclusive|not_tested)=\d+/i.test(value)) return false;
  const letterCount = value.match(/\p{L}/gu)?.length ?? 0;
  if (letterCount < 8) return false;
  if (containsCjk(value)) return true;
  return /\b(is|are|was|were|has|have|had|can|could|will|would|should|must|reduce|reduces|reduced|increase|increases|increased|improve|improves|improved|support|supports|supported|contradict|contradicts|contradicted|show|shows|showed|indicate|indicates|indicated|suggest|suggests|suggested|require|requires|required|need|needs|needed|provide|provides|provided|contain|contains|exists|remain|remains|reported|found|demonstrate|demonstrates|use|uses|achieve|achieves|outperform|outperforms|correlate|correlates|preserve|preserves|preserved)\b/i.test(
    value
  );
}

function containsCjk(value: string): boolean {
  return /[\u3040-\u30ff\u3400-\u9fff\uf900-\ufaff\uac00-\ud7af]/.test(value);
}

export function lexicalOverlapScore(left: string, right: string): number {
  const leftTokens = contentTokens(left);
  if (!leftTokens.length) return 0;
  const rightTokens = new Set(contentTokens(right));
  if (!rightTokens.size) return 0;
  let overlap = 0;
  for (const token of leftTokens) {
    if (rightTokens.has(token)) overlap += 1;
  }
  return overlap / Math.min(leftTokens.length, 12);
}

export function contentTokens(value: string): string[] {
  const rawTokens = value.toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}_-]*/gu) ?? [];
  const tokens: string[] = [];
  for (const token of rawTokens) {
    if (token.length < 3) continue;
    if (STOP_WORDS.has(token)) continue;
    tokens.push(token);
  }
  return uniqueStrings(tokens);
}

export function idsOf(items: EvidenceItem[]): string[] {
  return items.map((item) => item.id);
}

export function intersectInOrder(values: string[], allowed: string[]): string[] {
  const allowedSet = new Set(allowed);
  return uniqueStrings(values.filter((value) => allowedSet.has(value)));
}

export function emptyStatusCounts(): Record<EvidenceClaimStatus, number> {
  return {
    supported: 0,
    missing_evidence: 0,
    contradicted: 0,
    attribution_unfaithful: 0,
    unknown: 0
  };
}

export function cleanText(value: string | undefined): string {
  return value?.trim() ?? "";
}

export function claimKey(claim: EvidenceClaimScore): string {
  return `${claim.hypothesisId ?? "project"}:${normalizeForComparison(claim.claim)}`;
}

export function claimsAreEquivalent(left: string, right: string): boolean {
  const normalizedLeft = normalizeForComparison(left);
  const normalizedRight = normalizeForComparison(right);
  if (!normalizedLeft || !normalizedRight) return false;
  if (normalizedLeft === normalizedRight) return true;
  return lexicalOverlapScore(left, right) >= 0.75 && lexicalOverlapScore(right, left) >= 0.75;
}

export function claimRank(claim: EvidenceClaimScore): number {
  switch (claim.status) {
    case "contradicted":
      return 50;
    case "supported":
      return 40;
    case "attribution_unfaithful":
      return 30;
    case "missing_evidence":
      return 20;
    case "unknown":
      return 10;
    default:
      return 0;
  }
}

export function normalizeForComparison(value: string): string {
  return value.toLowerCase().replace(/\s+/g, " ").trim();
}

export function uniqueStrings(items: string[]): string[] {
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const item of items) {
    if (!item || seen.has(item)) continue;
    seen.add(item);
    unique.push(item);
  }
  return unique;
}

const STOP_WORDS = new Set([
  "the",
  "and",
  "for",
  "with",
  "that",
  "this",
  "from",
  "into",
  "onto",
  "than",
  "then",
  "they",
  "them",
  "their",
  "there",
  "where",
  "when",
  "which",
  "while",
  "about",
  "based",
  "because",
  "between",
  "through",
  "using",
  "used",
  "result",
  "results",
  "evidence",
  "claim",
  "claims",
  "study",
  "source",
  "citation"
]);
