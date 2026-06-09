import { createId, nowIso } from "../shared/ids.js";
import { assessSourceQuality, sourceQualityMetadata } from "../evidence/sourceQuality.js";
import type { ResearchTool, ResearchToolResult } from "./toolRegistry.js";
import type { AppSettings, EvidenceItem, OpenCodeRunInput, ResearchSource, ToolRun } from "../shared/types.js";

interface OpenAlexResponse {
  results?: OpenAlexWork[];
}

class OpenAlexRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly statusText: string,
    readonly responseText: string
  ) {
    super(message);
    this.name = "OpenAlexRequestError";
  }
}

interface OpenAlexWork {
  id?: string;
  doi?: string;
  display_name?: string;
  publication_year?: number;
  cited_by_count?: number;
  abstract_inverted_index?: Record<string, number[]>;
  authorships?: Array<{ author?: { display_name?: string } }>;
  primary_location?: {
    landing_page_url?: string;
    source?: { display_name?: string };
  };
  open_access?: {
    is_oa?: boolean;
    oa_url?: string;
  };
}

const DEFAULT_OPENALEX_MAILTO = "research@aetherops.local";
const MAX_QUERY_LENGTH = 240;
const MAX_METADATA_QUERIES = 4;

export class ResearchMetadataTool implements ResearchTool {
  name = "ResearchMetadataTool";

  async run(input: OpenCodeRunInput, settings: AppSettings): Promise<ResearchToolResult> {
    const startedAt = nowIso();
    if (!input.project.autonomyPolicy.allowExternalSearch || !settings.allowExternalSearch) {
      throw new Error("ResearchMetadataTool requires external network access, but external search is disabled by project autonomy or app settings.");
    }
    if (!settings.researchMetadata.enabled) {
      throw new Error("ResearchMetadataTool is disabled in app settings.");
    }
    if (settings.researchMetadata.provider !== "openalex") {
      throw new Error(`Unsupported research metadata provider: ${settings.researchMetadata.provider}`);
    }

    const queries = buildMetadataQueries(input);
    const { query, works } = await fetchFirstUsableOpenAlexWorks(queries, settings);
    const completedAt = nowIso();
    const sources: ResearchSource[] = [];
    const evidence: EvidenceItem[] = [];
    const topicKeywords = topicKeywordSlice(input.project.topic);
    const linkedHypothesisIds = input.hypotheses.map((hypothesis) => hypothesis.id);

    for (const work of works) {
      const normalized = normalizeOpenAlexWork(work, input.project.id, completedAt);
      if (!normalized) continue;
      sources.push(normalized.source);
      if (normalized.abstractText) {
        const quality = assessSourceQuality(normalized.source.url, normalized.source.title);
        evidence.push({
          id: createId("evidence"),
          projectId: input.project.id,
          category: "paper_reference",
          title: normalized.source.title,
          summary: normalized.abstractText.slice(0, 800),
          sourceId: normalized.source.id,
          sourceUri: normalized.source.url,
          citation: normalized.citation,
          quote: normalized.abstractText.slice(0, 500),
          doi: normalized.source.doi,
          keywords: ["research_metadata", "openalex", quality.tier, ...topicKeywords],
          linkedHypothesisIds,
          reliabilityScore: quality.reliabilityScore,
          relevanceScore: 0.76,
          evidenceStrength: quality.evidenceStrength,
          limitations: [
            "OpenAlex metadata was imported programmatically; verify paper details against the publisher or DOI landing page.",
            ...quality.limitations
          ],
          metadata: {
            provider: "openalex",
            openAlexId: work.id,
            publicationYear: work.publication_year,
            citedByCount: work.cited_by_count,
            traceabilityKind: "external_source",
            canSupportHypothesis: quality.canSupportHypothesis,
            sourceQualityTier: quality.tier,
            sourceQualityLabel: quality.label
          },
          createdAt: completedAt
        });
      }
    }

    if (!sources.length) {
      return {
        toolRun: failedToolRun(
          input,
          this.name,
          startedAt,
          completedAt,
          { query, queries, provider: "openalex" },
          { resultCount: 0 },
          "OpenAlex returned no usable works for the research query."
        ),
        evidence: [],
        artifacts: [],
        sources: []
      };
    }

    return {
      toolRun: completedToolRun(input, this.name, startedAt, completedAt, { query, queries, provider: "openalex" }, { sourceCount: sources.length, evidenceCount: evidence.length }),
      evidence,
      artifacts: [],
      sources
    };
  }
}

