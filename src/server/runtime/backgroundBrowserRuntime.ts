import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright";
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
    const directUrls = uniqueHttpUrls(input.urls ?? []);
    if (directUrls.length) {
      return directUrls;
    }

    const query = input.query.trim();
    if (!query) {
      return [];
    }

    const searchPage = await context.newPage();
    try {
      await searchPage.goto(`https://duckduckgo.com/html/?q=${encodeURIComponent(query)}`, {
        waitUntil: "domcontentloaded",
        timeout: input.settings.timeoutMs
      });
      const links = await searchPage.$$eval("a[href]", (anchors) =>
        anchors
          .map((anchor) => (anchor as HTMLAnchorElement).href)
          .filter(Boolean)
          .slice(0, 30)
      );
      return uniqueHttpUrls(links.map(decodeDuckDuckGoRedirect)).filter((url) => !url.includes("duckduckgo.com"));
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

function decodeDuckDuckGoRedirect(rawUrl: string): string {
  try {
    const url = new URL(rawUrl);
    const redirected = url.searchParams.get("uddg");
    return redirected ? decodeURIComponent(redirected) : rawUrl;
  } catch {
    return rawUrl;
  }
}

function normalizePageText(text: string): string {
  return text.replace(/\s+/g, " ").trim().slice(0, 20_000);
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
