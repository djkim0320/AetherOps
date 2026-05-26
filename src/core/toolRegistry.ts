import { createId, nowIso } from "./ids.js";
import { assessSourceQuality, rankResearchUrls, sourceQualityMetadata } from "./sourceQuality.js";
import type {
  AppSettings,
  EvidenceItem,
  OpenCodeRunInput,
  ResearchArtifact,
  ResearchSource,
  ToolRun
} from "./types.js";

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

  async run(input: OpenCodeRunInput): Promise<ResearchToolResult> {
    const startedAt = nowIso();
    const urls = [
      ...(input.evidence ?? []).map((item) => item.sourceUri),
      ...(input.sources ?? []).map((item) => item.url)
    ]
      .filter((url): url is string => typeof url === "string" && /^https?:\/\//i.test(url))
      .slice(0, 3);
    if (!urls.length) {
      throw new Error("WebFetchTool requires at least one external source URL from previous evidence.");
    }
    const pages = await Promise.all(urls.map((url) => fetchPage(url)));
    const completedAt = nowIso();
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
        characterCount: page.text.length,
        ...sourceQualityMetadata(page.url, page.title)
      },
      createdAt: completedAt
    }));
    const artifacts: ResearchArtifact[] = pages.map((page, index) => ({
      id: createId("artifact"),
      projectId: input.project.id,
      category: "web_source",
      title: `Fetched web source ${index + 1}: ${page.title}`,
      relativePath: `artifacts/iteration-${input.iteration}/web-fetch/source-${index + 1}.md`,
      mimeType: "text/markdown",
      summary: page.text.slice(0, 400) || `Fetched ${page.url}`,
      content: [`# ${page.title}`, "", `URL: ${page.url}`, "", page.text].join("\n"),
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
      toolRun: completedToolRun(input, this.name, startedAt, completedAt, { urls }, { urls, fetchedPages: pages.length }),
      evidence,
      artifacts,
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
    const output = {
      evidenceCount: input.evidence?.length ?? 0,
      artifactCount: input.artifacts?.length ?? 0,
      hypothesisCount: input.hypotheses.length
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
  const response = await fetch(url, { headers: { accept: "text/html,text/plain,application/xhtml+xml" } });
  if (!response.ok) {
    throw new Error(`fetch failed for ${url}: ${response.status} ${response.statusText}`);
  }
  const contentType = response.headers.get("content-type") ?? "unknown";
  const raw = await response.text();
  const title = extractTitle(raw) || url;
  const text = normalizePageText(raw);
  if (!text) {
    throw new Error(`fetch produced no readable text for ${url}`);
  }
  return { url: response.url || url, title, text, contentType, status: response.status };
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
