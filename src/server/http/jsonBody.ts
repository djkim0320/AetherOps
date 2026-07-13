import type { IncomingMessage } from "node:http";
import { decodeStrictUtf8Chunks } from "../runtime/support/strictUtf8.js";
import { HttpError } from "./response.js";

const DEFAULT_MAX_BYTES = 10_000_000;
const DEFAULT_READ_TIMEOUT_MS = 30_000;

export interface HttpServerPolicyOptions {
  headersTimeoutMs?: number;
  requestTimeoutMs?: number;
  bodyReadTimeoutMs?: number;
  keepAliveTimeoutMs?: number;
  maxRequestsPerSocket?: number;
  connectionsCheckingIntervalMs?: number;
}

export interface HttpServerPolicy {
  headersTimeoutMs: number;
  requestTimeoutMs: number;
  bodyReadTimeoutMs: number;
  keepAliveTimeoutMs: number;
  maxRequestsPerSocket: number;
  connectionsCheckingIntervalMs: number;
}

const defaultHttpPolicy: HttpServerPolicy = Object.freeze({
  headersTimeoutMs: 15_000,
  requestTimeoutMs: 60_000,
  bodyReadTimeoutMs: 30_000,
  keepAliveTimeoutMs: 5_000,
  maxRequestsPerSocket: 100,
  connectionsCheckingIntervalMs: 2_000
});

export interface JsonBodyOptions {
  label: string;
  maxBytes?: number;
  readTimeoutMs?: number;
}

export async function readJsonBody(request: IncomingMessage, options: JsonBodyOptions): Promise<unknown> {
  const maxBytes = bodyOption(options.maxBytes, DEFAULT_MAX_BYTES, "maxBytes");
  const readTimeoutMs = bodyOption(options.readTimeoutMs, DEFAULT_READ_TIMEOUT_MS, "readTimeoutMs");
  let declaredLength: number | undefined;
  try {
    declaredLength = declaredContentLength(request);
  } catch (error) {
    stopReadingRequest(request);
    if (error instanceof HttpError) throw new HttpError(error.status, error.message, true);
    throw error;
  }
  if (declaredLength !== undefined && declaredLength > maxBytes) {
    stopReadingRequest(request);
    throw new HttpError(413, "Request body is too large.", true);
  }

  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let bodyBytes = 0;
    let settled = false;

    const cleanup = (): void => {
      clearTimeout(timeout);
      request.removeListener("data", onData);
      request.removeListener("end", onEnd);
      request.removeListener("error", onError);
      request.removeListener("aborted", onAborted);
      request.removeListener("close", onClose);
    };
    const rejectOnce = (error: HttpError, action: "none" | "pause" | "destroy"): void => {
      if (settled) return;
      settled = true;
      cleanup();
      if (action === "pause") stopReadingRequest(request);
      if (action === "destroy") closeRequest(request);
      reject(error);
    };
    const resolveOnce = (value: unknown): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(value);
    };
    const onData = (chunk: Buffer | Uint8Array | string): void => {
      if (settled) return;
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      if (bodyBytes + buffer.byteLength > maxBytes) {
        rejectOnce(new HttpError(413, "Request body is too large.", true), "pause");
        return;
      }
      bodyBytes += buffer.byteLength;
      chunks.push(buffer);
    };
    const onEnd = (): void => {
      if (settled) return;
      let body: string;
      try {
        body = chunks.length ? decodeStrictUtf8Chunks(chunks, options.label) : "";
      } catch {
        rejectOnce(new HttpError(400, "Invalid UTF-8 request body."), "none");
        return;
      }
      if (!body.trim()) {
        rejectOnce(new HttpError(400, "Request body is required."), "none");
        return;
      }
      try {
        resolveOnce(JSON.parse(body));
      } catch {
        rejectOnce(new HttpError(400, "Invalid JSON request body."), "none");
      }
    };
    const onError = (): void => rejectOnce(new HttpError(400, "Request body stream failed."), "destroy");
    const onAborted = (): void => rejectOnce(new HttpError(400, "Request body was aborted."), "destroy");
    const onClose = (): void => rejectOnce(new HttpError(400, "Request body closed before completion."), "none");
    const timeout = setTimeout(() => rejectOnce(new HttpError(408, "Request body read timed out.", true), "pause"), readTimeoutMs);
    timeout.unref();

    request.on("data", onData);
    request.once("end", onEnd);
    request.once("error", onError);
    request.once("aborted", onAborted);
    request.once("close", onClose);

    if (request.aborted) onAborted();
    else if (request.destroyed) onClose();
  });
}

export function resolveHttpServerPolicy(options: HttpServerPolicyOptions | undefined, env: NodeJS.ProcessEnv): HttpServerPolicy {
  const policy = {
    headersTimeoutMs: policyInteger(options?.headersTimeoutMs, env.AETHEROPS_HTTP_HEADERS_TIMEOUT_MS, defaultHttpPolicy.headersTimeoutMs, 1_000, 120_000),
    requestTimeoutMs: policyInteger(options?.requestTimeoutMs, env.AETHEROPS_HTTP_REQUEST_TIMEOUT_MS, defaultHttpPolicy.requestTimeoutMs, 1_000, 300_000),
    bodyReadTimeoutMs: policyInteger(options?.bodyReadTimeoutMs, env.AETHEROPS_HTTP_BODY_READ_TIMEOUT_MS, defaultHttpPolicy.bodyReadTimeoutMs, 100, 120_000),
    keepAliveTimeoutMs: policyInteger(options?.keepAliveTimeoutMs, env.AETHEROPS_HTTP_KEEP_ALIVE_TIMEOUT_MS, defaultHttpPolicy.keepAliveTimeoutMs, 100, 60_000),
    maxRequestsPerSocket: policyInteger(
      options?.maxRequestsPerSocket,
      env.AETHEROPS_HTTP_MAX_REQUESTS_PER_SOCKET,
      defaultHttpPolicy.maxRequestsPerSocket,
      1,
      10_000
    ),
    connectionsCheckingIntervalMs: policyInteger(
      options?.connectionsCheckingIntervalMs,
      env.AETHEROPS_HTTP_CONNECTIONS_CHECKING_INTERVAL_MS,
      defaultHttpPolicy.connectionsCheckingIntervalMs,
      100,
      60_000
    )
  };
  if (policy.headersTimeoutMs > policy.requestTimeoutMs) {
    throw new Error("AETHEROPS HTTP headers timeout must not exceed the request ingress timeout.");
  }
  return Object.freeze(policy);
}

function declaredContentLength(request: IncomingMessage): number | undefined {
  const value = request.headers["content-length"];
  if (value === undefined) return undefined;
  if (Array.isArray(value) || !/^\d+$/.test(value.trim())) throw new HttpError(400, "Invalid Content-Length header.");
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new HttpError(400, "Invalid Content-Length header.");
  return parsed;
}

function closeRequest(request: IncomingMessage): void {
  if (!request.destroyed) request.destroy();
}

function stopReadingRequest(request: IncomingMessage): void {
  if (!request.destroyed) request.pause();
}

function bodyOption(value: number | undefined, fallback: number, label: string): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`JSON body ${label} must be a positive integer.`);
  return value;
}

function policyInteger(explicit: number | undefined, environment: string | undefined, fallback: number, minimum: number, maximum: number): number {
  const value = explicit ?? (environment === undefined || !environment.trim() ? fallback : Number(environment));
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`AETHEROPS HTTP policy values must be integers from ${minimum} through ${maximum}.`);
  }
  return value;
}
