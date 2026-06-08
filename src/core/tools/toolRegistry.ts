import { extname } from "node:path";
import { createId, nowIso } from "../shared/ids.js";
import { EngineeringProgramTool } from "./engineeringProgramTool.js";
import { ResearchMetadataTool } from "./researchMetadataTool.js";
import { assessSourceQuality, rankResearchUrls, sourceQualityMetadata } from "../evidence/sourceQuality.js";
import type {
  AppSettings,
  EvidenceItem,
  NormalizedResearchRecord,
  OpenCodeRunInput,
  ResearchArtifact,
  ResearchSource,
  ToolRun,
  ValidationResult
} from "../shared/types.js";

const FETCH_TIMEOUT_MS = 10_000;
const MAX_FETCH_BYTES = 2 * 1024 * 1024;
const MAX_PDF_BYTES = 20 * 1024 * 1024;
const WEB_FETCH_CONCURRENCY = 2;
const ALLOWED_FETCH_CONTENT_TYPES = new Set(["text/html", "text/plain", "application/xhtml+xml"]);
const TEXT_FETCH_EXTENSIONS = new Set([".csv", ".dat", ".json", ".md", ".tab", ".tsv", ".txt"]);
const BLOCKED_HOST_SUFFIXES = [".local", ".localhost", ".internal"];
const HTML_META_CHARSET_PATTERN = /<meta\b[^>]*charset\s*=\s*["']?\s*([a-z0-9._:-]+)/i;
const LATIN1_TEXT_DECODER = new TextDecoder("latin1");
const UTF8_TEXT_ENCODER = new TextEncoder();

export interface ResearchToolResult {
  toolRun: ToolRun;
  evidence: EvidenceItem[];
  artifacts: ResearchArtifact[];
  sources: ResearchSource[];
}

export interface ResearchTool {
  name: string;
  run(input: OpenCodeRunInput, settings: AppSettings): Promise<ResearchToolResult>;
}

export class WebSearchTool implements ResearchTool {
  name = "WebSearchTool";

  async run(input: OpenCodeRunInput, settings: AppSettings): Promise<ResearchToolResult> {
    const startedAt = nowIso();
    const query = buildPublicResearchQuery(input);
    if (!input.project.autonomyPolicy.allowExternalSearch || !settings.allowExternalSearch) {
      throw new Error("External search is disabled by project autonomy or app settings.");
    }
    if (settings.webSearch.provider === "disabled" || !settings.webSearch.apiKey) {
      throw new Error("Web search provider and API key are required.");
    }

    const results = await this.search(settings, query);
    const completedAt = nowIso();
    const sources: ResearchSource[] = [];
    for (const result of results) {
      sources.push({
        id: createId("source"),
        projectId: input.project.id,
        kind: "web",
        title: result.title,
        url: result.url,
        retrievedAt: completedAt,
        metadata: { snippet: result.snippet, provider: settings.webSearch.provider, ...sourceQualityMetadata(result.url, result.title) },
        createdAt: completedAt
      });
    }
    return {
      toolRun: completedToolRun(input, this.name, startedAt, completedAt, { query, provider: settings.webSearch.provider }, { resultCount: results.length }),
      evidence: [],
      artifacts: [],
      sources
    };
  }

  private async search(settings: AppSettings, query: string): Promise<Array<{ title: string; url: string; snippet: string }>> {
    if (settings.webSearch.provider === "custom" && settings.webSearch.endpoint) {
      const response = await fetch(`${settings.webSearch.endpoint}${settings.webSearch.endpoint.includes("?") ? "&" : "?"}q=${encodeURIComponent(query)}`);
      if (!response.ok) throw new Error(`custom search failed: ${response.status} ${response.statusText}`);
      const parsed = (await response.json()) as { results?: Array<{ title?: string; url?: string; snippet?: string }> };
      return normalizeSearchResults(parsed.results);
    }

    if (settings.webSearch.provider === "brave") {
      const response = await fetch(`https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}`, {
        headers: { accept: "application/json", "x-subscription-token": settings.webSearch.apiKey ?? "" }
      });
      if (!response.ok) throw new Error(`brave search failed: ${response.status} ${response.statusText}`);
      const parsed = (await response.json()) as { web?: { results?: Array<{ title?: string; url?: string; description?: string }> } };
      return normalizeSearchResults(parsed.web?.results, "description");
    }

    const response = await fetch("https://api.tavily.com/search", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ api_key: settings.webSearch.apiKey, query, max_results: 5 })
    });
    if (!response.ok) throw new Error(`tavily search failed: ${response.status} ${response.statusText}`);
    const parsed = (await response.json()) as { results?: Array<{ title?: string; url?: string; content?: string }> };
    return normalizeSearchResults(parsed.results, "content");
  }
}

export class WebFetchTool implements ResearchTool {
  name = "WebFetchTool";

