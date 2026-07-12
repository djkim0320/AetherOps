import { createId, nowIso } from "../../../core/shared/ids.js";
import { assessSourceQuality, sourceQualityMetadata } from "../../../core/evidence/sourceQuality.js";
import type { AppSettings, EvidenceItem, ResearchToolInput, ResearchSource } from "../../../core/shared/types.js";
import type { ResearchTool, ResearchToolExecutionContext, ResearchToolResult } from "../../../core/tools/researchToolTypes.js";
import { BoundedHttpClient } from "./boundedHttpClient.js";
import { JobSourceAccessPolicy } from "./jobSourceAccessPolicy.js";
import type { ResearchSourceAccessPolicy } from "../../../core/shared/adapterTypes.js";
import { assertSourceAccess } from "../../../core/tools/sourceAccessPolicy.js";
import {
  arxivPdfUrl,
  copyStrings,
  decodeFetchedText,
  extractTitle,
  isAllowedTextFetchContentType,
  isHtmlFetchedText,
  linkedHypothesisIds,
  normalizeFetchedRawText,
  normalizePageText,
  normalizePlainFetchedText,
  runWithConcurrency,
  selectFetchTargets,
  topicKeywordSlice,
  withTopicKeywords
} from "./webFetchSupport.js";

const FETCH_TIMEOUT_MS = 10_000;
const MAX_FETCH_BYTES = 2 * 1024 * 1024;
const WEB_FETCH_CONCURRENCY = 2;

export class WebFetchTool implements ResearchTool {
  name = "WebFetchTool";

  async run(input: ResearchToolInput, settings: AppSettings, context?: ResearchToolExecutionContext): Promise<ResearchToolResult> {
    const startedAt = nowIso();
    if (!input.project.autonomyPolicy.allowExternalSearch || !settings.allowExternalSearch) {
      throw new Error("WebFetchTool requires external network access, but external search is disabled by project autonomy or app settings.");
    }
    const sourceAccess = input.executionContext?.toolPolicy.sourceAccess;
    if (sourceAccess) {
      for (const url of input.researchPlan?.fetchCandidateUrls ?? []) assertSourceAccess(sourceAccess, url);
    }
    const { urls: selectedUrls, skippedUrls, duplicateUrls } = selectFetchTargets(input);
    const urls = sourceAccess ? selectedUrls.map((url) => assertSourceAccess(sourceAccess, url)) : selectedUrls;
    if (!urls.length) {
      throw new Error("WebFetchTool requires at least one external source URL from the research plan or existing sources.");
    }
    const settledPages = await runWithConcurrency(urls, WEB_FETCH_CONCURRENCY, (url) => fetchPage(url, sourceAccess, context));
    const completedAt = nowIso();
    const pages: Awaited<ReturnType<typeof fetchPage>>[] = [];
    const failedUrls: string[] = [];
    const failureReasons: Record<string, string> = {};
    for (let index = 0; index < settledPages.length; index += 1) {
      const result = settledPages[index];
      if (!result) continue;
      if (result.status === "fulfilled") pages.push(result.value);
      else {
        const url = urls[index] as string;
        failedUrls.push(url);
        failureReasons[url] = result.reason instanceof Error ? result.reason.message : String(result.reason);
      }
    }
    const toolInput = { urls, skippedUrls, duplicateUrls };
    const output = { urls, fetchedPages: pages.length, failedUrls, failureReasons, skippedUrls, duplicateUrls };
    if (!pages.length) {
      return {
        toolRun: toolRun(
          input,
          this.name,
          startedAt,
          completedAt,
          toolInput,
          output,
          "failed",
          `WebFetchTool failed to fetch all selected URLs: ${failedUrls.join(", ")}`
        ),
        evidence: [],
        artifacts: [],
        sources: []
      };
    }
    const sources: ResearchSource[] = [];
    const primarySources: ResearchSource[] = [];
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
          rawText: page.rawText,
          fetchedAt: completedAt,
          fetchStatus: "fetched",
          characterCount: page.rawText.length,
          ...(pdfUrl ? { pdfUrl } : {}),
          ...sourceQualityMetadata(page.url, page.title)
        },
        createdAt: completedAt
      };
      sources.push(source);
      primarySources.push(source);
      if (pdfUrl) sources.push(pdfSource(input.project.id, page.title, pdfUrl, completedAt));
    }
    const evidence = buildEvidence(input, pages, primarySources, completedAt);
    return {
      toolRun: toolRun(input, this.name, startedAt, completedAt, toolInput, output, "completed"),
      evidence,
      artifacts: [],
      sources
    };
  }
}

