import { createId, nowIso } from "../../../core/shared/ids.js";
import { assessSourceQuality, sourceQualityMetadata } from "../../../core/evidence/sourceQuality.js";
import type { AppSettings, EvidenceItem, OpenCodeRunInput, ResearchSource } from "../../../core/shared/types.js";
import type { ResearchTool, ResearchToolResult } from "../../../core/tools/researchToolTypes.js";
import { BoundedHttpClient } from "./boundedHttpClient.js";

const FETCH_TIMEOUT_MS = 10_000;
const MAX_PDF_BYTES = 20 * 1024 * 1024;
const LATIN1_TEXT_DECODER = new TextDecoder("latin1");

export class PdfIngestionTool implements ResearchTool {
  name = "PdfIngestionTool";

  async run(input: OpenCodeRunInput, settings: AppSettings): Promise<ResearchToolResult> {
    const startedAt = nowIso();
    if (!input.project.autonomyPolicy.allowExternalSearch || !settings.allowExternalSearch) {
      throw new Error("PdfIngestionTool requires external network access for PDF URLs, but external search is disabled by project autonomy or app settings.");
    }
    const targets = selectPdfTargets(input);
    const completedAt = nowIso();
    if (!targets.length) {
      return {
        toolRun: failedToolRun(
          input,
          this.name,
          startedAt,
          completedAt,
          { targets },
          { failedUrls: [], failureReasons: { input: "No PDF URL or PDF source candidate was available." } },
          "PdfIngestionTool requires a PDF URL with extractable text."
        ),
        evidence: [],
        artifacts: [],
        sources: []
      };
    }

    const evidence: EvidenceItem[] = [];
    const sources: ResearchSource[] = [];
    const failedUrls: string[] = [];
    const failureReasons: Record<string, string> = {};
    const targetLimit = Math.min(targets.length, 3);
    const topicKeywords = topicKeywordSlice(input.project.topic);
    const linkedIds = linkedHypothesisIds(input);
    for (let targetIndex = 0; targetIndex < targetLimit; targetIndex += 1) {
      const target = targets[targetIndex];
      if (!target) continue;
      try {
        const pdf = await fetchPdfText(target);
        const span = selectRelevantPdfSpan(pdf.pages, input);
        if (!span.quote) {
          failureReasons[target] = "PDF text was fetched but no relevant quote/span could be extracted.";
          failedUrls.push(target);
          continue;
        }
        const quality = assessSourceQuality(target, pdf.title);
        const source: ResearchSource = {
          id: createId("source"),
          projectId: input.project.id,
          kind: "paper",
          title: pdf.title,
          url: target,
          retrievedAt: completedAt,
          metadata: {
            pdfUrl: target,
            pageCount: pdf.pages.length,
            excerpt: span.quote.slice(0, 1_000),
            rawText: joinedPdfText(pdf.pages),
            fetchedAt: completedAt,
            fetchStatus: "fetched",
            contentType: "application/pdf",
            characterCount: pdfCharacterCount(pdf.pages),
            ...sourceQualityMetadata(target, pdf.title)
          },
          createdAt: completedAt
        };
        sources.push(source);
        evidence.push({
          id: createId("evidence"),
          projectId: input.project.id,
          category: "paper_reference",
          title: `${pdf.title} page ${span.page}`,
          summary: span.quote,
          sourceId: source.id,
          sourceUri: target,
          citation: `${pdf.title}, p. ${span.page} - ${target}`,
          quote: span.quote,
          keywords: withTopicKeywords("pdf", "span", quality.tier, topicKeywords),
          linkedHypothesisIds: copyStrings(linkedIds),
          reliabilityScore: quality.reliabilityScore,
          relevanceScore: 0.78,
          evidenceStrength: quality.evidenceStrength,
          limitations: ["PDF text was extracted automatically; verify page/span against the source PDF.", ...quality.limitations],
          metadata: {
            page: span.page,
            spanStart: span.spanStart,
            spanEnd: span.spanEnd,
            extractionMethod: "pdf_text_span",
            pdfUrl: target
          },
          createdAt: completedAt
        });
      } catch (error) {
        failedUrls.push(target);
        failureReasons[target] = error instanceof Error ? error.message : String(error);
      }
    }
    const status = evidence.length ? "completed" : "failed";
    return {
      toolRun: {
        id: createId("tool"),
        projectId: input.project.id,
        iteration: input.iteration,
        toolName: this.name,
        input: { targets },
        output: { fetchedPdfs: evidence.length, failedUrls, failureReasons },
        status,
        error: status === "failed" ? "PdfIngestionTool failed to extract any page/span-backed evidence." : undefined,
        startedAt,
        completedAt
      },
      evidence,
      artifacts: [],
      sources
    };
  }
}

