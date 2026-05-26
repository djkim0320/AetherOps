import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright";
import { rankResearchUrls } from "../../core/sourceQuality.js";
import type { BrowserUseSettings, ResearchProject } from "../../core/types.js";

export interface BrowserCollectInput {
  project: ResearchProject;
  query: string;
  urls?: string[];
  settings: BrowserUseSettings;
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
  constructor(private readonly dataRoot: string) {}

  async collect(input: BrowserCollectInput): Promise<BrowserCollectedPage[]> {
    if (!input.settings.enabled) {
      throw new Error("Background browser use is disabled.");
    }

    const userDataDir = join(this.dataRoot, "browser-profiles", input.project.id);
    const downloadsPath = join(input.project.projectRoot, "sources", "browser-downloads");
    mkdirSync(userDataDir, { recursive: true });
    mkdirSync(downloadsPath, { recursive: true });

    const context = await chromium.launchPersistentContext(userDataDir, {
      acceptDownloads: true,
      downloadsPath,
      headless: input.settings.mode !== "visible",
      locale: "ko-KR",
      viewport: { width: 1366, height: 900 }
    });

    try {
      const urls = await this.resolveUrls(input, context);
      const pages: BrowserCollectedPage[] = [];
      const failures: string[] = [];

      for (const url of urls.slice(0, input.settings.maxPages)) {
        const page = await context.newPage();
        try {
          await page.goto(url, { waitUntil: "domcontentloaded", timeout: input.settings.timeoutMs });
          await page.waitForLoadState("networkidle", { timeout: Math.min(input.settings.timeoutMs, 10_000) }).catch(() => undefined);
          const title = (await page.title()).trim() || url;
          const text = normalizePageText(
            await page
              .locator("body")
              .innerText({ timeout: Math.min(input.settings.timeoutMs, 10_000) })
              .catch(() => "")
          );
          const screenshot = input.settings.captureScreenshots ? await page.screenshot({ fullPage: false, type: "png" }) : undefined;
          if (text) {
            pages.push({
              url: page.url(),
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

  private async resolveUrls(input: BrowserCollectInput, context: Awaited<ReturnType<typeof chromium.launchPersistentContext>>): Promise<string[]> {
    const directUrls = rankResearchUrls(uniqueHttpUrls(input.urls ?? []));
    if (directUrls.length) {
      return directUrls;
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
        await searchPage.goto(searchUrl, {
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
        const urls = rankResearchUrls(uniqueHttpUrls(links.map(decodeSearchRedirect)).filter((url) => !isSearchEngineUrl(url)));
        if (urls.length) {
          return urls;
        }
      }
      return rankResearchUrls(await resolveBingRssUrls(publicResearchQuery(query), input.settings.timeoutMs));
    } finally {
      await searchPage.close().catch(() => undefined);
    }
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
    return [
      "duckduckgo.com",
      "bing.com",
      "microsoft.com",
      "search.brave.com",
      "brave.com",
      "google.com",
      "google.co.kr"
    ].some((domain) => hostname === domain || hostname.endsWith(`.${domain}`));
  } catch {
    return true;
  }
}

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
    const links = [...xml.matchAll(/<link>([\s\S]*?)<\/link>/gi)]
      .map((match) => decodeXmlEntities(match[1] ?? "").trim())
      .filter(Boolean);
    return uniqueHttpUrls(links).filter((url) => !isSearchEngineUrl(url));
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

function decodeXmlEntities(value: string): string {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'");
}

function normalizePageText(text: string): string {
  return text.replace(/\s+/g, " ").trim().slice(0, 20_000);
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
