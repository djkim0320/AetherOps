import { extname } from "node:path";
import type { ResearchToolInput, ResearchSource } from "../../../core/shared/types.js";

const ALLOWED_FETCH_CONTENT_TYPES = new Set(["text/html", "text/plain", "application/xhtml+xml"]);
const TEXT_FETCH_EXTENSIONS = new Set([".csv", ".dat", ".json", ".md", ".tab", ".tsv", ".txt"]);
const HTML_META_CHARSET_PATTERN = /<meta\b[^>]*charset\s*=\s*["']?\s*([a-z0-9._:-]+)/i;
const LATIN1_TEXT_DECODER = new TextDecoder("latin1");

export function selectFetchTargets(input: ResearchToolInput): { urls: string[]; skippedUrls: string[]; duplicateUrls: string[] } {
  const alreadyFetched = new Set<string>();
  const sourceCandidates: Array<string | undefined> = [];
  const programSourceCandidates: Array<string | undefined> = [];
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
  for (const request of input.researchPlan?.programRequests ?? []) {
    programSourceCandidates.push(request.sourceUrl);
  }
  const selected = new Map<string, string>();
  const skippedUrls: string[] = [];
  const duplicateUrls: string[] = [];
  const considerCandidate = (candidate: string | undefined, options: { allowRefetch?: boolean } = {}): boolean => {
    const normalized = normalizeHttpUrl(candidate);
    if (!normalized) {
      if (candidate?.trim()) skippedUrls.push(candidate.trim());
      return false;
    }
    if ((!options.allowRefetch && alreadyFetched.has(normalized)) || selected.has(normalized)) {
      duplicateUrls.push(candidate?.trim() ?? normalized);
      return false;
    }
    selected.set(normalized, candidate?.trim() ?? normalized);
    return selected.size >= 3;
  };
  for (const candidate of input.researchPlan?.fetchCandidateUrls ?? []) {
    if (considerCandidate(candidate)) return { urls: [...selected.values()], skippedUrls, duplicateUrls };
  }
  for (const candidate of programSourceCandidates) {
    if (considerCandidate(candidate, { allowRefetch: true })) return { urls: [...selected.values()], skippedUrls, duplicateUrls };
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

export function isAllowedTextFetchContentType(mediaType: string, url: string): boolean {
  if (ALLOWED_FETCH_CONTENT_TYPES.has(mediaType)) return true;
  if (mediaType && mediaType !== "unknown" && mediaType !== "application/octet-stream") return false;
  return TEXT_FETCH_EXTENSIONS.has(urlPathExtension(url));
}

export function normalizeHttpUrl(value: string | undefined): string | undefined {
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

export function decodeFetchedText(body: Uint8Array, contentType: string, url: string): string {
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

export function normalizePageText(raw: string): string {
  return decodeEntities(
    raw
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim()
  ).slice(0, 20_000);
}

export function normalizePlainFetchedText(raw: string): string {
  return normalizeFetchedRawText(raw).slice(0, 20_000);
}

export function normalizeFetchedRawText(raw: string): string {
  return raw.replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim();
}

export function isHtmlFetchedText(contentType: string, raw: string): boolean {
  const mediaType = contentType.split(";")[0]?.trim().toLowerCase() ?? "";
  if (mediaType === "text/html" || mediaType === "application/xhtml+xml") return true;
  const sample = raw.slice(0, 2048).toLowerCase();
  return /<!doctype\s+html\b|<html\b|<head\b|<body\b/.test(sample);
}

export function extractTitle(raw: string): string {
  return decodeEntities(raw.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? "").trim();
}

export function runWithConcurrency<T, R>(items: T[], limit: number, task: (item: T, index: number) => Promise<R>): Promise<Array<PromiseSettledResult<R>>> {
  const results = new Array<PromiseSettledResult<R>>(items.length);
  let nextIndex = 0;
  const workerCount = Math.max(1, Math.min(limit, items.length));
  const workers: Array<Promise<void>> = [];
  for (let workerIndex = 0; workerIndex < workerCount; workerIndex += 1) {
    workers.push(
      (async () => {
        while (nextIndex < items.length) {
          const currentIndex = nextIndex;
          nextIndex += 1;
          try {
            results[currentIndex] = { status: "fulfilled", value: await task(items[currentIndex] as T, currentIndex) };
          } catch (reason) {
            results[currentIndex] = { status: "rejected", reason };
          }
        }
      })()
    );
  }
  return Promise.all(workers).then(() => results);
}

export function linkedHypothesisIds(input: ResearchToolInput): string[] {
  const ids: string[] = [];
  for (const hypothesis of input.hypotheses) ids.push(hypothesis.id);
  return ids;
}

export function copyStrings(values: string[]): string[] {
  const output: string[] = [];
  for (const value of values) output.push(value);
  return output;
}

export function withTopicKeywords(first: string, second: string, topicKeywords: string[]): string[];
export function withTopicKeywords(first: string, second: string, third: string, topicKeywords: string[]): string[];
export function withTopicKeywords(first: string, second: string, thirdOrKeywords: string | string[], maybeTopicKeywords?: string[]): string[] {
  const output = [first, second];
  const topicKeywords = Array.isArray(thirdOrKeywords) ? thirdOrKeywords : (maybeTopicKeywords ?? []);
  if (!Array.isArray(thirdOrKeywords)) output.push(thirdOrKeywords);
  for (const keyword of topicKeywords) output.push(keyword);
  return output;
}

export function arxivPdfUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const parsed = new URL(value);
    if (parsed.hostname.replace(/^www\./, "").toLowerCase() !== "arxiv.org") return undefined;
    const abstractMatch = parsed.pathname.match(/^\/abs\/([^/?#]+)/i);
    if (abstractMatch?.[1]) return `https://arxiv.org/pdf/${abstractMatch[1]}`;
    const pdfMatch = parsed.pathname.match(/^\/pdf\/([^/?#]+?)(?:\.pdf)?$/i);
    return pdfMatch?.[1] ? `https://arxiv.org/pdf/${pdfMatch[1]}` : undefined;
  } catch {
    return undefined;
  }
}

export function extractHttpUrls(value: string | undefined): string[] {
  return value?.match(/https?:\/\/[^\s)<>"']+/gi) ?? [];
}

export function readString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export function topicKeywordSlice(topic: string): string[] {
  const output: string[] = [];
  for (const part of topic.split(/[\s,;/|]+/)) {
    const cleaned = part.trim().toLowerCase();
    if (cleaned.length >= 2 && !output.includes(cleaned)) output.push(cleaned);
    if (output.length >= 5) break;
  }
  return output;
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

function decodeEntities(value: string): string {
  return value
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function urlPathExtension(url: string): string {
  try {
    return extname(new URL(url).pathname).toLowerCase();
  } catch {
    return "";
  }
}