  async run(input: OpenCodeRunInput, settings: AppSettings): Promise<ResearchToolResult> {
    const startedAt = nowIso();
    if (!input.project.autonomyPolicy.allowExternalSearch || !settings.allowExternalSearch) {
      throw new Error("WebFetchTool requires external network access, but external search is disabled by project autonomy or app settings.");
    }
    const { urls, skippedUrls, duplicateUrls } = selectFetchTargets(input);
    if (!urls.length) {
      throw new Error("WebFetchTool requires at least one external source URL from ResearchPlan.fetchCandidateUrls, input.sources, citation URLs, or previous ProjectContextSnapshot.");
    }
    const settledPages = await runWithConcurrency(urls, WEB_FETCH_CONCURRENCY, (url) => fetchPage(url));
    const completedAt = nowIso();
    const pages: Awaited<ReturnType<typeof fetchPage>>[] = [];
    const failedUrls: string[] = [];
    const failureReasons: Record<string, string> = {};
    for (let index = 0; index < settledPages.length; index += 1) {
      const result = settledPages[index];
      if (!result) continue;
      if (result.status === "fulfilled") {
        pages.push(result.value);
        continue;
      }
      const url = urls[index] as string;
      failedUrls.push(url);
      failureReasons[url] = result.reason instanceof Error ? result.reason.message : String(result.reason);
    }
    if (!pages.length) {
      return {
        toolRun: failedToolRun(
          input,
          this.name,
          startedAt,
          completedAt,
          { urls, skippedUrls, duplicateUrls },
          { urls, failedUrls, failureReasons, fetchedPages: 0, skippedUrls, duplicateUrls },
          `WebFetchTool failed to fetch all selected URLs: ${failedUrls.join(", ")}`
        ),
        evidence: [],
        artifacts: [],
        sources: []
      };
    }
    const sources: ResearchSource[] = [];
    for (const page of pages) {
      const pdfUrl = arxivPdfUrl(page.url);
      const source: ResearchSource = {
        id: createId("source"),
        projectId: input.project.id,
        kind: "web",
        title: page.title,
        url: page.url,
        retrievedAt: completedAt,
        metadata: {
          contentType: page.contentType,
          status: page.status,
          excerpt: page.text.slice(0, 1_000),
          rawText: page.text,
          fetchedAt: completedAt,
          fetchStatus: "fetched",
          characterCount: page.text.length,
          ...(pdfUrl ? { pdfUrl } : {}),
          ...sourceQualityMetadata(page.url, page.title)
        },
        createdAt: completedAt
      };
      sources.push(source);
      if (pdfUrl) {
        sources.push({
          id: createId("source"),
          projectId: input.project.id,
          kind: "paper",
          title: `${page.title} PDF`,
          url: pdfUrl,
          retrievedAt: completedAt,
          metadata: {
            provider: "arxiv",
            pdfUrl,
            sourceCandidateOnly: true,
            canSupportHypothesis: false,
            traceabilityKind: "external_source",
            ...sourceQualityMetadata(pdfUrl, `${page.title} PDF`)
          },
          createdAt: completedAt
        });
      }
    }
    const evidence: EvidenceItem[] = [];
    const topicKeywords = topicKeywordSlice(input.project.topic);
    const linkedIds = linkedHypothesisIds(input);
    for (let index = 0; index < pages.length; index += 1) {
      const page = pages[index];
      if (!page) continue;
      const quality = assessSourceQuality(page.url, page.title);
      evidence.push({
        id: createId("evidence"),
        projectId: input.project.id,
        category: "web_source",
        title: page.title,
        summary: page.text.slice(0, 800) || `Fetched ${page.url}`,
        sourceId: sources[index]?.id,
        sourceUri: page.url,
        citation: `${page.title} - ${page.url}`,
        quote: page.text.slice(0, 500),
        keywords: withTopicKeywords("web_fetch", quality.tier, topicKeywords),
        linkedHypothesisIds: copyStrings(linkedIds),
        reliabilityScore: quality.reliabilityScore,
        relevanceScore: quality.preferredForSearch ? 0.78 : 0.58,
        evidenceStrength: quality.evidenceStrength,
        limitations: ["Fetched web page text was extracted automatically and should be checked against the original page.", ...quality.limitations],
        createdAt: completedAt
      });
    }
    return {
      toolRun: completedToolRun(input, this.name, startedAt, completedAt, { urls, skippedUrls, duplicateUrls }, { urls, fetchedPages: pages.length, failedUrls, failureReasons, skippedUrls, duplicateUrls }),
      evidence,
      artifacts: [],
      sources
    };
  }
}

export class PaperMetadataTool implements ResearchTool {
  name = "PaperMetadataTool";

  async run(): Promise<ResearchToolResult> {
    throw new Error("PaperMetadataTool requires a configured paper metadata provider; none is configured.");
  }
}

export class CodeExecutionTool implements ResearchTool {
  name = "CodeExecutionTool";

