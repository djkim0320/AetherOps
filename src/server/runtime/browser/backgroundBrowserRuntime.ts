import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { BrowserContext } from "playwright";
import { rankResearchUrls } from "../../../core/evidence/sourceQuality.js";
import type { BrowserUseSettings, ResearchProject } from "../../../core/shared/types.js";
import type { ResearchSourceAccessPolicy } from "../../../core/shared/adapterTypes.js";
import { assertSourceAccess, sourceDiscoveryAllowed } from "../../../core/tools/sourceAccessPolicy.js";
import { PublicUrlPolicy } from "../tools/publicUrlPolicy.js";
import { assertPublicNavigationUrl, installBrowserNetworkPolicy } from "./browserNetworkPolicy.js";
import { redactAuditUrl, type BoundedNetworkAuditEvent } from "../tools/boundedHttpClient.js";

export interface BrowserCollectInput {
  project: ResearchProject;
  query: string;
  urls?: string[];
  settings: BrowserUseSettings;
  sourceAccess: ResearchSourceAccessPolicy;
  onNetworkAudit?: (audit: BoundedNetworkAuditEvent) => void | Promise<void>;
}

export interface BrowserCollectedPage {
  url: string;
  title: string;
  text: string;
  screenshotBase64?: string;
  screenshotMimeType?: string;
}

export interface BrowserPageCollector {
  collect(input: BrowserCollectInput): Promise<BrowserCollectedPage[]>;
}

export class BackgroundBrowserRuntime implements BrowserPageCollector {
  constructor(
    private readonly dataRoot: string,
    private readonly publicUrlPolicy = new PublicUrlPolicy()
  ) {}

  async collect(input: BrowserCollectInput): Promise<BrowserCollectedPage[]> {
    if (!input.settings.enabled) {
      throw new Error("Background browser use is disabled.");
    }

    const userDataDir = join(this.dataRoot, "browser-profiles", input.project.id);
    const downloadsPath = join(input.project.projectRoot, "sources", "browser-downloads");
    mkdirSync(userDataDir, { recursive: true });
    mkdirSync(downloadsPath, { recursive: true });

    const { chromium } = await import("playwright");
    const context = await chromium.launchPersistentContext(userDataDir, {
      acceptDownloads: true,
      downloadsPath,
      headless: input.settings.mode !== "visible",
      locale: "ko-KR",
      viewport: { width: 1366, height: 900 }
    });

    try {
      await installBrowserNetworkPolicy(context, this.publicUrlPolicy, input.sourceAccess, input.onNetworkAudit);
      const urls = await this.resolveUrls(input, context);
      const pages: BrowserCollectedPage[] = [];
      const failures: string[] = [];

      const pageLimit = Math.min(urls.length, input.settings.maxPages);
      for (let index = 0; index < pageLimit; index += 1) {
        const url = urls[index];
        if (!url) continue;
        const page = await context.newPage();
        try {
          const publicUrl = await assertPublicNavigationUrl(this.publicUrlPolicy, url);
          await page.goto(publicUrl, { waitUntil: "domcontentloaded", timeout: input.settings.timeoutMs });
          await page.waitForLoadState("networkidle", { timeout: Math.min(input.settings.timeoutMs, 10_000) }).catch(() => undefined);
          const finalUrl = assertSourceAccess(input.sourceAccess, await assertPublicNavigationUrl(this.publicUrlPolicy, page.url()));
          await input.onNetworkAudit?.({
            url: redactAuditUrl(finalUrl),
            redirectChain: uniqueHttpUrls([url, finalUrl]).map(redactAuditUrl),
            policyDecision: "allowed",
            auditedAt: new Date().toISOString()
          });
          const title = (await page.title()).trim() || finalUrl;
          const text = normalizePageText(
            await page
              .locator("body")
              .innerText({ timeout: Math.min(input.settings.timeoutMs, 10_000) })
              .catch(() => "")
          );
          const screenshot = input.settings.captureScreenshots ? await page.screenshot({ fullPage: false, type: "png" }) : undefined;
          if (text) {
            pages.push({
              url: finalUrl,
              title,
              text,
              screenshotBase64: screenshot?.toString("base64"),
              screenshotMimeType: screenshot ? "image/png" : undefined
            });
          }
        } catch (error) {
          failures.push(`${url}: ${formatError(error)}`);
        } finally {
          await page.close().catch(() => undefined);
        }
      }

      if (!pages.length) {
        throw new Error(failures.length ? `No pages collected. ${failures.join(" | ")}` : "No browser pages were available to collect.");
      }

      return pages;
    } finally {
      await context.close();
    }
  }

