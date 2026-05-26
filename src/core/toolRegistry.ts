import { createId, nowIso } from "./ids.js";
import { assessSourceQuality, rankResearchUrls, sourceQualityMetadata } from "./sourceQuality.js";
import type {
  AppSettings,
  EvidenceItem,
  NormalizedResearchRecord,
  OpenCodeRunInput,
  ResearchArtifact,
  ResearchSource,
  ToolRun,
  ValidationResult
} from "./types.js";

const FETCH_TIMEOUT_MS = 10_000;
const MAX_FETCH_BYTES = 2 * 1024 * 1024;
const ALLOWED_FETCH_CONTENT_TYPES = new Set(["text/html", "text/plain", "application/xhtml+xml"]);
const BLOCKED_HOST_SUFFIXES = [".local", ".localhost", ".internal"];

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
    const sources = results.map((result) => ({
      id: createId("source"),
      projectId: input.project.id,
      kind: "web" as const,
      title: result.title,
      url: result.url,
      retrievedAt: completedAt,
      metadata: { snippet: result.snippet, provider: settings.webSearch.provider, ...sourceQualityMetadata(result.url, result.title) },
      createdAt: completedAt
    }));
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
      return normalizeSearchResults(parsed.web?.results?.map((item) => ({ ...item, snippet: item.description })));
    }

    const response = await fetch("https://api.tavily.com/search", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ api_key: settings.webSearch.apiKey, query, max_results: 5 })
    });
    if (!response.ok) throw new Error(`tavily search failed: ${response.status} ${response.statusText}`);
    const parsed = (await response.json()) as { results?: Array<{ title?: string; url?: string; content?: string }> };
    return normalizeSearchResults(parsed.results?.map((item) => ({ ...item, snippet: item.content })));
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
      throw new Error("WebFetchTool requires at least one external source URL from previous evidence.");
    }
    const settledPages: Array<PromiseSettledResult<{ url: string; title: string; text: string; contentType: string; status: number }>> = [];
    for (const url of urls) {
      settledPages.push(await Promise.resolve(fetchPage(url)).then(
        (value) => ({ status: "fulfilled", value }),
        (reason) => ({ status: "rejected", reason })
      ));
    }
    const completedAt = nowIso();
    const pages = settledPages.flatMap((result) => (result.status === "fulfilled" ? [result.value] : []));
    const failedUrls = settledPages.flatMap((result, index) => (result.status === "rejected" ? [urls[index] as string] : []));
    const failureReasons = Object.fromEntries(
      settledPages.flatMap((result, index) =>
        result.status === "rejected" ? [[urls[index] as string, result.reason instanceof Error ? result.reason.message : String(result.reason)]] : []
      )
    );
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
    const sources: ResearchSource[] = pages.map((page) => ({
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
        ...sourceQualityMetadata(page.url, page.title)
      },
      createdAt: completedAt
    }));
    const evidence: EvidenceItem[] = pages.map((page, index) => {
      const quality = assessSourceQuality(page.url, page.title);
      return {
        id: createId("evidence"),
        projectId: input.project.id,
        category: "web_source",
        title: page.title,
        summary: page.text.slice(0, 800) || `Fetched ${page.url}`,
        sourceId: sources[index]?.id,
        sourceUri: page.url,
        citation: `${page.title} - ${page.url}`,
        quote: page.text.slice(0, 500),
        keywords: ["web_fetch", quality.tier, ...input.project.topic.split(/\s+/).slice(0, 5)],
        linkedHypothesisIds: input.hypotheses.map((hypothesis) => hypothesis.id),
        reliabilityScore: quality.reliabilityScore,
        relevanceScore: quality.preferredForSearch ? 0.78 : 0.58,
        evidenceStrength: quality.evidenceStrength,
        limitations: ["Fetched web page text was extracted automatically and should be checked against the original page.", ...quality.limitations],
        createdAt: completedAt
      };
    });
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
    const content = [
      `# Iteration ${input.iteration} Research Note`,
      "",
      "## Objective",
      input.project.goal,
      "",
      "## Current Questions",
      ...input.questions.map((item) => `- ${item.text}`),
      "",
      "## Hypotheses",
      ...input.hypotheses.map((item) => `- ${item.statement} (${item.status}, confidence=${item.confidence})`),
      "",
      "## RAG Summary",
      input.ragContext?.summary ?? "No RAG context has been built yet.",
      "",
      "## Traceability",
      "- This note is an internal artifact generated by AetherOps.",
      "- It must not be treated as external evidence for hypothesis support."
    ].join("\n");
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

  async run(): Promise<ResearchToolResult> {
    throw new Error("PdfIngestionTool requires explicit PDF file paths; none were provided.");
  }
}

export class DataAnalysisTool implements ResearchTool {
  name = "DataAnalysisTool";