async function fetchPage(
  url: string,
  sourceAccess: ResearchSourceAccessPolicy | undefined,
  context?: ResearchToolExecutionContext
): Promise<{ url: string; title: string; text: string; rawText: string; contentType: string; status: number }> {
  const client = new BoundedHttpClient({
    timeoutMs: FETCH_TIMEOUT_MS,
    maxBytes: MAX_FETCH_BYTES,
    ...(sourceAccess ? { publicUrlPolicy: new JobSourceAccessPolicy(sourceAccess) } : {}),
    ...(sourceAccess && context?.onNetworkAudit ? { onNetworkAudit: (audit) => context.onNetworkAudit?.({ ...audit, sourcePolicy: sourceAccess }) } : {})
  });
  if (isDirectPdfUrl(url)) {
    const response = await withTransientNetworkRetry(() => client.head(url, { signal: context?.signal }, { accept: "application/pdf" }), context?.signal);
    if (response.status < 200 || response.status >= 300) {
      throw new Error(`PDF resource check failed for ${url}: ${response.status} ${response.statusText}`);
    }
    const mediaType = response.contentType.split(";")[0]?.trim().toLowerCase() ?? "";
    if (mediaType && mediaType !== "application/pdf" && mediaType !== "application/octet-stream" && mediaType !== "unknown") {
      throw new Error(`unsupported PDF content-type for ${url}: ${response.contentType}`);
    }
    const title = pdfTitle(response.url);
    const text = `Verified PDF resource at ${response.url}.`;
    return { url: response.url, title, text, rawText: text, contentType: response.contentType, status: response.status };
  }
  const response = await withTransientNetworkRetry(
    () => client.request(url, { signal: context?.signal }, { accept: "text/html,text/plain,application/xhtml+xml", maxBytes: MAX_FETCH_BYTES }),
    context?.signal
  );
  if (response.status < 200 || response.status >= 300) throw new Error(`fetch failed for ${url}: ${response.status} ${response.statusText}`);
  const mediaType = response.contentType.split(";")[0]?.trim().toLowerCase() ?? "";
  if (!isAllowedTextFetchContentType(mediaType, response.url)) throw new Error(`unsupported content-type for ${url}: ${response.contentType}`);
  const raw = decodeFetchedText(response.bytes, response.contentType, url);
  const title = extractTitle(raw) || url;
  const isHtml = isHtmlFetchedText(response.contentType, raw);
  const text = isHtml ? normalizePageText(raw) : normalizePlainFetchedText(raw);
  if (!text) throw new Error(`fetch produced no readable text for ${url}`);
  return { url: response.url, title, text, rawText: isHtml ? text : normalizeFetchedRawText(raw), contentType: response.contentType, status: response.status };
}

async function withTransientNetworkRetry<T>(task: () => Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error("WebFetchTool was aborted.");
    try {
      return await task();
    } catch (error) {
      lastError = error;
      if (attempt === 2 || !isTransientNetworkError(error)) throw error;
      await abortableDelay(300 * (attempt + 1), signal);
    }
  }
  throw lastError;
}

function isTransientNetworkError(error: unknown): boolean {
  const messages: string[] = [];
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current; depth += 1) {
    if (current instanceof Error) {
      messages.push(current.message);
      current = current.cause;
    } else break;
  }
  return /fetch failed|request timeout|econnreset|etimedout|socket|temporar/i.test(messages.join(" "));
}

function abortableDelay(ms: number, signal: AbortSignal | undefined): Promise<void> {
  if (!signal) return new Promise((resolve) => setTimeout(resolve, ms));
  return new Promise((resolve, reject) => {
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(signal.reason instanceof Error ? signal.reason : new Error("WebFetchTool was aborted."));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function isDirectPdfUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return /\.pdf$/i.test(parsed.pathname) || /\/pdf\//i.test(parsed.pathname);
  } catch {
    return false;
  }
}

function pdfTitle(value: string): string {
  try {
    const parsed = new URL(value);
    const fileName = parsed.pathname.split("/").filter(Boolean).at(-1) ?? parsed.hostname;
    return `${decodeURIComponent(fileName).replace(/\.pdf$/i, "")} PDF`;
  } catch {
    return "PDF document";
  }
}

function pdfSource(projectId: string, title: string, pdfUrl: string, createdAt: string): ResearchSource {
  return {
    id: createId("source"),
    projectId,
    kind: "paper",
    title: `${title} PDF`,
    url: pdfUrl,
    retrievedAt: createdAt,
    metadata: {
      provider: "arxiv",
      pdfUrl,
      sourceCandidateOnly: true,
      canSupportHypothesis: false,
      traceabilityKind: "external_source",
      ...sourceQualityMetadata(pdfUrl, `${title} PDF`)
    },
    createdAt
  };
}

function buildEvidence(
  input: ResearchToolInput,
  pages: Array<Awaited<ReturnType<typeof fetchPage>>>,
  sources: ResearchSource[],
  createdAt: string
): EvidenceItem[] {
  const topicKeywords = topicKeywordSlice(input.project.topic);
  const linkedIds = linkedHypothesisIds(input);
  return pages.map((page, index) => {
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
      keywords: withTopicKeywords("web_fetch", quality.tier, topicKeywords),
      linkedHypothesisIds: copyStrings(linkedIds),
      reliabilityScore: quality.reliabilityScore,
      relevanceScore: quality.preferredForSearch ? 0.78 : 0.58,
      evidenceStrength: quality.evidenceStrength,
      limitations: ["Fetched web page text was extracted automatically and should be checked against the original page.", ...quality.limitations],
      createdAt
    };
  });
}

function toolRun(
  input: ResearchToolInput,
  toolName: string,
  startedAt: string,
  completedAt: string,
  toolInput: unknown,
  output: unknown,
  status: "failed" | "completed",
  error?: string
) {
  return {
    id: createId("tool"),
    projectId: input.project.id,
    iteration: input.iteration,
    toolName,
    input: toolInput,
    output,
    status,
    ...(error ? { error } : {}),
    startedAt,
    completedAt
  };
}
