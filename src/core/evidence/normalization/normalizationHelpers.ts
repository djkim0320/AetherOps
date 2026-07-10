import { extractKeywords } from "../../retrieval/chunking.js";
import { createStableId, nowIso } from "../../shared/ids.js";
import type { EvidenceItem, NormalizedRecordKind, NormalizedResearchRecord, ResearchSource, TraceabilityKind } from "../../shared/types.js";

export function metadata(
  traceabilityKind: TraceabilityKind,
  canSupportHypothesis: boolean,
  text: string,
  extra: Record<string, unknown>
): Record<string, unknown> {
  const keywords = extractKeywords(text);
  return {
    ...extra,
    traceabilityKind,
    canSupportHypothesis,
    keywords,
    inferredKeywords: keywords.slice(0, 12),
    domainTags: keywords.slice(0, 8)
  };
}

export function joinPresent(separator: string, ...values: unknown[]): string {
  const parts: string[] = [];
  for (const value of values) {
    if (value) parts.push(String(value));
  }
  return parts.join(separator);
}

export function validationStatusFor(
  traceabilityKind: TraceabilityKind,
  canSupportHypothesis: boolean,
  kind: NormalizedRecordKind
): "raw" | "normalized" | "rejected" {
  if (traceabilityKind === "error") return "rejected";
  if (traceabilityKind === "external_source" && (canSupportHypothesis || kind === "source" || kind === "citation")) return "normalized";
  return "raw";
}

export function sourceTraceability(source: ResearchSource): TraceabilityKind {
  if (source.kind === "web" || source.kind === "paper") {
    return source.url || source.doi || source.rawPath ? "external_source" : "project_provenance";
  }
  if (source.kind === "file") {
    return source.rawPath && !isInternalUri(source.rawPath) ? "external_source" : "project_provenance";
  }
  if (source.kind === "log") return "tool_observation";
  if (source.kind === "artifact") return "internal_artifact";
  return "project_provenance";
}

export function evidenceTraceability(
  evidence: EvidenceItem,
  source?: ResearchSource,
  keywordFlags = evidenceKeywordFlags(evidence.keywords)
): TraceabilityKind {
  if (keywordFlags.traceabilityError) {
    return "error";
  }
  if (evidence.category === "generated_artifact") {
    return "internal_artifact";
  }
  if (evidence.category === "experiment_log") {
    return "tool_observation";
  }
  if (
    evidence.doi ||
    isExternalUri(evidence.sourceUri) ||
    isExternalCitation(evidence.citation) ||
    sourceTraceability(source ?? emptySource()) === "external_source"
  ) {
    return "external_source";
  }
  return "project_provenance";
}

export function confidenceFromEvidence(evidence: EvidenceItem, canSupportHypothesis: boolean): number {
  const reliability = evidence.reliabilityScore ?? 0.35;
  const relevance = evidence.relevanceScore ?? 0.5;
  const traceability = canSupportHypothesis ? 0.15 : -0.15;
  const strength = evidence.evidenceStrength === "strong" ? 0.15 : evidence.evidenceStrength === "medium" ? 0.05 : -0.05;
  return Math.max(0.05, Math.min(0.95, (reliability + relevance) / 2 + traceability + strength));
}

export function isExternalUri(value: string | undefined): boolean {
  return Boolean(value && /^https?:\/\//i.test(value));
}

export function isExternalCitation(value: string | undefined): boolean {
  return Boolean(value && (/https?:\/\//i.test(value) || /\bdoi\b/i.test(value) || /10\.\d{4,9}\//.test(value)));
}

export function isInternalUri(value: string): boolean {
  const normalized = value.includes("\\") ? value.replace(/\\/g, "/") : value;
  return /^(project:\/\/|artifacts\/|logs\/|reports\/|knowledge\/|ontology\/|exports\/)/i.test(normalized);
}

export function evidenceKeywordFlags(keywords: string[]): { traceabilityError: boolean; recordError: boolean } {
  let traceabilityError = false;
  let recordError = false;
  for (const keyword of keywords) {
    if (keyword.includes("error") || keyword.includes("failed")) {
      traceabilityError = true;
      recordError = true;
    } else if (keyword.includes("tool_unavailable")) {
      recordError = true;
    }
    if (traceabilityError && recordError) break;
  }
  return { traceabilityError, recordError };
}

export function hasNonInternalTrace(evidence: EvidenceItem): boolean {
  const trace = evidence.sourceUri ?? evidence.citation ?? evidence.doi;
  return Boolean(trace && (isExternalUri(trace) || evidence.doi || !isInternalUri(trace)));
}

export function emptySource(): ResearchSource {
  return {
    id: "",
    projectId: "",
    kind: "conversation",
    title: "",
    retrievedAt: nowIso(),
    metadata: {}
  };
}

export function dedupe(records: NormalizedResearchRecord[]): NormalizedResearchRecord[] {
  const map = new Map<string, NormalizedResearchRecord>();
  for (const record of records) {
    const key = `${record.kind}:${record.sourceId ?? ""}:${record.artifactId ?? ""}:${record.evidenceId ?? ""}:${record.title}:${record.content.slice(0, 120)}`;
    const stableId = createStableId("record", key);
    map.set(stableId, { ...record, id: stableId });
  }
  return [...map.values()];
}