  async run(input: OpenCodeRunInput): Promise<ResearchToolResult> {
    const startedAt = nowIso();
    const completedAt = nowIso();
    const analysisInput = input as OpenCodeRunInput & {
      normalizedRecords?: NormalizedResearchRecord[];
      validationResults?: ValidationResult[];
    };
    const evidence = input.evidence ?? [];
    const normalizedRecords = analysisInput.normalizedRecords ?? [];
    const validationResults = analysisInput.validationResults ?? [];
    const supportEligibleEvidenceIds = new Set(
      normalizedRecords
        .filter((record) =>
          record.kind === "evidence" &&
          record.evidenceId &&
          record.metadata.canSupportHypothesis === true &&
          record.metadata.sourceQualityTier !== "weak" &&
          record.metadata.sourceQualityTier !== "excluded" &&
          record.metadata.sourceQualityTier !== "general_web" &&
          (record.metadata.traceabilityKind === "external_source" || record.metadata.traceabilityKind === "tool_observation")
        )
        .map((record) => record.evidenceId as string)
    );
    const citedEvidenceCount = evidence.filter((item) => Boolean(item.citation || item.quote || item.sourceUri)).length;
    const latestIteration = validationResults.reduce((max, result) => Math.max(max, result.iteration), 0);
    const latestValidation = latestIteration ? validationResults.filter((result) => result.iteration === latestIteration) : [];
    const output = {
      evidenceCount: evidence.length,
      supportEligibleEvidenceCount: supportEligibleEvidenceIds.size,
      citationCoverage: evidence.length ? citedEvidenceCount / evidence.length : 0,
      sourceQualityDistribution: countBy([
        ...evidence.map((item) => item.keywords.find((keyword) => ["scholarly", "official", "institutional", "general_web", "weak", "excluded"].includes(keyword)) ?? "unknown"),
        ...normalizedRecords.map((record) => stringMetadata(record.metadata.sourceQualityTier, "unknown"))
      ]),
      traceabilityKindDistribution: countBy(normalizedRecords.map((record) => stringMetadata(record.metadata.traceabilityKind, "unknown"))),
      hypothesisEvidenceCoverage: Object.fromEntries(
        input.hypotheses.map((hypothesis) => [
          hypothesis.id,
          {
            linkedEvidenceCount: evidence.filter((item) => item.linkedHypothesisIds.includes(hypothesis.id)).length,
            supportEligibleEvidenceCount: evidence.filter((item) => item.linkedHypothesisIds.includes(hypothesis.id) && supportEligibleEvidenceIds.has(item.id)).length
          }
        ])
      ),
      validationStatusDistribution: countBy(validationResults.map((result) => result.status)),
      iterationGrowthSummary: {
        iteration: input.iteration,
        evidenceCount: evidence.length,
        artifactCount: input.artifacts?.length ?? 0,
        sourceCount: input.sources?.length ?? 0,
        toolRunCount: input.toolRuns?.length ?? 0,
        normalizedRecordCount: normalizedRecords.length,
        validationResultCount: validationResults.length
      },
      evidenceGapsFromLatestValidation: [...new Set(latestValidation.flatMap((result) => result.evidenceGaps))]
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
    new PaperMetadataTool(),
    new PdfIngestionTool(),
    new CodeExecutionTool(),
    new ArtifactWriterTool(),
    new DataAnalysisTool()
  ];
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
  const alreadyFetched = new Set(
    (input.sources ?? [])
      .filter((source) => source.rawPath || source.metadata.fetchStatus === "fetched")
      .map((source) => normalizeHttpUrl(source.url))
      .filter((url): url is string => Boolean(url))
  );
  const candidates = [
    ...(input.sources ?? [])
      .filter((source) => source.kind === "web" && !source.rawPath && source.metadata.fetchStatus !== "fetched")
      .map((source) => source.url),
    ...(input.evidence ?? []).map((item) => item.sourceUri)
  ];
  const selected = new Map<string, string>();
  const skippedUrls: string[] = [];
  const duplicateUrls: string[] = [];
  for (const candidate of candidates) {
    const normalized = normalizeHttpUrl(candidate);
    if (!normalized) {
      if (candidate?.trim()) skippedUrls.push(candidate.trim());
      continue;
    }
    if (alreadyFetched.has(normalized) || selected.has(normalized)) {
      duplicateUrls.push(candidate?.trim() ?? normalized);
      continue;
    }
    selected.set(normalized, candidate?.trim() ?? normalized);
    if (selected.size >= 3) break;
  }
  return { urls: [...selected.values()], skippedUrls, duplicateUrls };
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

function normalizeSearchResults(items: Array<{ title?: string; url?: string; snippet?: string }> | undefined): Array<{ title: string; url: string; snippet: string }> {
  const normalized = (items ?? [])
    .map((item) => ({
      title: item.title?.trim() || item.url?.trim() || "Untitled search result",
      url: item.url?.trim() || "",
      snippet: item.snippet?.trim() || ""
    }))
    .filter((item) => item.url);
  const ranked = rankResearchUrls(normalized.map((item) => item.url));
  const rank = new Map(ranked.map((url, index) => [url, index]));
  return normalized
    .filter((item) => rank.has(item.url))
    .sort((a, b) => (rank.get(a.url) ?? 999) - (rank.get(b.url) ?? 999))
    .slice(0, 5);
}

function buildPublicResearchQuery(input: OpenCodeRunInput): string {
  return [
    input.questions.find((question) => question.status === "open")?.text,
    input.project.topic,
    "Google Scholar Semantic Scholar Crossref arXiv DOI NIST OECD ISO public report academic paper systematic review"
  ]
    .filter(Boolean)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 280);
}

async function fetchPage(url: string): Promise<{ url: string; title: string; text: string; contentType: string; status: number }> {
  await assertPublicHttpUrl(url);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetch(url, { headers: { accept: "text/html,text/plain,application/xhtml+xml" }, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
  await assertPublicHttpUrl(response.url || url);
  if (!response.ok) {
    throw new Error(`fetch failed for ${url}: ${response.status} ${response.statusText}`);
  }
  const contentType = response.headers.get("content-type") ?? "unknown";
  const mediaType = contentType.split(";")[0]?.trim().toLowerCase() ?? "";
  if (!ALLOWED_FETCH_CONTENT_TYPES.has(mediaType)) {
    throw new Error(`unsupported content-type for ${url}: ${contentType}`);
  }
  const contentLength = Number(response.headers.get("content-length") ?? "0");
  if (Number.isFinite(contentLength) && contentLength > MAX_FETCH_BYTES) {
    throw new Error(`content-length exceeds 2MB for ${url}`);
  }
  const raw = await readLimitedText(response, url);
  const title = extractTitle(raw) || url;
  const text = normalizePageText(raw);
  if (!text) {
    throw new Error(`fetch produced no readable text for ${url}`);
  }
  return { url: response.url || url, title, text, contentType, status: response.status };
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
  if (!hostname || hostname === "localhost" || BLOCKED_HOST_SUFFIXES.some((suffix) => hostname.endsWith(suffix))) {
    throw new Error(`blocked internal hostname: ${parsed.hostname}`);
  }
  if (isPrivateOrInternalIp(hostname)) {
    throw new Error(`blocked internal IP address: ${parsed.hostname}`);
  }
  if (!isIpLiteral(hostname)) {
    const addresses = await resolveHostAddresses(hostname);
    const blocked = addresses.find((address) => isPrivateOrInternalIp(address));
    if (blocked) {
      throw new Error(`DNS resolved ${hostname} to blocked internal IP address: ${blocked}`);
    }
  }
}

async function resolveHostAddresses(hostname: string): Promise<string[]> {
  try {
    const dns = await import("node:dns/promises");
    const records = await dns.lookup(hostname, { all: true, verbatim: true });
    return records.map((record) => record.address);
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
  if (hostname === "::1" || hostname === "0:0:0:0:0:0:0:1") return true;
  const ipv4Mapped = hostname.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (ipv4Mapped?.[1]) return isPrivateOrInternalIp(ipv4Mapped[1]);
  if (!isIpv4(hostname)) return false;
  const octets = hostname.split(".").map((part) => Number(part));
  const [first, second, third, fourth] = octets;
  if (first === undefined || second === undefined || third === undefined || fourth === undefined) return false;
  return (
    first === 0 ||
    first === 10 ||
    first === 127 ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168) ||
    (first === 169 && second === 254)
  );
}

function isIpv4(value: string): boolean {
  const parts = value.split(".");
  return parts.length === 4 && parts.every((part) => /^\d+$/.test(part) && Number(part) >= 0 && Number(part) <= 255);
}

async function readLimitedText(response: Response, url: string): Promise<string> {
  if (!response.body) {
    const raw = await response.text();
    if (new TextEncoder().encode(raw).length > MAX_FETCH_BYTES) {
      throw new Error(`body exceeds 2MB for ${url}`);
    }
    return raw;
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const chunks: string[] = [];
  let bytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > MAX_FETCH_BYTES) {
      throw new Error(`body exceeds 2MB for ${url}`);
    }
    chunks.push(decoder.decode(value, { stream: true }));
  }
  chunks.push(decoder.decode());
  return chunks.join("");
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

function countBy(values: string[]): Record<string, number> {
  return values.reduce<Record<string, number>>((counts, value) => {
    counts[value] = (counts[value] ?? 0) + 1;
    return counts;
  }, {});
}

function stringMetadata(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value : fallback;
}
