import { createId, nowIso } from "../../../core/shared/ids.js";
import { rankResearchUrls, sourceQualityMetadata } from "../../../core/evidence/sourceQuality.js";
import type { ResearchTool, ResearchToolExecutionContext, ResearchToolResult } from "../../../core/tools/researchToolTypes.js";
import type { AppSettings, ResearchToolInput, ResearchSource } from "../../../core/shared/types.js";
import { BoundedHttpClient } from "./boundedHttpClient.js";
import { JobSourceAccessPolicy } from "./jobSourceAccessPolicy.js";

const FETCH_TIMEOUT_MS = 10_000;
const MAX_SEARCH_RESULTS = 5;

export class WebSearchTool implements ResearchTool {
  name = "WebSearchTool";

  async run(input: ResearchToolInput, settings: AppSettings, context?: ResearchToolExecutionContext): Promise<ResearchToolResult> {
    const startedAt = nowIso();
    const query = buildPublicResearchQuery(input);
    if (!input.project.autonomyPolicy.allowExternalSearch || !settings.allowExternalSearch) {
      throw new Error("External search is disabled by project autonomy or app settings.");
    }
    if (settings.webSearch.provider === "disabled" || !settings.webSearch.apiKey) {
      throw new Error("Web search provider and API key are required.");
    }

    const results = await this.search(settings, query, input.executionContext?.toolPolicy.sourceAccess, context);
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

  private async search(
    settings: AppSettings,
    query: string,
    sourceAccess: NonNullable<ResearchToolInput["executionContext"]>["toolPolicy"]["sourceAccess"] | undefined,
    context?: ResearchToolExecutionContext
  ): Promise<Array<{ title: string; url: string; snippet: string }>> {
    const timeoutMs = searchTimeoutMs(settings.webSearch.timeoutMs);
    const client = new BoundedHttpClient({
      timeoutMs,
      ...(sourceAccess ? { publicUrlPolicy: new JobSourceAccessPolicy(sourceAccess) } : {}),
      ...(sourceAccess && context?.onNetworkAudit ? { onNetworkAudit: (audit) => context.onNetworkAudit?.({ ...audit, sourcePolicy: sourceAccess }) } : {})
    });

    if (settings.webSearch.provider === "custom" && settings.webSearch.endpoint) {
      const parsed = await fetchSearchJson<{ results?: Array<{ title?: string; url?: string; snippet?: string }> }>(
        client,
        "custom search",
        `${settings.webSearch.endpoint}${settings.webSearch.endpoint.includes("?") ? "&" : "?"}q=${encodeURIComponent(query)}`,
        undefined,
        timeoutMs
      );
      return normalizeSearchResults(parsed.results);
    }

    if (settings.webSearch.provider === "brave") {
      const parsed = await fetchSearchJson<{ web?: { results?: Array<{ title?: string; url?: string; description?: string }> } }>(
        client,
        "brave search",
        `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}`,
        { headers: { accept: "application/json", "x-subscription-token": settings.webSearch.apiKey ?? "" } },
        timeoutMs
      );
      return normalizeSearchResults(parsed.web?.results, "description");
    }

    const parsed = await fetchSearchJson<{ results?: Array<{ title?: string; url?: string; content?: string }> }>(
      client,
      "tavily search",
      "https://api.tavily.com/search",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ api_key: settings.webSearch.apiKey, query, max_results: MAX_SEARCH_RESULTS })
      },
      timeoutMs
    );
    return normalizeSearchResults(parsed.results, "content");
  }
}

async function fetchSearchJson<T>(client: BoundedHttpClient, label: string, url: string, init: RequestInit | undefined, timeoutMs: number): Promise<T> {
  try {
    const { response, body } = await client.json<T>(url, init, { accept: "application/json" });
    if (response.status < 200 || response.status >= 300) {
      throw new Error(`${label} failed: ${response.status} ${response.statusText}${bodySnippet(body) ? ` - ${bodySnippet(body)}` : ""}`);
    }
    return body;
  } catch (error) {
    if (isTimeoutError(error)) throw new Error(`${label} timeout after ${timeoutMs}ms`, { cause: error });
    throw error;
  }
}

function bodySnippet(body: unknown): string {
  if (typeof body === "string") return body.slice(0, 300);
  if (!body || typeof body !== "object") return "";
  try {
    return JSON.stringify(body).slice(0, 300);
  } catch {
    return "";
  }
}

function isTimeoutError(error: unknown): boolean {
  return error instanceof Error && /timeout/i.test(error.message);
}

function searchTimeoutMs(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(1_000, Math.min(60_000, value)) : FETCH_TIMEOUT_MS;
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
  selected.length = Math.min(selected.length, MAX_SEARCH_RESULTS);
  return selected;
}

function buildPublicResearchQuery(input: ResearchToolInput): string {
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

function completedToolRun(input: ResearchToolInput, toolName: string, startedAt: string, completedAt: string, toolInput: unknown, output: unknown) {
  return {
    id: createId("tool"),
    projectId: input.project.id,
    iteration: input.iteration,
    toolName,
    input: toolInput,
    output,
    status: "completed" as const,
    startedAt,
    completedAt
  };
}
