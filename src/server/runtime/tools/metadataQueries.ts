import type { ResearchToolInput } from "../../../core/shared/types.js";

const MAX_QUERY_LENGTH = 240;
const MAX_METADATA_QUERIES = 4;
const metadataStopwords = new Set([
  "about",
  "after",
  "alone",
  "available",
  "before",
  "compared",
  "configured",
  "evidence",
  "evaluate",
  "improves",
  "metadata",
  "project",
  "query",
  "reason",
  "report",
  "research",
  "results",
  "scholarly",
  "source",
  "sources",
  "traceability",
  "whether",
  "with",
  "without"
]);

export function buildMetadataQueries(input: ResearchToolInput, preferredQuery?: string): string[] {
  const parts: string[] = [];
  for (const question of input.questions) parts.push(question.text);
  for (const question of input.specification?.researchQuestions ?? []) parts.push(question);
  for (const hypothesis of input.hypotheses) parts.push(hypothesis.statement);
  parts.push(input.researchPlan?.objective ?? "", input.project.topic, input.project.goal);
  const candidates = [preferredQuery ?? "", input.project.topic, safeKeywordQuery(parts), expandedAcronymQuery(parts), ...parts];
  const queries: string[] = [];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    const query = boundedQuery(candidate);
    const key = query.toLocaleLowerCase();
    if (!query || seen.has(key)) continue;
    seen.add(key);
    queries.push(query);
    if (queries.length >= MAX_METADATA_QUERIES) break;
  }
  return queries;
}

function safeKeywordQuery(parts: string[]): string {
  const joined = parts
    .map(sanitizeOpenAlexQuery)
    .filter(Boolean)
    .join(" ")
    .replace(/\bRAG\b/gi, "retrieval augmented generation");
  const keywords = joined
    .split(/[^\p{L}\p{N}]+/u)
    .map((part) => part.trim().toLowerCase())
    .filter((part) => part.length >= 4 && !metadataStopwords.has(part));
  const output: string[] = [];
  const seen = new Set<string>();
  for (const keyword of keywords) {
    if (seen.has(keyword)) continue;
    seen.add(keyword);
    output.push(keyword);
    if (output.length >= 9) break;
  }
  return output.join(" ");
}

function expandedAcronymQuery(parts: string[]): string {
  const joined = parts.join(" ");
  if (!/\bRAG\b|retrieval/i.test(joined)) return "";
  const terms = ["retrieval augmented generation"];
  if (/citation|cite|scholarly|metadata|traceability|evidence/i.test(joined)) terms.push("citation metadata evidence");
  if (/literature|review/i.test(joined)) terms.push("literature review");
  if (/vector/i.test(joined)) terms.push("vector retrieval");
  return terms.join(" ");
}

function boundedQuery(value: string): string {
  return sanitizeOpenAlexQuery(value).slice(0, MAX_QUERY_LENGTH).trim();
}

export function sanitizeOpenAlexQuery(value: string): string {
  return value.replace(/[?*]+/g, " ").replace(/\s+/g, " ").trim();
}