  async run(input: OpenCodeRunInput, settings: AppSettings): Promise<ResearchToolResult> {
    const startedAt = nowIso();
    const completedAt = nowIso();
    const allowed = input.project.autonomyPolicy.allowCodeExecution && settings.allowCodeExecution;
    if (!allowed) {
      throw new Error("Code execution is disabled by project autonomy or app settings.");
    }
    return {
      toolRun: completedToolRun(input, this.name, startedAt, completedAt, { allowCodeExecution: allowed }, { reason: "No explicit script was provided; CodeExecutionTool did not run arbitrary code." }),
      evidence: [],
      artifacts: [],
      sources: []
    };
  }
}

export class ArtifactWriterTool implements ResearchTool {
  name = "ArtifactWriterTool";

  async run(input: OpenCodeRunInput): Promise<ResearchToolResult> {
    const startedAt = nowIso();
    const completedAt = nowIso();
    const lines = [
      `# Iteration ${input.iteration} Research Note`,
      "",
      "## Objective",
      input.project.goal,
      "",
      "## Current Questions"
    ];
    for (const item of input.questions) lines.push(`- ${item.text}`);
    lines.push(
      "",
      "## Hypotheses"
    );
    for (const item of input.hypotheses) lines.push(`- ${item.statement} (${item.status}, confidence=${item.confidence})`);
    lines.push(
      "",
      "## RAG Summary",
      input.ragContext?.summary ?? "No RAG context has been built yet.",
      "",
      "## Traceability",
      "- This note is an internal artifact generated by AetherOps.",
      "- It must not be treated as external evidence for hypothesis support."
    );
    const content = lines.join("\n");
    const artifact: ResearchArtifact = {
      id: createId("artifact"),
      projectId: input.project.id,
      category: "generated_artifact",
      title: `Iteration ${input.iteration} research note`,
      relativePath: `artifacts/iteration-${input.iteration}/research-note.md`,
      mimeType: "text/markdown",
      summary: "Internal iteration note summarizing questions, hypotheses, RAG context, and limitations.",
      content,
      createdAt: completedAt
    };
    return {
      toolRun: completedToolRun(input, this.name, startedAt, completedAt, { relativePath: artifact.relativePath }, { artifactId: artifact.id }),
      evidence: [],
      artifacts: [artifact],
      sources: []
    };
  }
}

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
        toolRun: failedToolRun(input, this.name, startedAt, completedAt, { targets }, { failedUrls: [], failureReasons: { input: "No PDF URL or PDF source candidate was available." } }, "PdfIngestionTool requires a PDF URL or local PDF path with extractable text."),
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

export class DataAnalysisTool implements ResearchTool {
  name = "DataAnalysisTool";

