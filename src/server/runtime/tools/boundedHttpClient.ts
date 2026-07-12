import { PublicUrlPolicy } from "./publicUrlPolicy.js";

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;
const DEFAULT_MAX_REDIRECTS = 10;
const DEFAULT_USER_AGENT = "AetherOps/0.2 research client";

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
      const bytes = await readLimitedBytes(raw.response, raw.url, normalizeMaxBytes(options.maxBytes, this.maxBytes), raw.deadline);
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
      const body = await withDeadline(raw.response.json() as Promise<T>, raw.deadline, `response body timeout for ${raw.url}`);
      return {
        response: {
          url: raw.url,
          status: raw.response.status,
          statusText: raw.response.statusText,
          contentType: raw.response.headers.get("content-type") ?? "unknown",
          headers: raw.response.headers,
          bytes: new TextEncoder().encode(JSON.stringify(body))
        },
        body
      };
    } catch (error) {
      if (isAbortOrTimeout(error, raw.deadline)) {
        throw new Error(`response body timeout for ${raw.url}`, { cause: error });
      }
      throw new Error(`failed to parse JSON response from ${raw.url}: ${formatError(error)}`, { cause: error });
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
    timeout: ReturnType<typeof setTimeout>;
  }> {
    const deadline = Date.now() + this.timeoutMs;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    const requestSignal = init.signal ? AbortSignal.any([controller.signal, init.signal]) : controller.signal;
    const redirectChain: string[] = [];
    let currentUrl = await this.assertAuditedUrl(url, redirectChain);
    let requestInit = normalizeRequestInit(init, options.accept, requestSignal);
    let completed = false;

    try {
      for (let redirectCount = 0; redirectCount <= this.maxRedirects; redirectCount += 1) {
        const response = await this.fetchOnce(currentUrl, requestInit, controller, deadline);
        if (isRedirectStatus(response.status)) {
          const location = response.headers.get("location");
          if (!location) {
            throw new Error(`redirect response from ${currentUrl} missing Location header`);
          }
          const nextUrl = new URL(location, currentUrl);
          currentUrl = await this.assertAuditedUrl(nextUrl.toString(), redirectChain);
          requestInit = followRedirectRequestInit(requestInit, response.status, requestSignal);
          continue;
        }
        completed = true;
        return { url: currentUrl, response, deadline, controller, timeout };
      }
      throw new Error(`too many redirects for ${url}`);
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

function followRedirectRequestInit(init: RequestInit, status: number, signal: AbortSignal): RequestInit {
  const method = (init.method ?? "GET").toUpperCase();
  if (status === 303 || ((status === 301 || status === 302) && method !== "GET" && method !== "HEAD")) {
    const headers = new Headers(init.headers ?? undefined);
    headers.delete("content-length");
    headers.delete("content-type");
    return { ...init, method: "GET", body: undefined, headers, signal };
  }
  return { ...init, signal };
}

function isRedirectStatus(status: number): boolean {
  return status >= 300 && status < 400;
}

async function readLimitedBytes(response: Response, url: string, maxBytes: number, deadline: number): Promise<Uint8Array> {
  const contentLength = Number(response.headers.get("content-length") ?? "0");
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    throw new Error(`content-length exceeds ${formatBytes(maxBytes)} for ${url}`);
  }

  if (!response.body) {
    if (typeof response.arrayBuffer === "function") {
      const buffer = await withDeadline(response.arrayBuffer(), deadline, `body read timeout for ${url}`);
      const bytes = new Uint8Array(buffer);
      if (bytes.byteLength > maxBytes) throw new Error(`body exceeds ${formatBytes(maxBytes)} for ${url}`);
      return bytes;
    }
    if (typeof response.text === "function") {
      const text = await withDeadline(response.text(), deadline, `body read timeout for ${url}`);
      const bytes = new TextEncoder().encode(text);
      if (bytes.byteLength > maxBytes) throw new Error(`body exceeds ${formatBytes(maxBytes)} for ${url}`);
      return bytes;
    }
    if (typeof response.json === "function") {
      const json = await withDeadline(response.json(), deadline, `body read timeout for ${url}`);
      const bytes = new TextEncoder().encode(JSON.stringify(json));
      if (bytes.byteLength > maxBytes) throw new Error(`body exceeds ${formatBytes(maxBytes)} for ${url}`);
      return bytes;
    }
    const bytes = new Uint8Array();
    if (bytes.byteLength > maxBytes) throw new Error(`body exceeds ${formatBytes(maxBytes)} for ${url}`);
    return bytes;
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    let readResult: ReadableStreamReadResult<Uint8Array>;
    try {
      readResult = await withDeadline(reader.read(), deadline, `body read timeout for ${url}`);
    } catch (error) {
      await reader.cancel().catch(() => undefined);
      throw error;
    }
    if (readResult.done) break;
    const value = readResult.value;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new Error(`body exceeds ${formatBytes(maxBytes)} for ${url}`);
    }
    chunks.push(value);
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
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

function formatBytes(value: number): string {
  if (value >= 1024 * 1024) return `${Math.round(value / (1024 * 1024))}MB`;
  if (value >= 1024) return `${Math.round(value / 1024)}KB`;
  return `${value} bytes`;
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
