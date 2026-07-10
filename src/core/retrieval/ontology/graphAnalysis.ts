import type { EvidenceItem, NormalizedResearchRecord, OntologyEntity, OntologyEntityType, OntologyRelationType } from "../../shared/types.js";

export function entityTypeForRecord(record: NormalizedResearchRecord): OntologyEntityType {
  if (record.kind === "claim") return "Claim";
  if (record.kind === "evidence") return "Evidence";
  if (record.kind === "source") return "Source";
  if (record.kind === "citation") return "Citation";
  if (record.kind === "artifact") return "Artifact";
  if (record.kind === "observation") return "Result";
  return "Result";
}

export function predicateForEvidenceFlags(keywords: ReturnType<typeof keywordFlags>): OntologyRelationType | undefined {
  if (keywords.contradicts || keywords.rejected) return "contradicts";
  if (keywords.evidenceGap || keywords.toolUnavailable) return undefined;
  return "supports";
}

export function predicateForRecordFlags(keywords: ReturnType<typeof keywordFlags>): OntologyRelationType {
  if (keywords.contradicts || keywords.rejected) return "contradicts";
  return "supports";
}

export function evidenceConfidence(evidence: EvidenceItem): number {
  const reliability = evidence.reliabilityScore ?? 0.35;
  const relevance = evidence.relevanceScore ?? 0.45;
  const strength = evidence.evidenceStrength === "strong" ? 0.12 : evidence.evidenceStrength === "medium" ? 0.04 : -0.08;
  const traceability = evidence.citation || evidence.sourceUri || evidence.sourceId ? 0.12 : -0.12;
  return clamp((reliability + relevance) / 2 + strength + traceability);
}

export function isGapKeywordFlags(keywords: ReturnType<typeof keywordFlags>): boolean {
  return keywords.evidenceGap || keywords.toolUnavailable;
}

export function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const output: string[] = [];
  for (const item of value) {
    if (typeof item === "string") output.push(item);
  }
  return output;
}

export function keywordFlags(keywords: string[]): {
  contradicts: boolean;
  rejected: boolean;
  evidenceGap: boolean;
  toolUnavailable: boolean;
} {
  let contradicts = false;
  let rejected = false;
  let evidenceGap = false;
  let toolUnavailable = false;
  for (const keyword of keywords) {
    const normalized = keyword.toLowerCase();
    if (normalized === "contradicts") contradicts = true;
    else if (normalized === "rejected") rejected = true;
    else if (normalized === "evidence_gap") evidenceGap = true;
    else if (normalized === "tool_unavailable") toolUnavailable = true;
    if (contradicts && rejected && evidenceGap && toolUnavailable) break;
  }
  return { contradicts, rejected, evidenceGap, toolUnavailable };
}

export function overlapScore(left: string, right: string): number {
  const leftTokens = new Set(tokens(left));
  const rightTokens = new Set(tokens(right));
  if (!leftTokens.size || !rightTokens.size) return 0;
  let overlap = 0;
  for (const token of leftTokens) {
    if (rightTokens.has(token)) overlap += 1;
  }
  return overlap / leftTokens.size;
}

export function extractParameterMentions(text: string, limit = Number.POSITIVE_INFINITY): Array<{ value: string; unit?: string }> {
  const matches = new Map<string, { value: string; unit?: string }>();
  const slashPattern = /\b\d+\s*\/\s*\d+\b/g;
  for (const match of text.matchAll(slashPattern)) {
    const value = match[0].replace(/\s+/g, "");
    matches.set(value, { value, unit: "ratio" });
    if (matches.size >= limit) return mapValues(matches);
  }
  const unitPattern = /\b\d+(?:\.\d+)?\s*(minutes?|mins?|hours?|hrs?|seconds?|secs?|%|percent|회|분|시간)\b/giu;
  for (const match of text.matchAll(unitPattern)) {
    const value = match[0].replace(/\s+/g, " ").trim();
    const unit = value.replace(/^[\d.]+\s*/, "");
    matches.set(value, { value, unit });
    if (matches.size >= limit) return mapValues(matches);
  }
  return mapValues(matches);
}

export function mapValues<T>(map: Map<string, T>): T[] {
  const values: T[] = [];
  for (const value of map.values()) values.push(value);
  return values;
}

export function normalizeConcept(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^\p{L}\p{N}/ -]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function tokens(text: string): string[] {
  const matches = normalizeConcept(text).match(/\S+/g) ?? [];
  const output: string[] = [];
  for (const token of matches) {
    if (token.length >= 3 && !genericConcepts.has(token)) output.push(token);
  }
  return output;
}

export function joinPresent(separator: string, ...values: unknown[]): string {
  const parts: string[] = [];
  for (const value of values) {
    if (value) parts.push(String(value));
  }
  return parts.join(separator);
}

export function evidenceConceptText(evidence: EvidenceItem): string {
  const parts: string[] = [];
  if (evidence.title) parts.push(evidence.title);
  if (evidence.summary) parts.push(evidence.summary);
  if (evidence.quote) parts.push(evidence.quote);
  for (const keyword of evidence.keywords) {
    if (keyword) parts.push(keyword);
  }
  return parts.join(" ");
}

export function uniqueConceptKeywordsLazy(preferredKeywords: string[], extract: () => string[]): string[] {
  const seen = new Set<string>();
  const output: string[] = [];
  appendConceptKeywords(output, seen, preferredKeywords);
  if (output.length < 6) {
    appendConceptKeywords(output, seen, extract());
  }
  return output;
}

export function appendConceptKeywords(output: string[], seen: Set<string>, values: string[]): void {
  for (const value of values) {
    if (!value || seen.has(value)) continue;
    seen.add(value);
    const keyword = normalizeConcept(value);
    if (keyword.length < 3 || genericConcepts.has(keyword)) continue;
    output.push(keyword);
    if (output.length >= 6) return;
  }
}

export function clamp(value: number): number {
  return Math.max(0.05, Math.min(0.95, Number(value.toFixed(4))));
}

export function mergeEntity(current: OntologyEntity, next: OntologyEntity): OntologyEntity {
  return {
    ...current,
    label: current.label || next.label,
    description: current.description ?? next.description,
    sourceRecordId: current.sourceRecordId ?? next.sourceRecordId,
    sourceEvidenceId: current.sourceEvidenceId ?? next.sourceEvidenceId,
    confidence: Math.max(current.confidence, next.confidence)
  };
}

const genericConcepts = new Set([
  "the",
  "and",
  "for",
  "with",
  "this",
  "that",
  "from",
  "research",
  "study",
  "evidence",
  "source",
  "result",
  "analysis",
  "대한",
  "연구",
  "근거",
  "결과",
  "자료"
]);