  async run(input: OpenCodeRunInput): Promise<ResearchToolResult> {
    const startedAt = nowIso();
    const completedAt = nowIso();
    const evidence = input.evidence ?? [];
    const normalizedRecords = input.normalizedRecords ?? [];
    const validationResults = input.validationResults ?? [];
    const projectContextSnapshots = input.projectContextSnapshots ?? [];
    const synthesizedResults = input.results ?? [];
    const missingInputWarnings: string[] = [];
    if (normalizedRecords.length === 0) missingInputWarnings.push("normalizedRecords input was not available; support eligibility may be undercounted.");
    if (validationResults.length === 0) missingInputWarnings.push("validationResults input was not available; latest evidence gaps may be incomplete.");
    if (projectContextSnapshots.length === 0) missingInputWarnings.push("projectContextSnapshots input was not available; context coverage analysis may be incomplete.");
    const supportEligibleEvidenceIds = new Set<string>();
    const sourceQualityDistribution: Record<string, number> = {};
    const traceabilityKindDistribution: Record<string, number> = {};
    for (const record of normalizedRecords) {
      const sourceQualityTier = stringMetadataOrDefault(record.metadata.sourceQualityTier, "unknown");
      incrementCount(traceabilityKindDistribution, stringMetadataOrDefault(record.metadata.traceabilityKind, "unknown"));
      if (
        record.kind === "evidence" &&
        record.evidenceId &&
        record.metadata.canSupportHypothesis === true &&
        sourceQualityTier !== "weak" &&
        sourceQualityTier !== "excluded" &&
        sourceQualityTier !== "general_web" &&
        (record.metadata.traceabilityKind === "external_source" || record.metadata.traceabilityKind === "tool_observation")
      ) {
        supportEligibleEvidenceIds.add(record.evidenceId);
      }
    }
    let citedEvidenceCount = 0;
    const linkedEvidenceCoverage = new Map<string, { linkedEvidenceCount: number; supportEligibleEvidenceCount: number }>();
    for (const item of evidence) {
      if (item.citation || item.quote || item.sourceUri) citedEvidenceCount += 1;
      incrementCount(sourceQualityDistribution, sourceQualityKeyword(item.keywords));
      for (const hypothesisId of item.linkedHypothesisIds) {
        const current = linkedEvidenceCoverage.get(hypothesisId) ?? { linkedEvidenceCount: 0, supportEligibleEvidenceCount: 0 };
        current.linkedEvidenceCount += 1;
        if (supportEligibleEvidenceIds.has(item.id)) current.supportEligibleEvidenceCount += 1;
        linkedEvidenceCoverage.set(hypothesisId, current);
      }
    }
    for (const record of normalizedRecords) {
      incrementCount(sourceQualityDistribution, stringMetadataOrDefault(record.metadata.sourceQualityTier, "unknown"));
    }
    let latestIteration = 0;
    for (const result of validationResults) {
      if (result.iteration > latestIteration) latestIteration = result.iteration;
    }
    const validationStatusDistribution: Record<string, number> = {};
    const latestEvidenceGaps = new Set<string>();
    for (const result of validationResults) {
      incrementCount(validationStatusDistribution, result.status);
      if (latestIteration && result.iteration === latestIteration) {
        for (const gap of result.evidenceGaps) latestEvidenceGaps.add(gap);
      }
    }
    const output = {
      evidenceCount: evidence.length,
      supportEligibleEvidenceCount: supportEligibleEvidenceIds.size,
      citationCoverage: evidence.length ? citedEvidenceCount / evidence.length : 0,
      sourceQualityDistribution,
      traceabilityKindDistribution,
      hypothesisEvidenceCoverage: hypothesisEvidenceCoverage(input, linkedEvidenceCoverage),
      validationStatusDistribution,
      iterationGrowthSummary: {
        iteration: input.iteration,
        evidenceCount: evidence.length,
        artifactCount: input.artifacts?.length ?? 0,
        sourceCount: input.sources?.length ?? 0,
        toolRunCount: input.toolRuns?.length ?? 0,
        normalizedRecordCount: normalizedRecords.length,
        validationResultCount: validationResults.length,
        projectContextSnapshotCount: projectContextSnapshots.length,
        synthesizedResultCount: synthesizedResults.length
      },
      inputAvailability: {
        normalizedRecordCount: normalizedRecords.length,
        validationResultCount: validationResults.length,
        projectContextSnapshotCount: projectContextSnapshots.length,
        resultCount: synthesizedResults.length
      },
      missingInputWarnings,
      evidenceGapsFromLatestValidation: setToArray(latestEvidenceGaps)
    };
    return {
      toolRun: completedToolRun(input, this.name, startedAt, completedAt, { iteration: input.iteration }, output),
      evidence: [],
      artifacts: [],
      sources: []
    };
  }
}