async function fetchPdfText(url: string): Promise<{ url: string; title: string; pages: Array<{ page: number; text: string }> }> {
  const client = new BoundedHttpClient({ timeoutMs: FETCH_TIMEOUT_MS, maxBytes: MAX_PDF_BYTES });
  const response = await client.request(url, undefined, { accept: "application/pdf", maxBytes: MAX_PDF_BYTES });
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`PDF fetch failed for ${url}: ${response.status} ${response.statusText}`);
  }
  const mediaType = response.contentType.split(";")[0]?.trim().toLowerCase() ?? "";
  if (mediaType && mediaType !== "application/pdf" && mediaType !== "application/octet-stream") {
    throw new Error(`unsupported PDF content-type for ${url}: ${response.contentType}`);
  }
  const text = extractPdfTextFromContentStreams(response.bytes);
  if (!text.trim()) {
    throw new Error(`PDF text extraction produced no readable text for ${url}`);
  }
  return {
    url: response.url,
    title: titleFromPdfUrl(response.url),
    pages: splitPdfPages(text)
  };
}

function selectPdfTargets(input: OpenCodeRunInput): string[] {
  const urls = new Map<string, string>();
  const considerCandidate = (candidate: string | undefined) => {
    const pdf = normalizeHttpUrl(arxivPdfUrl(candidate) ?? candidate);
    if (pdf && (/\.pdf($|[?#])/i.test(pdf) || /arxiv\.org\/pdf\//i.test(pdf))) urls.set(pdf, pdf);
  };
  for (const candidate of input.researchPlan?.fetchCandidateUrls ?? []) {
    considerCandidate(candidate);
  }
  for (const source of input.sources ?? []) {
    considerCandidate(source.url);
    considerCandidate(readString(source.metadata.pdfUrl));
  }
  for (const item of input.evidence ?? []) {
    considerCandidate(item.sourceUri);
    for (const citationUrl of extractHttpUrls(item.citation)) {
      considerCandidate(citationUrl);
    }
  }
  for (const citation of input.projectContextSnapshot?.citations ?? []) {
    considerCandidate(citation);
  }
  return [...urls.values()];
}

function extractPdfTextFromContentStreams(bytes: Uint8Array): string {
  const latin = LATIN1_TEXT_DECODER.decode(bytes);
  const decodedParts: string[] = [];
  for (const match of latin.matchAll(/\(([^()]{12,})\)\s*Tj/g)) {
    decodedParts.push(decodePdfString(match[1] ?? ""));
  }
  for (const match of latin.matchAll(/\[((?:.|\n){20,}?)\]\s*TJ/g)) {
    const encodedParts = match[1] ?? "";
    for (const part of encodedParts.matchAll(/\(([^()]{4,})\)/g)) {
      decodedParts.push(decodePdfString(part[1] ?? ""));
    }
  }
  const decoded = decodedParts.join(" ");
  return normalizePageText(decoded || printableAsciiOnly(latin));
}

function printableAsciiOnly(value: string): string {
  return Array.from(value, (character) => {
    const code = character.charCodeAt(0);
    return code === 9 || code === 10 || code === 13 || (code >= 32 && code <= 126) ? character : " ";
  }).join("");
}

function decodePdfString(value: string): string {
  return value.replace(/\\n/g, " ").replace(/\\r/g, " ").replace(/\\t/g, " ").replace(/\\\(/g, "(").replace(/\\\)/g, ")").replace(/\\\\/g, "\\");
}

function splitPdfPages(text: string): Array<{ page: number; text: string }> {
  const rawPages = text.split(/\f|\bPage\s+\d+\b/gi);
  const pages: Array<{ page: number; text: string }> = [];
  for (const rawPage of rawPages) {
    const pageText = rawPage.trim();
    if (!pageText) continue;
    pages.push({ page: pages.length + 1, text: pageText });
    if (pages.length >= 80) return pages;
  }
  if (!pages.length) pages.push({ page: 1, text });
  return pages;
}

function selectRelevantPdfSpan(
  pages: Array<{ page: number; text: string }>,
  input: OpenCodeRunInput
): { page: number; quote: string; spanStart: number; spanEnd: number } {
  const queryParts: string[] = [];
  if (input.researchPlan?.objective) queryParts.push(input.researchPlan.objective);
  for (const question of input.researchPlan?.targetQuestions ?? []) {
    if (question) queryParts.push(question);
  }
  for (const hypothesis of input.researchPlan?.targetHypotheses ?? []) {
    if (hypothesis) queryParts.push(hypothesis);
  }
  if (input.project.topic) queryParts.push(input.project.topic);
  const query = queryParts.join(" ");
  const queryTokens = new Set(tokens(query));
  let best = { page: pages[0]?.page ?? 1, quote: "", spanStart: 0, spanEnd: 0, score: -1 };
  for (const page of pages) {
    const sentences = page.text.match(/[^.!?]{40,500}[.!?]/g) ?? [page.text.slice(0, 500)];
    let offset = 0;
    for (const sentence of sentences) {
      const start = page.text.indexOf(sentence, offset);
      offset = start + sentence.length;
      let score = 0;
      for (const token of tokens(sentence)) {
        if (queryTokens.has(token)) score += 1;
      }
      if (score > best.score && sentence.trim().length >= 40) {
        best = { page: page.page, quote: sentence.trim().slice(0, 900), spanStart: Math.max(0, start), spanEnd: Math.max(0, start) + sentence.length, score };
      }
    }
  }
  return best;
}

function titleFromPdfUrl(url: string): string {
  try {
    const parsed = new URL(url);
    let file = "";
    for (const part of parsed.pathname.split("/")) {
      if (part) file = part;
    }
    if (!file) file = parsed.hostname;
    return decodeURIComponent(file.replace(/\.pdf$/i, "")) || url;
  } catch {
    return url;
  }
}

function normalizeHttpUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const parsed = new URL(value.trim());
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return undefined;
    parsed.hash = "";
    parsed.protocol = parsed.protocol.toLowerCase();
    parsed.hostname = parsed.hostname.toLowerCase();
    if ((parsed.protocol === "https:" && parsed.port === "443") || (parsed.protocol === "http:" && parsed.port === "80")) {
      parsed.port = "";
    }
    return parsed.toString();
  } catch {
    return undefined;
  }
}

function arxivPdfUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const parsed = new URL(value);
    if (parsed.hostname.replace(/^www\./, "").toLowerCase() !== "arxiv.org") return undefined;
    const match = parsed.pathname.match(/^\/abs\/([^/?#]+)/i);
    return match?.[1] ? `https://arxiv.org/pdf/${match[1]}` : undefined;
  } catch {
    return undefined;
  }
}

function extractHttpUrls(value: string | undefined): string[] {
  return value?.match(/https?:\/\/[^\s)<>"']+/gi) ?? [];
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function linkedHypothesisIds(input: OpenCodeRunInput): string[] {
  const ids: string[] = [];
  for (const hypothesis of input.hypotheses) ids.push(hypothesis.id);
  return ids;
}

function copyStrings(values: string[]): string[] {
  const output: string[] = [];
  for (const value of values) output.push(value);
  return output;
}

function withTopicKeywords(first: string, second: string, topicKeywords: string[]): string[];
function withTopicKeywords(first: string, second: string, third: string, topicKeywords: string[]): string[];
function withTopicKeywords(first: string, second: string, thirdOrKeywords: string | string[], maybeTopicKeywords?: string[]): string[] {
  const output = [first, second];
  const topicKeywords = Array.isArray(thirdOrKeywords) ? thirdOrKeywords : (maybeTopicKeywords ?? []);
  if (!Array.isArray(thirdOrKeywords)) output.push(thirdOrKeywords);
  for (const keyword of topicKeywords) output.push(keyword);
  return output;
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

function tokens(text: string): string[] {
  return (
    text
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s-]/gu, " ")
      .match(/\S+/g) ?? []
  );
}

function joinedPdfText(pages: Array<{ page: number; text: string }>): string {
  const text: string[] = [];
  for (const page of pages) text.push(page.text);
  return text.join("\n\n");
}

function pdfCharacterCount(pages: Array<{ page: number; text: string }>): number {
  let count = 0;
  for (const page of pages) count += page.text.length;
  return count;
}

function normalizePageText(raw: string): string {
  return decodeEntities(
    raw
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim()
  ).slice(0, 20_000);
}

function decodeEntities(value: string): string {
  return value
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function failedToolRun(input: OpenCodeRunInput, toolName: string, startedAt: string, completedAt: string, toolInput: unknown, output: unknown, error: string) {
  return {
    id: createId("tool"),
    projectId: input.project.id,
    iteration: input.iteration,
    toolName,
    input: toolInput,
    output,
    status: "failed" as const,
    error,
    startedAt,
    completedAt
  };
}