  private async resolveUrls(input: BrowserCollectInput, context: BrowserContext): Promise<string[]> {
    const directUrls = rankResearchUrls(uniqueHttpUrls(input.urls ?? []).map((url) => assertSourceAccess(input.sourceAccess, url)));
    if (directUrls.length) {
      return directUrls;
    }

    if (!sourceDiscoveryAllowed(input.sourceAccess)) {
      throw new Error(`${input.sourceAccess.mode} source policy requires explicit direct URLs; browser discovery is prohibited.`);
    }

    const query = input.query.trim();
    if (!query) {
      return [];
    }

    const searchPage = await context.newPage();
    try {
      const searchUrls = [
        `https://scholar.google.com/scholar?q=${encodeURIComponent(query)}`,
        `https://www.semanticscholar.org/search?q=${encodeURIComponent(query)}&sort=relevance`,
        `https://search.crossref.org/?q=${encodeURIComponent(query)}`,
        `https://arxiv.org/search/?query=${encodeURIComponent(query)}&searchtype=all`,
        `https://duckduckgo.com/html/?q=${encodeURIComponent(publicResearchQuery(query))}`,
        `https://www.bing.com/search?q=${encodeURIComponent(publicResearchQuery(query))}`,
        `https://duckduckgo.com/html/?q=${encodeURIComponent(query)}`,
        `https://www.bing.com/search?q=${encodeURIComponent(query)}`,
        `https://search.brave.com/search?q=${encodeURIComponent(query)}`
      ];
      for (const searchUrl of searchUrls) {
        const publicSearchUrl = await assertPublicNavigationUrl(this.publicUrlPolicy, searchUrl);
        await searchPage.goto(publicSearchUrl, {
          waitUntil: "domcontentloaded",
          timeout: input.settings.timeoutMs
        });
        await searchPage.waitForLoadState("networkidle", { timeout: Math.min(input.settings.timeoutMs, 8_000) }).catch(() => undefined);
        const links = await searchPage.$$eval("a[href]", (anchors) =>
          anchors
            .map((anchor) => (anchor as HTMLAnchorElement).href)
            .filter(Boolean)
            .slice(0, 80)
        );
        const urls = rankResearchUrls(publicNonSearchUrls(links).filter((url) => sourceUrlAllowed(input.sourceAccess, url)));
        if (urls.length) {
          return urls;
        }
      }
      return rankResearchUrls(
        (await resolveBingRssUrls(publicResearchQuery(query), input.settings.timeoutMs)).filter((url) => sourceUrlAllowed(input.sourceAccess, url))
      );
    } finally {
      await searchPage.close().catch(() => undefined);
    }
  }
}

function sourceUrlAllowed(policy: ResearchSourceAccessPolicy, url: string): boolean {
  try {
    assertSourceAccess(policy, url);
    return true;
  } catch {
    return false;
  }
}

function uniqueHttpUrls(urls: string[]): string[] {
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const raw of urls) {
    try {
      const url = new URL(raw);
      if (url.protocol !== "http:" && url.protocol !== "https:") {
        continue;
      }
      const value = url.toString();
      if (!seen.has(value)) {
        seen.add(value);
        normalized.push(value);
      }
    } catch {
      continue;
    }
  }
  return normalized;
}

function decodeSearchRedirect(rawUrl: string): string {
  try {
    const url = new URL(rawUrl);
    const redirected = url.searchParams.get("uddg") ?? url.searchParams.get("url") ?? url.searchParams.get("u");
    return redirected ? decodeURIComponent(redirected) : rawUrl;
  } catch {
    return rawUrl;
  }
}

function isSearchEngineUrl(rawUrl: string): boolean {
  try {
    const hostname = new URL(rawUrl).hostname.replace(/^www\./, "");
    for (const domain of searchEngineDomains) {
      if (hostname === domain || hostname.endsWith(`.${domain}`)) return true;
    }
    return false;
  } catch {
    return true;
  }
}

const searchEngineDomains = ["duckduckgo.com", "bing.com", "microsoft.com", "search.brave.com", "brave.com", "google.com", "google.co.kr"];

function publicResearchQuery(query: string): string {
  return [
    query,
    "(site:arxiv.org OR site:semanticscholar.org OR site:doi.org OR site:nist.gov OR site:oecd.org OR site:iso.org OR site:edu)",
    "paper OR study OR standard OR framework OR report"
  ].join(" ");
}

async function resolveBingRssUrls(query: string, timeoutMs: number): Promise<string[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.min(timeoutMs, 15_000));
  try {
    const response = await fetch(`https://www.bing.com/search?format=rss&q=${encodeURIComponent(query)}`, {
      signal: controller.signal,
      headers: { accept: "application/rss+xml,application/xml,text/xml" }
    });
    if (!response.ok) {
      return [];
    }
    const xml = await response.text();
    const links: string[] = [];
    for (const match of xml.matchAll(/<link>([\s\S]*?)<\/link>/gi)) {
      const link = decodeXmlEntities(match[1] ?? "").trim();
      if (link) links.push(link);
    }
    return publicNonSearchUrls(links);
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

function publicNonSearchUrls(rawUrls: string[]): string[] {
  const seen = new Set<string>();
  const urls: string[] = [];
  for (const url of uniqueHttpUrls(rawUrls)) {
    const decoded = decodeSearchRedirect(url);
    for (const normalized of uniqueHttpUrls([decoded])) {
      if (!isSearchEngineUrl(normalized) && !seen.has(normalized)) {
        seen.add(normalized);
        urls.push(normalized);
      }
    }
  }
  return urls;
}

function decodeXmlEntities(value: string): string {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function normalizePageText(text: string): string {
  return text.replace(/\s+/g, " ").trim().slice(0, 20_000);
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
