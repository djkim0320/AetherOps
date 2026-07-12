import { PublicUrlPolicy } from "./publicUrlPolicy.js";
import { BoundedHttpError, cancelResponseBody, parseJsonBytes, readLimitedBytes } from "./boundedHttpBody.js";
export { BoundedHttpError, type BoundedHttpErrorCode } from "./boundedHttpBody.js";

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;
const DEFAULT_MAX_REDIRECTS = 10;
const DEFAULT_USER_AGENT = "AetherOps/0.2 research client";
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const SENSITIVE_REDIRECT_HEADERS = [
  "authorization",
  "proxy-authorization",
  "cookie",
  "cookie2",
  "x-api-key",
  "api-key",
  "x-subscription-token",
  "x-goog-api-key"
] as const;

export interface BoundedHttpClientOptions {
  publicUrlPolicy?: PublicHttpUrlPolicy;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  maxBytes?: number;
  maxRedirects?: number;
  onNetworkAudit?: (audit: BoundedNetworkAuditEvent) => void | Promise<void>;
}

export interface BoundedNetworkAuditEvent {
  url: string;
  redirectChain: string[];
  policyDecision: "allowed" | "denied";
  reason?: string;
  auditedAt: string;
}

export interface PublicHttpUrlPolicy {
  assertPublicHttpUrl(value: string): Promise<string>;
}

export interface BoundedHttpRequestOptions {
  accept?: string;
  maxBytes?: number;
}

export interface BoundedHttpResponse {
  url: string;
  status: number;
  statusText: string;
  contentType: string;
  headers: Headers;
  bytes: Uint8Array;
}

export class BoundedHttpClient {
  private readonly policy: PublicHttpUrlPolicy;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly maxBytes: number;
  private readonly maxRedirects: number;
  private readonly onNetworkAudit?: BoundedHttpClientOptions["onNetworkAudit"];

  constructor(options: BoundedHttpClientOptions = {}) {
    this.policy = options.publicUrlPolicy ?? new PublicUrlPolicy();
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.timeoutMs = normalizeTimeout(options.timeoutMs, DEFAULT_TIMEOUT_MS);
    this.maxBytes = normalizeMaxBytes(options.maxBytes, DEFAULT_MAX_BYTES);
    this.maxRedirects = normalizeMaxRedirects(options.maxRedirects, DEFAULT_MAX_REDIRECTS);
    this.onNetworkAudit = options.onNetworkAudit;
  }

  async request(url: string, init: RequestInit = {}, options: BoundedHttpRequestOptions = {}): Promise<BoundedHttpResponse> {
    const raw = await this.requestRaw(url, init, options);
    try {
      const bytes = await readLimitedBytes(
        raw.response,
        redactAuditUrl(raw.url),
        normalizeMaxBytes(options.maxBytes, this.maxBytes),
        raw.deadline,
        raw.signal,
        raw.externalSignal
      );
      return {
        url: raw.url,
        status: raw.response.status,
        statusText: raw.response.statusText,
        contentType: raw.response.headers.get("content-type") ?? "unknown",
        headers: raw.response.headers,
        bytes
      };
    } finally {
      clearTimeout(raw.timeout);
      raw.controller.abort();
    }
  }

  async head(url: string, init: RequestInit = {}, options: BoundedHttpRequestOptions = {}): Promise<BoundedHttpResponse> {
    const raw = await this.requestRaw(url, { ...init, method: "HEAD", body: undefined }, options);
    try {
      return {
        url: raw.url,
        status: raw.response.status,
        statusText: raw.response.statusText,
        contentType: raw.response.headers.get("content-type") ?? "unknown",
        headers: raw.response.headers,
        bytes: new Uint8Array()
      };
    } finally {
      clearTimeout(raw.timeout);
      raw.controller.abort();
    }
  }

  async json<T>(url: string, init: RequestInit = {}, options: BoundedHttpRequestOptions = {}): Promise<{ response: BoundedHttpResponse; body: T }> {
    const raw = await this.requestRaw(url, init, options);
    try {
      const bytes = await readLimitedBytes(
        raw.response,
        redactAuditUrl(raw.url),
        normalizeMaxBytes(options.maxBytes, this.maxBytes),
        raw.deadline,
        raw.signal,
        raw.externalSignal
      );
      const body = parseJsonBytes<T>(bytes);
      return {
        response: {
          url: raw.url,
          status: raw.response.status,
          statusText: raw.response.statusText,
          contentType: raw.response.headers.get("content-type") ?? "unknown",
          headers: raw.response.headers,
          bytes
        },
        body
      };
    } catch (error) {
      if (error instanceof BoundedHttpError) throw error;
      throw new BoundedHttpError("INVALID_JSON", "invalid JSON response", { cause: error });
    } finally {
      clearTimeout(raw.timeout);
      raw.controller.abort();
    }
  }

