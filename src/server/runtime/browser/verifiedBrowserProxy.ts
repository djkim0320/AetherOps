import { createServer, request as requestHttp, type IncomingHttpHeaders, type IncomingMessage, type ServerResponse } from "node:http";
import { connect as connectTcp, type Socket } from "node:net";
import { once } from "node:events";
import type { Duplex } from "node:stream";
import type { ResearchSourceAccessPolicy } from "../../../core/shared/adapterTypes.js";
import { assertSourceAccess } from "../../../core/tools/sourceAccessPolicy.js";
import { PublicUrlPolicy } from "../tools/publicUrlPolicy.js";
import { createVerifiedLookup } from "../tools/pinnedHttpTransport.js";
import { BrowserResourceLimitError, DEFAULT_BROWSER_RESOURCE_BUDGET } from "./browserResourceBudget.js";

const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade"
]);

export interface VerifiedBrowserProxyOptions {
  policy: PublicUrlPolicy;
  sourceAccess: ResearchSourceAccessPolicy;
  timeoutMs: number;
  signal: AbortSignal;
}

export class VerifiedBrowserProxy {
  private readonly server = createServer();
  private readonly controller = new AbortController();
  private readonly sockets = new Set<Socket>();
  private readonly incomingSockets = new Set<Socket>();
  private requestCount = 0;
  private aggregateResponseBytes = 0;
  private endpoint?: string;
  private closePromise?: Promise<void>;
  private firstFailure?: Error;

  private constructor(private readonly options: VerifiedBrowserProxyOptions) {
    this.server.on("request", (request, response) => void this.forwardHttp(request, response).catch((error) => this.failHttp(response, error)));
    this.server.on("connect", (request, socket, head) => void this.forwardTunnel(request, socket, head).catch((error) => this.failTunnel(socket, error)));
    this.server.on("connection", (socket) => this.trackIncomingSocket(socket));
    this.server.on("clientError", (_error, socket) => socket.destroy());
  }

  static async start(options: VerifiedBrowserProxyOptions): Promise<VerifiedBrowserProxy> {
    const proxy = new VerifiedBrowserProxy(options);
    await proxy.listen();
    return proxy;
  }

  url(): string {
    if (!this.endpoint) throw new Error("Verified browser proxy is not listening.");
    return this.endpoint;
  }

  failure(): Error | undefined {
    return this.firstFailure;
  }

  close(): Promise<void> {
    this.closePromise ??= this.performClose();
    return this.closePromise;
  }