function buildMetadataQueries(input: OpenCodeRunInput): string[] {
  const parts: string[] = [];
  for (const question of input.questions) parts.push(question.text);
  for (const question of input.specification?.researchQuestions ?? []) parts.push(question);
  for (const hypothesis of input.hypotheses) parts.push(hypothesis.statement);
  parts.push(input.researchPlan?.objective ?? "", input.project.topic, input.project.goal);
  const candidates = [
    input.project.topic,
    safeKeywordQuery(parts),
    expandedAcronymQuery(parts),
    ...parts
  ];
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

async function fetchFirstUsableOpenAlexWorks(queries: string[], settings: AppSettings): Promise<{ query: string; works: OpenAlexWork[] }> {
  if (!queries.length) {
    throw new Error("ResearchMetadataTool requires a non-empty project question, hypothesis, or topic to query OpenAlex.");
  }

  let lastQuery = queries[0] ?? "";
  let lastWorks: OpenAlexWork[] = [];
  let lastError: Error | undefined;
  for (const query of queries) {
    let works: OpenAlexWork[];
    try {
      works = await fetchOpenAlexWorks(query, settings);
    } catch (error) {
      if (isRecoverableOpenAlexQueryError(error)) {
        lastError = error instanceof Error ? error : new Error(String(error));
        continue;
      }
      throw error;
    }
    lastQuery = query;
    lastWorks = works;
    if (works.some((work) => cleanString(work.display_name))) return { query, works };
  }
  if (!lastWorks.length && lastError) throw lastError;
  return { query: lastQuery, works: lastWorks };
}

function keywordQuery(parts: string[]): string {
  const joined = parts
    .map((part) => part.trim())
    .filter(Boolean)
    .join(" ");
  const keywords = joined
    .replace(/\bRAG\b/gi, "retrieval augmented generation")
    .split(/[^A-Za-z0-9가-힣]+/)
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

function safeKeywordQuery(parts: string[]): string {
  const joined = parts
    .map((part) => sanitizeOpenAlexQuery(part))
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

function sanitizeOpenAlexQuery(value: string): string {
  return value
    .replace(/[?*]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

async function fetchOpenAlexWorks(query: string, settings: AppSettings): Promise<OpenAlexWork[]> {
  if (!query.trim()) {
    throw new Error("ResearchMetadataTool requires a non-empty project question, hypothesis, or topic to query OpenAlex.");
  }

  const url = new URL("https://api.openalex.org/works");
  url.searchParams.set("search", query);
  url.searchParams.set("per-page", String(settings.researchMetadata.maxResults));
  url.searchParams.set("sort", "relevance_score:desc");
  url.searchParams.set("mailto", settings.researchMetadata.mailto?.trim() || DEFAULT_OPENALEX_MAILTO);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), settings.researchMetadata.timeoutMs);
  try {
    const response = await fetch(url, { headers: { accept: "application/json" }, signal: controller.signal });
    if (!response.ok) {
      const responseText = await response.text().catch(() => "");
      throw new OpenAlexRequestError(
        `OpenAlex metadata request failed: ${response.status} ${response.statusText}${responseText ? ` - ${responseText.slice(0, 300)}` : ""}`,
        response.status,
        response.statusText,
        responseText
      );
    }
    const parsed = (await response.json()) as OpenAlexResponse;
    return Array.isArray(parsed.results) ? parsed.results : [];
  } finally {
    clearTimeout(timeout);
  }
}

function isRecoverableOpenAlexQueryError(error: unknown): boolean {
  if (!(error instanceof OpenAlexRequestError)) return false;
  if (error.status !== 400) return false;
  return /wildcard|Invalid query parameters/i.test(error.responseText);
}

function normalizeOpenAlexWork(
  work: OpenAlexWork,
  projectId: string,
  timestamp: string
): { source: ResearchSource; abstractText?: string; citation: string } | undefined {
  const title = cleanString(work.display_name);
  if (!title) return undefined;
  const abstractText = abstractFromInvertedIndex(work.abstract_inverted_index);
  const authors = authorNames(work);
  const doi = normalizeDoi(work.doi);
  const url = doi ?? cleanString(work.open_access?.oa_url) ?? cleanString(work.primary_location?.landing_page_url) ?? cleanString(work.id);
  const qualityMetadata = sourceQualityMetadata(url, title);
  const source: ResearchSource = {
    id: createId("source"),
    projectId,
    kind: "paper",
    title,
    url,
    doi,
    authors,
    publishedAt: work.publication_year ? String(work.publication_year) : undefined,
    retrievedAt: timestamp,
    metadata: {
      provider: "openalex",
      openAlexId: work.id,
      publicationYear: work.publication_year,
      citedByCount: work.cited_by_count,
      venue: cleanString(work.primary_location?.source?.display_name),
      openAccess: work.open_access?.is_oa,
      rawText: abstractText,
      fetchedAt: timestamp,
      traceabilityKind: "external_source",
      canSupportHypothesis: Boolean(abstractText),
      ...qualityMetadata
    },
    createdAt: timestamp
  };
  return { source, abstractText, citation: citationFor(title, authors, work.publication_year, doi ?? url) };
}

function abstractFromInvertedIndex(index: Record<string, number[]> | undefined): string | undefined {
  if (!index) return undefined;
  const slots: Array<{ token: string; position: number }> = [];
  for (const [token, positions] of Object.entries(index)) {
    for (const position of positions) {
      if (Number.isInteger(position) && position >= 0) slots.push({ token, position });
    }
  }
  if (!slots.length) return undefined;
  slots.sort((left, right) => left.position - right.position);
  return slots.map((slot) => slot.token).join(" ");
}

function authorNames(work: OpenAlexWork): string[] | undefined {
  const authors: string[] = [];
  for (const authorship of work.authorships ?? []) {
    const name = cleanString(authorship.author?.display_name);
    if (name) authors.push(name);
    if (authors.length >= 8) break;
  }
  return authors.length ? authors : undefined;
}

function citationFor(title: string, authors: string[] | undefined, year: number | undefined, url: string | undefined): string {
  const authorPart = authors?.length ? authors.slice(0, 3).join(", ") : "Unknown authors";
  const yearPart = year ? String(year) : "n.d.";
  return `${authorPart} (${yearPart}). ${title}${url ? ` - ${url}` : ""}`;
}

function normalizeDoi(value: string | undefined): string | undefined {
  const cleaned = cleanString(value);
  if (!cleaned) return undefined;
  return cleaned.startsWith("http") ? cleaned : `https://doi.org/${cleaned.replace(/^doi:/i, "")}`;
}

function topicKeywordSlice(topic: string): string[] {
  const output: string[] = [];
  for (const part of topic.split(/[\s,;/|]+/)) {
    const cleaned = part.trim().toLowerCase();
    if (cleaned.length >= 2 && !output.includes(cleaned)) output.push(cleaned);
    if (output.length >= 5) break;
  }
  return output;
}

function cleanString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

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

function completedToolRun(input: OpenCodeRunInput, toolName: string, startedAt: string, completedAt: string, toolInput: unknown, output: unknown): ToolRun {
  return {
    id: createId("tool"),
    projectId: input.project.id,
    iteration: input.iteration,
    toolName,
    input: toolInput,
    output,
    status: "completed",
    startedAt,
    completedAt
  };
}

function failedToolRun(input: OpenCodeRunInput, toolName: string, startedAt: string, completedAt: string, toolInput: unknown, output: unknown, error: string): ToolRun {
  return {
    id: createId("tool"),
    projectId: input.project.id,
    iteration: input.iteration,
    toolName,
    input: toolInput,
    output,
    status: "failed",
    error,
    startedAt,
    completedAt
  };
}