  private async requestRaw(
    url: string,
    init: RequestInit = {},
    options: BoundedHttpRequestOptions = {}
  ): Promise<{
    url: string;
    response: Response;
    deadline: number;
    controller: AbortController;
    signal: AbortSignal;
    externalSignal?: AbortSignal | null;
    timeout: ReturnType<typeof setTimeout>;
  }> {
    const deadline = Date.now() + this.timeoutMs;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    const requestSignal = init.signal ? AbortSignal.any([controller.signal, init.signal]) : controller.signal;
    const redirectChain: string[] = [];
    let currentUrl = await this.assertAuditedUrl(url, redirectChain);
    let requestInit = normalizeRequestInit(init, options.accept, requestSignal);
    const visited = new Set([currentUrl]);
    let completed = false;

    try {
      for (let redirectCount = 0; ; redirectCount += 1) {
        const response = await this.fetchOnce(currentUrl, requestInit, controller, deadline);
        if (isRedirectStatus(response.status)) {
          let nextUrl: string;
          let nextRequestInit: RequestInit;
          try {
            const location = response.headers.get("location");
            if (!location) {
              throw new BoundedHttpError("REDIRECT_MISSING_LOCATION", `redirect response from ${redactAuditUrl(currentUrl)} is missing Location`);
            }
            if (redirectCount >= this.maxRedirects) {
              throw new BoundedHttpError("TOO_MANY_REDIRECTS", `too many redirects for ${redactAuditUrl(url)}`);
            }
            nextUrl = await this.assertAuditedUrl(new URL(location, currentUrl).toString(), redirectChain);
            if (visited.has(nextUrl)) {
              throw new BoundedHttpError("REDIRECT_LOOP", `redirect loop detected for ${redactAuditUrl(nextUrl)}`);
            }
            nextRequestInit = followRedirectRequestInit(requestInit, response.status, requestSignal, currentUrl, nextUrl);
          } finally {
            await cancelResponseBody(response);
          }
          currentUrl = nextUrl;
          requestInit = nextRequestInit;
          visited.add(currentUrl);
          continue;
        }
        completed = true;
        return { url: currentUrl, response, deadline, controller, signal: requestSignal, externalSignal: init.signal, timeout };
      }
    } finally {
      if (!completed) {
        clearTimeout(timeout);
        controller.abort();
      }
    }
  }

  private async assertAuditedUrl(value: string, redirectChain: string[]): Promise<string> {
    try {
      const allowed = await this.policy.assertPublicHttpUrl(value);
      redirectChain.push(redactAuditUrl(allowed));
      await this.onNetworkAudit?.({
        url: redactAuditUrl(allowed),
        redirectChain: [...redirectChain],
        policyDecision: "allowed",
        auditedAt: new Date().toISOString()
      });
      return allowed;
    } catch (error) {
      const redacted = redactAuditUrl(value);
      if (redirectChain.at(-1) !== redacted) redirectChain.push(redacted);
      await this.onNetworkAudit?.({
        url: redacted,
        redirectChain: [...redirectChain],
        policyDecision: "denied",
        reason: formatError(error),
        auditedAt: new Date().toISOString()
      });
      throw error;
    }
  }

  private async fetchOnce(currentUrl: string, requestInit: RequestInit, controller: AbortController, deadline: number): Promise<Response> {
    const fetchPromise = this.fetchImpl(currentUrl, { ...requestInit, redirect: "manual", signal: controller.signal });
    try {
      return await withDeadline(fetchPromise, deadline, `request timeout after ${this.timeoutMs}ms`);
    } catch (error) {
      if (isAbortOrTimeout(error, deadline)) {
        throw new Error(`request timeout after ${this.timeoutMs}ms`, { cause: error });
      }
      throw error;
    }
  }
}

function normalizeRequestInit(init: RequestInit, accept: string | undefined, signal: AbortSignal): RequestInit {
  const headers = new Headers(init.headers ?? undefined);
  if (accept && !headers.has("accept")) headers.set("accept", accept);
  if (!headers.has("user-agent")) headers.set("user-agent", DEFAULT_USER_AGENT);
  return { ...init, headers, signal };
}

function followRedirectRequestInit(init: RequestInit, status: number, signal: AbortSignal, previousUrl: string, nextUrl: string): RequestInit {
  const method = (init.method ?? "GET").toUpperCase();
  const rewriteToGet = (status === 303 && method !== "HEAD") || ((status === 301 || status === 302) && method === "POST");
  const headers = new Headers(init.headers ?? undefined);
  let next: RequestInit;
  if (rewriteToGet) {
    headers.delete("content-length");
    headers.delete("content-type");
    headers.delete("transfer-encoding");
    next = { ...init, method: "GET", body: undefined, headers, signal };
  } else {
    next = { ...init, headers, signal };
  }
  if (new URL(previousUrl).origin !== new URL(nextUrl).origin) {
    if (next.body !== undefined && next.body !== null) {
      throw new BoundedHttpError("REDIRECT_BODY_BLOCKED", "cross-origin redirect with a request body is not allowed");
    }
    for (const name of SENSITIVE_REDIRECT_HEADERS) headers.delete(name);
  }
  return next;
}

function isRedirectStatus(status: number): boolean {
  return REDIRECT_STATUSES.has(status);
}

function normalizeTimeout(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

function normalizeMaxBytes(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

function normalizeMaxRedirects(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : fallback;
}

function withDeadline<T>(promise: Promise<T>, deadline: number, message: string): Promise<T> {
  const remaining = deadline - Date.now();
  if (remaining <= 0) return Promise.reject(new Error(message));
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timer = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => reject(new Error(message)), remaining);
  });
  return Promise.race([promise, timer]).finally(() => {
    if (timeout) clearTimeout(timeout);
  });
}

function isAbortOrTimeout(error: unknown, deadline: number): boolean {
  return Date.now() >= deadline || (error instanceof Error && (error.name === "AbortError" || /abort|timeout/i.test(error.message)));
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function redactAuditUrl(value: string): string {
  try {
    const url = new URL(value);
    url.username = "";
    url.password = "";
    for (const key of Array.from(url.searchParams.keys())) url.searchParams.set(key, "<redacted>");
    url.hash = "";
    return url.toString();
  } catch {
    return "<invalid-url>";
  }
}