export function createDefaultResearchTools(): ResearchTool[] {
  return [
    new WebSearchTool(),
    new WebFetchTool(),
    new ResearchMetadataTool(),
    new EngineeringProgramTool(),
    new PaperMetadataTool(),
    new PdfIngestionTool(),
    new CodeExecutionTool(),
    new ArtifactWriterTool(),
    new DataAnalysisTool()
  ];
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
  const topicKeywords = Array.isArray(thirdOrKeywords) ? thirdOrKeywords : maybeTopicKeywords ?? [];
  if (!Array.isArray(thirdOrKeywords)) output.push(thirdOrKeywords);
  for (const keyword of topicKeywords) output.push(keyword);
  return output;
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

function hypothesisEvidenceCoverage(
  input: OpenCodeRunInput,
  linkedEvidenceCoverage: Map<string, { linkedEvidenceCount: number; supportEligibleEvidenceCount: number }>
): Record<string, { linkedEvidenceCount: number; supportEligibleEvidenceCount: number }> {
  const coverage: Record<string, { linkedEvidenceCount: number; supportEligibleEvidenceCount: number }> = {};
  for (const hypothesis of input.hypotheses) {
    coverage[hypothesis.id] = linkedEvidenceCoverage.get(hypothesis.id) ?? { linkedEvidenceCount: 0, supportEligibleEvidenceCount: 0 };
  }
  return coverage;
}

function setToArray<T>(items: Set<T>): T[] {
  const values: T[] = [];
  for (const item of items) values.push(item);
  return values;
}

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

function selectFetchTargets(input: OpenCodeRunInput): { urls: string[]; skippedUrls: string[]; duplicateUrls: string[] } {
  const alreadyFetched = new Set<string>();
  const sourceCandidates: Array<string | undefined> = [];
  for (const source of input.sources ?? []) {
    if (source.rawPath || source.metadata.fetchStatus === "fetched") {
      const fetchedUrl = normalizeHttpUrl(source.url);
      if (fetchedUrl) alreadyFetched.add(fetchedUrl);
      continue;
    }
    if (source.kind !== "web") continue;
    sourceCandidates.push(
      source.url,
      (source as ResearchSource & { sourceUri?: string }).sourceUri,
      readString(source.metadata.url),
      readString(source.metadata.sourceUri),
      readString(source.metadata.pdfUrl)
    );
  }
  const selected = new Map<string, string>();
  const skippedUrls: string[] = [];
  const duplicateUrls: string[] = [];
  const considerCandidate = (candidate: string | undefined): boolean => {
    const normalized = normalizeHttpUrl(candidate);
    if (!normalized) {
      if (candidate?.trim()) skippedUrls.push(candidate.trim());
      return false;
    }
    if (alreadyFetched.has(normalized) || selected.has(normalized)) {
      duplicateUrls.push(candidate?.trim() ?? normalized);
      return false;
    }
    selected.set(normalized, candidate?.trim() ?? normalized);
    return selected.size >= 3;
  };
  for (const candidate of input.researchPlan?.fetchCandidateUrls ?? []) {
    if (considerCandidate(candidate)) return { urls: [...selected.values()], skippedUrls, duplicateUrls };
  }
  for (const candidate of sourceCandidates) {
    if (considerCandidate(candidate)) return { urls: [...selected.values()], skippedUrls, duplicateUrls };
  }
  for (const item of input.evidence ?? []) {
    if (considerCandidate(item.sourceUri)) return { urls: [...selected.values()], skippedUrls, duplicateUrls };
    for (const citationUrl of extractHttpUrls(item.citation)) {
      if (considerCandidate(citationUrl)) return { urls: [...selected.values()], skippedUrls, duplicateUrls };
    }
  }
  for (const citation of input.projectContextSnapshot?.citations ?? []) {
    for (const citationUrl of extractHttpUrls(citation)) {
      if (considerCandidate(citationUrl)) return { urls: [...selected.values()], skippedUrls, duplicateUrls };
    }
  }
  return { urls: [...selected.values()], skippedUrls, duplicateUrls };
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

function readString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function extractHttpUrls(value: string | undefined): string[] {
  return value?.match(/https?:\/\/[^\s)<>"']+/gi) ?? [];
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

function normalizeSearchResults(
  items: Array<{ title?: string; url?: string; snippet?: string; description?: string; content?: string }> | undefined,
  snippetField: "snippet" | "description" | "content" = "snippet"
): Array<{ title: string; url: string; snippet: string }> {
  const normalized: Array<{ title: string; url: string; snippet: string }> = [];
  const urls: string[] = [];
  for (const item of items ?? []) {
    const url = item.url?.trim() || "";
    if (!url) continue;
    const snippet = item[snippetField];
    normalized.push({
      title: item.title?.trim() || url || "Untitled search result",
      url,
      snippet: snippet?.trim() || ""
    });
    urls.push(url);
  }
  const ranked = rankResearchUrls(urls);
  const rank = new Map<string, number>();
  for (let index = 0; index < ranked.length; index += 1) {
    const url = ranked[index];
    if (url) rank.set(url, index);
  }
  const selected: Array<{ title: string; url: string; snippet: string }> = [];
  for (const item of normalized) {
    if (rank.has(item.url)) selected.push(item);
  }
  selected.sort((a, b) => (rank.get(a.url) ?? 999) - (rank.get(b.url) ?? 999));
  selected.length = Math.min(selected.length, 5);
  return selected;
}

async function runWithConcurrency<T, R>(
  items: T[],
  limit: number,
  task: (item: T, index: number) => Promise<R>
): Promise<Array<PromiseSettledResult<R>>> {
  const results = new Array<PromiseSettledResult<R>>(items.length);
  let nextIndex = 0;
  const workerCount = Math.max(1, Math.min(limit, items.length));
  const workers: Array<Promise<void>> = [];
  for (let workerIndex = 0; workerIndex < workerCount; workerIndex += 1) {
    workers.push((async () => {
      while (nextIndex < items.length) {
        const currentIndex = nextIndex;
        nextIndex += 1;
        try {
          results[currentIndex] = { status: "fulfilled", value: await task(items[currentIndex] as T, currentIndex) };
        } catch (reason) {
          results[currentIndex] = { status: "rejected", reason };
        }
      }
    })());
  }
  await Promise.all(workers);
  return results;
}

function buildPublicResearchQuery(input: OpenCodeRunInput): string {
  const parts: string[] = [];
  let openQuestion: string | undefined;
  for (const question of input.questions) {
    if (question.status === "open") {
      openQuestion = question.text;
      break;
    }
  }
  if (openQuestion) parts.push(openQuestion);
  if (input.project.topic) parts.push(input.project.topic);
  parts.push("Google Scholar Semantic Scholar Crossref arXiv DOI NIST OECD ISO public report academic paper systematic review");
  return parts.join(" ").replace(/\s+/g, " ").trim().slice(0, 280);
}

async function fetchPage(url: string): Promise<{ url: string; title: string; text: string; contentType: string; status: number }> {
  await assertPublicHttpUrl(url);
  const controller = new AbortController();
  const deadline = Date.now() + FETCH_TIMEOUT_MS;
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  let response: Response;
  try {
    try {
      response = await fetch(url, { headers: { accept: "text/html,text/plain,application/xhtml+xml" }, signal: controller.signal });
    } catch (error) {
      if (isAbortOrTimeout(error, deadline)) throw new Error(`fetch timeout for ${url}`);
      throw error;
    }
    await assertPublicHttpUrl(response.url || url);
    if (!response.ok) {
      throw new Error(`fetch failed for ${url}: ${response.status} ${response.statusText}`);
    }
    const contentType = response.headers.get("content-type") ?? "unknown";
    const mediaType = contentType.split(";")[0]?.trim().toLowerCase() ?? "";
    if (!isAllowedTextFetchContentType(mediaType, response.url || url)) {
      throw new Error(`unsupported content-type for ${url}: ${contentType}`);
    }
    const contentLength = Number(response.headers.get("content-length") ?? "0");
    if (Number.isFinite(contentLength) && contentLength > MAX_FETCH_BYTES) {
      throw new Error(`content-length exceeds 2MB for ${url}`);
    }
    const raw = await readLimitedText(response, url, deadline, contentType);
    const title = extractTitle(raw) || url;
    const text = normalizePageText(raw);
    if (!text) {
      throw new Error(`fetch produced no readable text for ${url}`);
    }
    return { url: response.url || url, title, text, contentType, status: response.status };
  } finally {
    clearTimeout(timeout);
  }
}

function isAllowedTextFetchContentType(mediaType: string, url: string): boolean {
  if (ALLOWED_FETCH_CONTENT_TYPES.has(mediaType)) return true;
  if (mediaType && mediaType !== "unknown" && mediaType !== "application/octet-stream") return false;
  return TEXT_FETCH_EXTENSIONS.has(urlPathExtension(url));
}

function urlPathExtension(url: string): string {
  try {
    return extname(new URL(url).pathname).toLowerCase();
  } catch {
    return "";
  }
}

async function fetchPdfText(url: string): Promise<{ url: string; title: string; pages: Array<{ page: number; text: string }> }> {
  await assertPublicHttpUrl(url);
  const controller = new AbortController();
  const deadline = Date.now() + FETCH_TIMEOUT_MS;
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  let response: Response;
  try {
    try {
      response = await fetch(url, { headers: { accept: "application/pdf" }, signal: controller.signal });
    } catch (error) {
      if (isAbortOrTimeout(error, deadline)) throw new Error(`fetch timeout for ${url}`);
      throw error;
    }
    await assertPublicHttpUrl(response.url || url);
    if (!response.ok) throw new Error(`PDF fetch failed for ${url}: ${response.status} ${response.statusText}`);
    const contentType = response.headers.get("content-type") ?? "unknown";
    const mediaType = contentType.split(";")[0]?.trim().toLowerCase() ?? "";
    if (mediaType && mediaType !== "application/pdf" && mediaType !== "application/octet-stream") {
      throw new Error(`unsupported PDF content-type for ${url}: ${contentType}`);
    }
    const contentLength = Number(response.headers.get("content-length") ?? "0");
    if (Number.isFinite(contentLength) && contentLength > MAX_PDF_BYTES) {
      throw new Error(`PDF content-length exceeds 20MB for ${url}`);
    }
    const bytes = await readLimitedBytes(response, url, MAX_PDF_BYTES, deadline, "PDF body read timeout");
    const text = extractPdfTextFromContentStreams(bytes);
    if (!text.trim()) {
      throw new Error(`PDF text extraction produced no readable text for ${url}`);
    }
    return {
      url: response.url || url,
      title: titleFromPdfUrl(response.url || url),
      pages: splitPdfPages(text)
    };
  } finally {
    clearTimeout(timeout);
  }
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
  return normalizePageText(decoded || latin.replace(/[^\x09\x0A\x0D\x20-\x7E가-힣]/g, " "));
}

function decodePdfString(value: string): string {
  return value
    .replace(/\\n/g, " ")
    .replace(/\\r/g, " ")
    .replace(/\\t/g, " ")
    .replace(/\\\(/g, "(")
    .replace(/\\\)/g, ")")
    .replace(/\\\\/g, "\\");
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

function selectRelevantPdfSpan(pages: Array<{ page: number; text: string }>, input: OpenCodeRunInput): { page: number; quote: string; spanStart: number; spanEnd: number } {
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
    const sentences = page.text.match(/[^.!?。！？]{40,500}[.!?。！？]?/g) ?? [page.text.slice(0, 500)];
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

async function assertPublicHttpUrl(value: string): Promise<void> {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`invalid URL: ${value}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`unsupported URL protocol: ${parsed.protocol}`);
  }
  const hostname = parsed.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (!hostname || hostname === "localhost" || hasBlockedHostSuffix(hostname)) {
    throw new Error(`blocked internal hostname: ${parsed.hostname}`);
  }
  if (isPrivateOrInternalIp(hostname)) {
    throw new Error(`blocked internal IP address: ${parsed.hostname}`);
  }
  if (!isIpLiteral(hostname)) {
    const addresses = await resolveHostAddresses(hostname);
    const blocked = firstPrivateOrInternalIp(addresses);
    if (blocked) {
      throw new Error(`DNS resolved ${hostname} to blocked internal IP address: ${blocked}`);
    }
  }
}

function hasBlockedHostSuffix(hostname: string): boolean {
  for (const suffix of BLOCKED_HOST_SUFFIXES) {
    if (hostname.endsWith(suffix)) return true;
  }
  return false;
}

function firstPrivateOrInternalIp(addresses: string[]): string | undefined {
  for (const address of addresses) {
    if (isPrivateOrInternalIp(address)) return address;
  }
  return undefined;
}

async function resolveHostAddresses(hostname: string): Promise<string[]> {
  try {
    const dns = await import("node:dns/promises");
    const records = await dns.lookup(hostname, { all: true, verbatim: true });
    const addresses: string[] = [];
    for (const record of records) addresses.push(record.address);
    return addresses;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`DNS resolution failed for ${hostname}: ${reason}`);
  }
}

function isIpLiteral(hostname: string): boolean {
  return isIpv4(hostname) || hostname.includes(":");
}

function isPrivateOrInternalIp(value: string): boolean {
  const hostname = value.replace(/^\[|\]$/g, "").toLowerCase();
  if (isPrivateOrInternalIpv6(hostname)) return true;
  const ipv4Mapped = hostname.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (ipv4Mapped?.[1]) return isPrivateOrInternalIp(ipv4Mapped[1]);
  const expandedIpv4Mapped = hostname.match(/^0:0:0:0:0:ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (expandedIpv4Mapped?.[1]) return isPrivateOrInternalIp(expandedIpv4Mapped[1]);
  if (!isIpv4(hostname)) return false;
  const parts = hostname.split(".");
  if (parts.length !== 4) return false;
  const first = Number(parts[0]);
  const second = Number(parts[1]);
  return (
    first === 0 ||
    first === 10 ||
    first === 127 ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168) ||
    (first === 169 && second === 254)
  );
}

function isPrivateOrInternalIpv6(hostname: string): boolean {
  if (!hostname.includes(":")) return false;
  if (hostname === "::" || hostname === "::1" || hostname === "0:0:0:0:0:0:0:0" || hostname === "0:0:0:0:0:0:0:1") {
    return true;
  }
  const mapped = hostname.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/) ?? hostname.match(/^0:0:0:0:0:ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped?.[1]) return isPrivateOrInternalIp(mapped[1]);
  const firstHextet = firstNonEmptyHextet(hostname);
  if (!firstHextet || !/^[0-9a-f]{1,4}$/i.test(firstHextet)) return false;
  const first = Number.parseInt(firstHextet, 16);
  return (
    (first & 0xfe00) === 0xfc00 ||
    (first & 0xffc0) === 0xfe80 ||
    (first & 0xff00) === 0xff00
  );
}

function firstNonEmptyHextet(hostname: string): string | undefined {
  let start = 0;
  for (let index = 0; index <= hostname.length; index += 1) {
    if (index < hostname.length && hostname[index] !== ":") continue;
    if (index > start) return hostname.slice(start, index);
    start = index + 1;
  }
  return undefined;
}

function isIpv4(value: string): boolean {
  const parts = value.split(".");
  if (parts.length !== 4) return false;
  for (const part of parts) {
    if (!/^\d+$/.test(part)) return false;
    const value = Number(part);
    if (value < 0 || value > 255) return false;
  }
  return true;
}

async function readLimitedText(response: Response, url: string, deadline: number, contentType: string): Promise<string> {
  if (!response.body) {
    if (typeof response.arrayBuffer === "function") {
      const buffer = await withDeadline(response.arrayBuffer(), deadline, `body read timeout for ${url}`);
      if (buffer.byteLength > MAX_FETCH_BYTES) {
        throw new Error(`body exceeds 2MB for ${url}`);
      }
      return decodeFetchedText(new Uint8Array(buffer), contentType, url);
    }
    const raw = await withDeadline(response.text(), deadline, `body read timeout for ${url}`);
    if (UTF8_TEXT_ENCODER.encode(raw).length > MAX_FETCH_BYTES) {
      throw new Error(`body exceeds 2MB for ${url}`);
    }
    return raw;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  while (true) {
    let readResult: ReadableStreamReadResult<Uint8Array>;
    try {
      readResult = await withDeadline(reader.read(), deadline, `body read timeout for ${url}`);
    } catch (error) {
      await reader.cancel().catch(() => undefined);
      throw error;
    }
    const { done, value } = readResult;
    if (done) break;
    bytes += value.byteLength;
    if (bytes > MAX_FETCH_BYTES) {
      throw new Error(`body exceeds 2MB for ${url}`);
    }
    chunks.push(value);
  }
  const body = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return decodeFetchedText(body, contentType, url);
}

function decodeFetchedText(body: Uint8Array, contentType: string, url: string): string {
  const charset = charsetFromContentType(contentType) ?? charsetFromHtmlMeta(body);
  const decoder = textDecoderForCharset(charset, url);
  let decoded: string;
  try {
    decoded = decoder.decode(body);
  } catch {
    throw new Error(`invalid text encoding for ${url}${charset ? `: ${charset}` : ""}`);
  }
  if (decoded.includes("\uFFFD")) {
    throw new Error(`decoded text contains replacement characters for ${url}${charset ? `: ${charset}` : ""}`);
  }
  return decoded;
}

function textDecoderForCharset(charset: string | undefined, url: string): TextDecoder {
  if (!charset) return new TextDecoder("utf-8", { fatal: true });
  try {
    return new TextDecoder(normalizeCharsetLabel(charset), { fatal: true });
  } catch {
    throw new Error(`unsupported charset for ${url}: ${charset}`);
  }
}

function charsetFromContentType(contentType: string): string | undefined {
  for (const part of contentType.split(";").slice(1)) {
    const [name, value] = part.split("=");
    if (name?.trim().toLowerCase() !== "charset") continue;
    const charset = value?.trim().replace(/^['"]|['"]$/g, "");
    if (charset) return charset.toLowerCase();
  }
  return undefined;
}

function charsetFromHtmlMeta(body: Uint8Array): string | undefined {
  const prefix = LATIN1_TEXT_DECODER.decode(body.slice(0, 4096));
  const charset = prefix.match(HTML_META_CHARSET_PATTERN)?.[1];
  return charset?.toLowerCase();
}

function normalizeCharsetLabel(charset: string): string {
  if (
    charset === "cp949" ||
    charset === "ms949" ||
    charset === "x-windows-949" ||
    charset === "ks_c_5601-1987" ||
    charset === "ks_c_5601" ||
    charset === "ksc5601"
  ) {
    return "windows-949";
  }
  return charset;
}

async function readLimitedBytes(response: Response, url: string, maxBytes: number, deadline: number, timeoutLabel: string): Promise<Uint8Array> {
  if (!response.body) {
    const buffer = await withDeadline(response.arrayBuffer(), deadline, `${timeoutLabel} for ${url}`);
    const bytes = new Uint8Array(buffer);
    if (bytes.byteLength > maxBytes) throw new Error(`PDF body exceeds 20MB for ${url}`);
    return bytes;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    let readResult: ReadableStreamReadResult<Uint8Array>;
    try {
      readResult = await withDeadline(reader.read(), deadline, `${timeoutLabel} for ${url}`);
    } catch (error) {
      await reader.cancel().catch(() => undefined);
      throw error;
    }
    if (readResult.done) break;
    const value = readResult.value;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new Error(`PDF body exceeds 20MB for ${url}`);
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function withDeadline<T>(promise: Promise<T>, deadline: number, message: string): Promise<T> {
  const remaining = deadline - Date.now();
  if (remaining <= 0) return Promise.reject(new Error(message));
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timer = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => reject(new Error(message)), remaining);
  });
  return Promise.race([promise, timer]).finally(() => {
    if (timeout) clearTimeout(timeout);
  });
}

function isAbortOrTimeout(error: unknown, deadline: number): boolean {
  return Date.now() >= deadline || (error instanceof Error && (error.name === "AbortError" || /abort|timeout/i.test(error.message)));
}

function extractTitle(raw: string): string {
  return decodeEntities(raw.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? "").trim();
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
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'");
}

function incrementCount(counts: Record<string, number>, value: string): void {
  counts[value] = (counts[value] ?? 0) + 1;
}

function sourceQualityKeyword(keywords: string[]): string {
  for (const keyword of keywords) {
    if (
      keyword === "scholarly" ||
      keyword === "official" ||
      keyword === "institutional" ||
      keyword === "general_web" ||
      keyword === "weak" ||
      keyword === "excluded"
    ) {
      return keyword;
    }
  }
  return "unknown";
}

function stringMetadataOrDefault(value: unknown, defaultValue: string): string {
  return typeof value === "string" && value.trim() ? value : defaultValue;
}

function tokens(text: string): string[] {
  return text.toLowerCase().replace(/[^\p{L}\p{N}\s-]/gu, " ").match(/\S+/g) ?? [];
}

function topicKeywordSlice(value: string): string[] {
  const parts = value.split(/\s+/);
  const keywords: string[] = [];
  for (const part of parts) {
    keywords.push(part);
    if (keywords.length >= 5) break;
  }
  return keywords;
}
