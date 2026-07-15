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
import { BrowserResourceLimitError, collectBoundedPageText, DEFAULT_BROWSER_RESOURCE_BUDGET, enforceCaptureBudget } from "./browserResourceBudget.js";
import { fetchBingRssLinks } from "./browserRssDiscovery.js";
import { VerifiedBrowserProxy } from "./verifiedBrowserProxy.js";

export interface BrowserCollectInput {
  project: ResearchProject;
  query: string;
  urls?: string[];
  settings: BrowserUseSettings;
  sourceAccess: ResearchSourceAccessPolicy;
  signal?: AbortSignal;
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
  private readonly lifecycleController = new AbortController();
  private readonly activeContexts = new Set<BrowserContext>();
  private readonly activeProxies = new Set<VerifiedBrowserProxy>();
  private disposePromise?: Promise<void>;

  constructor(
    private readonly dataRoot: string,
    private readonly publicUrlPolicy = new PublicUrlPolicy()
  ) {}

  async collect(input: BrowserCollectInput): Promise<BrowserCollectedPage[]> {
    if (this.disposePromise) throw new Error("Background browser runtime is disposed.");
    if (!input.settings.enabled) {
      throw new Error("Background browser use is disabled.");
    }
    const signal = input.signal ? AbortSignal.any([input.signal, this.lifecycleController.signal]) : this.lifecycleController.signal;
    signal.throwIfAborted();

    const userDataDir = join(this.dataRoot, "browser-profiles", input.project.id);
    mkdirSync(userDataDir, { recursive: true });

    const proxy = await VerifiedBrowserProxy.start({
      policy: this.publicUrlPolicy,
      sourceAccess: input.sourceAccess,
      timeoutMs: input.settings.timeoutMs,
      signal
    });
    this.activeProxies.add(proxy);
    let context: BrowserContext | undefined;
    const closeOnAbort = (): void => {
      void context?.close().catch(() => undefined);
    };
    signal.addEventListener("abort", closeOnAbort, { once: true });

    try {
      const { chromium } = await import("playwright");
      context = await chromium.launchPersistentContext(userDataDir, {
        acceptDownloads: false,
        args: ["--disable-quic", "--force-webrtc-ip-handling-policy=disable_non_proxied_udp"],
        headless: input.settings.mode !== "visible",
        locale: "ko-KR",
        proxy: { server: proxy.url() },
        serviceWorkers: "block",
        timeout: input.settings.timeoutMs,
        viewport: { width: 1366, height: 900 }
      });
      this.activeContexts.add(context);
      signal.throwIfAborted();
      await installBrowserNetworkPolicy(context, this.publicUrlPolicy, input.sourceAccess, input.onNetworkAudit);
      const urls = await this.resolveUrls(input, context, signal);
      const pages: BrowserCollectedPage[] = [];
      const failures: string[] = [];
      let capturedBytes = 0;

      const pageLimit = Math.min(urls.length, input.settings.maxPages);
      for (let index = 0; index < pageLimit; index += 1) {
        signal.throwIfAborted();
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
          const boundedText = await page
            .locator("body")
            .evaluate(collectBoundedPageText, DEFAULT_BROWSER_RESOURCE_BUDGET.maxTextCharacters)
            .catch(() => ({ text: "", truncated: false }));
          if (boundedText.truncated) {
            throw new BrowserResourceLimitError("Browser page text exceeded its character limit.");
          }
          const text = normalizePageText(boundedText.text);
          const screenshot = input.settings.captureScreenshots ? await page.screenshot({ fullPage: false, type: "png" }) : undefined;
          if (screenshot) {
            capturedBytes = enforceCaptureBudget(
              "Browser screenshot",
              screenshot.byteLength,
              DEFAULT_BROWSER_RESOURCE_BUDGET.maxScreenshotBytes,
              DEFAULT_BROWSER_RESOURCE_BUDGET.maxAggregateCaptureBytes,
              capturedBytes
            );
          }
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
          signal.throwIfAborted();
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
      signal.removeEventListener("abort", closeOnAbort);
      if (context) {
        this.activeContexts.delete(context);
        await context.close().catch((error: unknown) => {
          if (!signal.aborted) throw error;
        });
      }
      this.activeProxies.delete(proxy);
      await proxy.close();
    }
  }

  async dispose(): Promise<void> {
    this.disposePromise ??= this.performDispose();
    return this.disposePromise;
  }

  private async performDispose(): Promise<void> {
    this.lifecycleController.abort(new Error("Background browser runtime disposed."));
    const results = await Promise.allSettled([
      ...[...this.activeContexts].map((context) => context.close()),
      ...[...this.activeProxies].map((proxy) => proxy.close())
    ]);
    const failures = results.flatMap((result) => (result.status === "rejected" ? [result.reason] : []));
    if (failures.length) throw new AggregateError(failures, "Failed to close background browser contexts.");
  }

  private async resolveUrls(input: BrowserCollectInput, context: BrowserContext, signal: AbortSignal): Promise<string[]> {
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
        signal.throwIfAborted();
        const publicSearchUrl = await withAbort(assertPublicNavigationUrl(this.publicUrlPolicy, searchUrl), signal);
        await searchPage.goto(publicSearchUrl, {
          waitUntil: "domcontentloaded",
          timeout: input.settings.timeoutMs
        });
        await searchPage.waitForLoadState("networkidle", { timeout: Math.min(input.settings.timeoutMs, 8_000) }).catch(() => undefined);
        signal.throwIfAborted();
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
      const rssLinks = await fetchBingRssLinks(publicResearchQuery(query), {
        publicUrlPolicy: this.publicUrlPolicy,
        timeoutMs: input.settings.timeoutMs,
        signal,
        ...(input.onNetworkAudit ? { onNetworkAudit: input.onNetworkAudit } : {})
      });
      return rankResearchUrls(publicNonSearchUrls(rssLinks).filter((url) => sourceUrlAllowed(input.sourceAccess, url)));
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

function normalizePageText(text: string): string {
  return text.replace(/\s+/g, " ").trim().slice(0, 20_000);
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function withAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  let removeAbortListener: (() => void) | undefined;
  const aborted = new Promise<never>((_, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    removeAbortListener = () => signal.removeEventListener("abort", abort);
  });
  return Promise.race([promise, aborted]).finally(() => removeAbortListener?.());
}
