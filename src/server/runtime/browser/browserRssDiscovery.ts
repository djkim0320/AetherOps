import { BoundedHttpClient, type BoundedNetworkAuditEvent, type PublicHttpUrlPolicy } from "../tools/boundedHttpClient.js";

const MAX_RSS_BYTES = 512 * 1024;
const MAX_RSS_LINKS = 100;

export interface BrowserRssDiscoveryOptions {
  timeoutMs: number;
  signal?: AbortSignal;
  publicUrlPolicy: PublicHttpUrlPolicy;
  fetchImpl?: typeof fetch;
  onNetworkAudit?: (audit: BoundedNetworkAuditEvent) => void | Promise<void>;
}

export async function fetchBingRssLinks(query: string, options: BrowserRssDiscoveryOptions): Promise<string[]> {
  const client = new BoundedHttpClient({
    publicUrlPolicy: options.publicUrlPolicy,
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    timeoutMs: Math.min(options.timeoutMs, 15_000),
    maxBytes: MAX_RSS_BYTES,
    maxRedirects: 5,
    ...(options.onNetworkAudit ? { onNetworkAudit: options.onNetworkAudit } : {})
  });
  const response = await client.request(
    `https://www.bing.com/search?format=rss&q=${encodeURIComponent(query)}`,
    { ...(options.signal ? { signal: options.signal } : {}) },
    { accept: "application/rss+xml,application/xml,text/xml", maxBytes: MAX_RSS_BYTES }
  );
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`Bing RSS discovery failed with HTTP ${response.status}.`);
  }
  return parseRssLinks(response.bytes);
}

export function parseRssLinks(bytes: Uint8Array): string[] {
  let xml: string;
  try {
    xml = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) {
    throw new Error("Bing RSS discovery returned invalid UTF-8.", { cause: error });
  }
  const links: string[] = [];
  for (const match of xml.matchAll(/<link>([\s\S]*?)<\/link>/gi)) {
    const link = decodeXmlEntities(match[1] ?? "").trim();
    if (link) links.push(link);
    if (links.length >= MAX_RSS_LINKS) break;
  }
  return links;
}

function decodeXmlEntities(value: string): string {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}