  private async listen(): Promise<void> {
    this.options.signal.throwIfAborted();
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => reject(error);
      this.server.once("error", onError);
      this.server.listen(0, "127.0.0.1", () => {
        this.server.removeListener("error", onError);
        resolve();
      });
    });
    const address = this.server.address();
    if (!address || typeof address === "string") throw new Error("Verified browser proxy did not bind a TCP address.");
    this.endpoint = `http://127.0.0.1:${address.port}`;
    this.options.signal.addEventListener("abort", this.abort, { once: true });
  }

  private readonly abort = (): void => {
    void this.close();
  };

  private async forwardTunnel(request: IncomingMessage, client: Duplex, head: Buffer): Promise<void> {
    this.reserveRequest();
    const target = connectTarget(request.url);
    await this.options.policy.assertPublicHttpUrl(target.url);
    assertConnectSourceAccess(this.options.sourceAccess, target.url);
    this.options.signal.throwIfAborted();
    const remote = connectTcp({
      host: target.hostname,
      port: target.port,
      lookup: createVerifiedLookup(this.options.policy),
      signal: AbortSignal.any([this.options.signal, this.controller.signal])
    });
    this.trackSocket(remote);
    remote.setTimeout(this.options.timeoutMs, () => remote.destroy(new Error("Browser proxy tunnel timed out.")));
    await once(remote, "connect");
    remote.setTimeout(0);
    client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    if (head.byteLength) remote.write(head);
    let responseBytes = 0;
    remote.on("data", (chunk: Buffer) => {
      responseBytes = this.consumeResponseBytes(chunk.byteLength, responseBytes, client, remote);
    });
    client.pipe(remote);
    remote.pipe(client);
  }

  private async forwardHttp(request: IncomingMessage, response: ServerResponse): Promise<void> {
    this.reserveRequest();
    if (request.method !== "GET" && request.method !== "HEAD") throw new Error("Browser proxy permits only GET and HEAD requests.");
    const target = await this.options.policy.assertPublicHttpUrl(request.url ?? "");
    assertSourceAccess(this.options.sourceAccess, target);
    const parsed = new URL(target);
    if (parsed.protocol !== "http:") throw new Error("HTTPS browser traffic must use a CONNECT tunnel.");
    const upstream = requestHttp(parsed, {
      method: request.method,
      headers: sanitizeHeaders(request.headers),
      lookup: createVerifiedLookup(this.options.policy),
      signal: AbortSignal.any([this.options.signal, this.controller.signal]),
      timeout: this.options.timeoutMs
    });
    upstream.setTimeout(this.options.timeoutMs, () => upstream.destroy(new Error("Browser proxy HTTP request timed out.")));
    request.once("aborted", () => upstream.destroy(new Error("Browser proxy client disconnected.")));
    upstream.end();
    const [upstreamResponse] = (await once(upstream, "response")) as [IncomingMessage];
    const declaredLength = Number(upstreamResponse.headers["content-length"] ?? "0");
    if (Number.isFinite(declaredLength) && declaredLength > DEFAULT_BROWSER_RESOURCE_BUDGET.maxNetworkResponseBytes) {
      upstreamResponse.destroy();
      throw new BrowserResourceLimitError("Browser network response byte limit was exceeded.");
    }
    response.writeHead(upstreamResponse.statusCode ?? 502, sanitizeHeaders(upstreamResponse.headers));
    let responseBytes = 0;
    for await (const rawChunk of upstreamResponse) {
      const chunk = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk);
      responseBytes = this.consumeResponseBytes(chunk.byteLength, responseBytes, response, upstream);
      if (!response.write(chunk)) await once(response, "drain");
    }
    response.end();
  }

  private reserveRequest(): void {
    this.requestCount += 1;
    if (this.requestCount > DEFAULT_BROWSER_RESOURCE_BUDGET.maxNetworkRequests) {
      throw new BrowserResourceLimitError("Browser network request limit was exceeded.");
    }
  }

  private consumeResponseBytes(bytes: number, responseBytes: number, ...destroyables: Array<{ destroy(error?: Error): unknown }>): number {
    const nextResponseBytes = responseBytes + bytes;
    this.aggregateResponseBytes += bytes;
    const failure =
      nextResponseBytes > DEFAULT_BROWSER_RESOURCE_BUDGET.maxNetworkResponseBytes ||
      this.aggregateResponseBytes > DEFAULT_BROWSER_RESOURCE_BUDGET.maxAggregateNetworkBytes;
    if (!failure) return nextResponseBytes;
    const error = new BrowserResourceLimitError("Browser network response byte limit was exceeded.");
    this.recordFailure(error);
    for (const destroyable of destroyables) destroyable.destroy(error);
    return nextResponseBytes;
  }

  private trackIncomingSocket(socket: Socket): void {
    this.incomingSockets.add(socket);
    this.trackSocket(socket);
    if (this.incomingSockets.size > DEFAULT_BROWSER_RESOURCE_BUDGET.maxConcurrentConnections) {
      this.recordFailure(new BrowserResourceLimitError("Browser concurrent connection limit was exceeded."));
      socket.destroy();
    }
    socket.once("close", () => this.incomingSockets.delete(socket));
  }

  private trackSocket(socket: Socket): void {
    this.sockets.add(socket);
    socket.once("close", () => this.sockets.delete(socket));
  }

  private failHttp(response: ServerResponse, error: unknown): void {
    this.recordFailure(error);
    if (!response.headersSent) response.writeHead(policyFailure(error) ? 403 : 502, { "content-type": "text/plain", connection: "close" });
    response.end("Browser proxy request blocked.");
  }

  private failTunnel(socket: Duplex, error: unknown): void {
    this.recordFailure(error);
    if (socket.writable) socket.end(`HTTP/1.1 ${policyFailure(error) ? "403 Forbidden" : "502 Bad Gateway"}\r\nConnection: close\r\n\r\n`);
    else socket.destroy();
  }

  private recordFailure(error: unknown): void {
    this.firstFailure ??= error instanceof Error ? error : new Error(String(error));
  }

  private async performClose(): Promise<void> {
    this.options.signal.removeEventListener("abort", this.abort);
    this.controller.abort(new Error("Verified browser proxy closed."));
    for (const socket of this.sockets) socket.destroy();
    if (this.server.listening) await new Promise<void>((resolve) => this.server.close(() => resolve()));
    this.endpoint = undefined;
  }
}

function connectTarget(authority: string | undefined): { url: string; hostname: string; port: number } {
  if (!authority) throw new Error("Browser proxy CONNECT target is missing.");
  const parsed = new URL(`https://${authority}/`);
  if (parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash)
    throw new Error("Browser proxy CONNECT target is invalid.");
  const port = Number(parsed.port || "443");
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) throw new Error("Browser proxy CONNECT port is invalid.");
  return { url: parsed.toString(), hostname: parsed.hostname.replace(/^\[|\]$/g, ""), port };
}

function sanitizeHeaders(headers: IncomingHttpHeaders): Record<string, string | string[]> {
  const sanitized: Record<string, string | string[]> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (HOP_BY_HOP_HEADERS.has(name.toLowerCase()) || value === undefined) continue;
    sanitized[name] = value;
  }
  sanitized.connection = "close";
  return sanitized;
}

function policyFailure(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /blocked|not permitted|permits only|invalid public|DNS resolved|DNS returned|DNS resolution|request limit|byte limit|connection limit/i.test(message);
}

function assertConnectSourceAccess(policy: ResearchSourceAccessPolicy, target: string): void {
  if (policy.mode === "offline") throw new Error("Offline source policy blocks browser network access.");
  const targetUrl = new URL(target);
  if (policy.mode === "allowlist") {
    const allowedOrigin = policy.urls.some((value) => new URL(value).origin === targetUrl.origin);
    if (!allowedOrigin) throw new Error(`Browser CONNECT target is outside the job allowlist: ${targetUrl.origin}`);
    return;
  }
  if (!policy.allowedDomains.length) return;
  const hostname = targetUrl.hostname.toLowerCase();
  if (!policy.allowedDomains.some((domain) => hostname === domain.toLowerCase() || hostname.endsWith(`.${domain.toLowerCase()}`))) {
    throw new Error(`Browser CONNECT target is outside the allowed discovery domains: ${hostname}`);
  }
}
