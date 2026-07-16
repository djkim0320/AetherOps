import type { IncomingMessage, ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import { healthPayload } from "./health.js";
import { createServerRequestId, internalErrorMessage, logInternalError } from "./errorBoundary.js";
import { readJsonBody, type HttpServerPolicy } from "./jsonBody.js";
import { HttpError, sendJson } from "./response.js";
import type { ServerDrainController } from "./serverDrain.js";
import { serveStatic } from "./staticFiles.js";
import type { SseRuntimeDiagnostics } from "../composition/sseRuntimeDiagnostics.js";
import { addRestrictedCorsHeaders, authenticateRpcRequest, setRpcTokenCookie } from "../runtime/security/loopbackRpcSecurity.js";
import { sanitizeTraceRecord } from "../runtime/security/traceSanitizer.js";
import type { RpcHandlerContext } from "./v2/context.js";
import { handleRpcV2, RpcV2Error } from "./v2/rpcRouter.js";
import { serveProjectEvents } from "./v2/sseController.js";

interface WebRequestHandlerOptions {
  context(): RpcHandlerContext;
  rpcToken: string;
  httpPolicy: HttpServerPolicy;
  drain: ServerDrainController;
  sseDiagnostics: SseRuntimeDiagnostics;
}

export function createWebRequestHandler(options: WebRequestHandlerOptions): (request: IncomingMessage, response: ServerResponse) => Promise<void> {
  return async (request, response) => {
    const lease = options.drain.begin(request, response);
    if (!lease) {
      sendJson(response, 503, { ok: false, error: "Server is shutting down." }, { headers: { "Retry-After": "1" } });
      return;
    }
    const requestStartedAt = Date.now();
    const operation = `${request.method ?? "UNKNOWN"} ${(request.url ?? "/").split("?", 1)[0]}`;
    const serverRequestId = createServerRequestId();
    try {
      const context = options.context();
      if (!addRestrictedCorsHeaders(request, response, { host: context.host, port: context.port, env: context.env })) {
        sendJson(response, 403, { ok: false, error: "CORS origin is not allowed." });
        return;
      }
      if (request.method === "OPTIONS") {
        response.writeHead(204);
        response.end();
        return;
      }
      const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
      if (url.pathname === "/api/health") {
        if (request.method !== "GET" && request.method !== "HEAD") {
          sendJson(response, 405, { ok: false, error: "Method not allowed." }, { headers: { Allow: "GET, HEAD" } });
          return;
        }
        setRpcTokenCookie(response, options.rpcToken);
        sendJson(response, 200, healthPayload({ port: context.port, startedAt: context.startedAt, version: context.version, dataRoot: context.dataRoot }), {
          head: request.method === "HEAD"
        });
        return;
      }
      if (url.pathname === "/api/v2/rpc") {
        if (request.method !== "POST") {
          sendJson(response, 405, { ok: false, error: "Method not allowed." }, { headers: { Allow: "POST" } });
          return;
        }
        const authFailure = authenticateRpcRequest(request, options.rpcToken);
        if (authFailure) throw new HttpError(authFailure.status, authFailure.message);
        assertJsonRequest(request);
        const body = await readJsonBody(request, { label: "RPC request body", readTimeoutMs: options.httpPolicy.bodyReadTimeoutMs });
        const routed = await handleRpcV2(body, context);
        sendJson(response, 200, { requestId: routed.requestId, ok: true, result: routed.result });
        return;
      }
      if (url.pathname === "/api/v2/events") {
        if (request.method !== "GET") {
          sendJson(response, 405, { ok: false, error: "Method not allowed." }, { headers: { Allow: "GET" } });
          return;
        }
        const authFailure = authenticateRpcRequest(request, options.rpcToken);
        if (authFailure) throw new HttpError(authFailure.status, authFailure.message);
        options.drain.trackSse(response, await serveProjectEvents(request, response, url, context.jobs, { diagnostics: options.sseDiagnostics }));
        return;
      }
      if (url.pathname.startsWith("/api/")) {
        sendJson(response, 404, { ok: false, error: "Not found." });
        return;
      }
      if (request.method !== "GET" && request.method !== "HEAD") {
        sendJson(response, 405, { ok: false, error: "Method not allowed." }, { headers: { Allow: "GET, HEAD" } });
        return;
      }
      setRpcTokenCookie(response, options.rpcToken);
      await serveStatic(context.appRoot, url.pathname, response, { head: request.method === "HEAD" });
    } catch (error) {
      handleRequestError(error, request, response, operation, requestStartedAt, serverRequestId);
    } finally {
      lease.release();
    }
  };
}

export function handleClientError(error: Error, socket: Duplex): void {
  const code = safeClientErrorCode(error);
  logInternalError(new Error(`HTTP parser rejected a client request (${code}).`), {
    requestId: createServerRequestId(),
    operation: "CLIENTERROR /",
    startedAt: Date.now()
  });
  if (!socket.writable || socket.destroyed) {
    socket.destroy();
    return;
  }
  const status = code === "HPE_HEADER_OVERFLOW" ? 431 : 400;
  const statusText = status === 431 ? "Request Header Fields Too Large" : "Bad Request";
  const body = `${JSON.stringify({ ok: false, error: "Malformed HTTP request." })}\n`;
  const clientResponse = [
    `HTTP/1.1 ${status} ${statusText}`,
    "Connection: close",
    "Cache-Control: no-store",
    "Content-Type: application/json; charset=utf-8",
    "X-Content-Type-Options: nosniff",
    `Content-Length: ${Buffer.byteLength(body)}`,
    "",
    body
  ].join("\r\n");
  socket.end(clientResponse, "utf8", () => socket.destroy());
}

function handleRequestError(
  error: unknown,
  request: IncomingMessage,
  response: ServerResponse,
  operation: string,
  requestStartedAt: number,
  serverRequestId: string
): void {
  if (error instanceof RpcV2Error) {
    if (error.code === "INTERNAL_ERROR") {
      logInternalError(error.cause ?? error, { requestId: error.requestId, operation, startedAt: requestStartedAt });
    }
    sendJson(response, error.status, {
      requestId: error.requestId,
      ok: false,
      error: { code: error.code, message: error.message, ...(error.details ? { details: sanitizeTraceRecord(error.details) } : {}) }
    });
    return;
  }
  const status = error instanceof HttpError ? error.status : 500;
  const message = error instanceof HttpError && status < 500 ? error.message : internalErrorMessage;
  if (error instanceof HttpError && error.closeConnection && !response.headersSent) response.setHeader("Connection", "close");
  if (!(error instanceof HttpError) || status >= 500) {
    logInternalError(error, { requestId: serverRequestId, operation, startedAt: requestStartedAt });
  }
  if ((request.url ?? "").startsWith("/api/v2/")) {
    sendJson(response, status, {
      requestId: serverRequestId,
      ok: false,
      error: { code: httpStatusErrorCode(status), message }
    });
    return;
  }
  sendJson(response, status, { requestId: serverRequestId, ok: false, error: message });
}

function assertJsonRequest(request: IncomingMessage): void {
  const contentEncoding = request.headers["content-encoding"]?.trim().toLowerCase();
  if (contentEncoding && contentEncoding !== "identity") {
    request.pause();
    throw new HttpError(415, "Compressed RPC request bodies are not supported.", true);
  }
  const rawContentType = request.headers["content-type"];
  const contentType = Array.isArray(rawContentType) ? rawContentType[0] : rawContentType;
  const mediaType = contentType?.split(";", 1)[0]?.trim().toLowerCase();
  if (!mediaType || (mediaType !== "application/json" && !/^application\/[a-z0-9!#$&^_.+-]+\+json$/.test(mediaType))) {
    request.pause();
    throw new HttpError(415, "RPC requests require an application/json Content-Type.", true);
  }
}

function httpStatusErrorCode(status: number): "VALIDATION_ERROR" | "CAPABILITY_DENIED" | "NOT_FOUND" | "INTERNAL_ERROR" {
  if (status === 401 || status === 403) return "CAPABILITY_DENIED";
  if (status === 404) return "NOT_FOUND";
  if (status >= 400 && status < 500) return "VALIDATION_ERROR";
  return "INTERNAL_ERROR";
}

function safeClientErrorCode(error: Error): string {
  const code = (error as NodeJS.ErrnoException).code;
  return typeof code === "string" && /^[A-Z0-9_]{1,64}$/.test(code) ? code : "HTTP_PARSE_ERROR";
}
