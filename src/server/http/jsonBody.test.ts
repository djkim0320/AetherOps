import type { IncomingMessage } from "node:http";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readJsonBody, resolveHttpServerPolicy } from "./jsonBody.js";

afterEach(() => vi.useRealTimers());

describe("JSON request body boundaries", () => {
  it("rejects invalid parser limits instead of silently substituting defaults", async () => {
    await expect(readJsonBody(fakeRequest({}), { label: "test", maxBytes: 0 })).rejects.toThrow("maxBytes must be a positive integer");
    await expect(readJsonBody(fakeRequest({}), { label: "test", readTimeoutMs: Number.NaN })).rejects.toThrow("readTimeoutMs must be a positive integer");
  });

  it("rejects an oversized declared Content-Length before reading and closes the request", async () => {
    const request = fakeRequest({ "content-length": "9" });

    await expect(readJsonBody(request, { label: "test", maxBytes: 8 })).rejects.toMatchObject({
      status: 413,
      message: "Request body is too large.",
      closeConnection: true
    });
    expect(request.isPaused()).toBe(true);
    expectParserListenersRemoved(request);
  });

  it.each(["-1", "1.5", "1e3", "+1", "not-a-number"])("rejects invalid Content-Length %s", async (contentLength) => {
    const request = fakeRequest({ "content-length": contentLength });

    await expect(readJsonBody(request, { label: "test", maxBytes: 8 })).rejects.toMatchObject({
      status: 400,
      message: "Invalid Content-Length header."
    });
    expect(request.isPaused()).toBe(true);
    expectParserListenersRemoved(request);
  });

  it("rejects one oversized chunk before retaining it and cleans up the stream", async () => {
    const request = fakeRequest({});
    const result = readJsonBody(request, { label: "test", maxBytes: 8 });

    request.write(Buffer.alloc(9));

    await expect(result).rejects.toMatchObject({ status: 413, message: "Request body is too large.", closeConnection: true });
    expect(request.isPaused()).toBe(true);
    expectParserListenersRemoved(request);
  });

  it("rejects a chunked body once cumulative bytes exceed the limit", async () => {
    const request = fakeRequest({});
    const result = readJsonBody(request, { label: "test", maxBytes: 8 });

    request.write('{"value"');
    request.write(":1}");

    await expect(result).rejects.toMatchObject({ status: 413, message: "Request body is too large.", closeConnection: true });
    expect(request.isPaused()).toBe(true);
    expectParserListenersRemoved(request);
  });

  it("accepts a body at the exact byte boundary and removes parser listeners", async () => {
    const body = Buffer.from('{"x":1}', "utf8");
    const request = fakeRequest({ "content-length": String(body.byteLength) });
    const result = readJsonBody(request, { label: "test", maxBytes: body.byteLength });

    request.end(body);

    await expect(result).resolves.toEqual({ x: 1 });
    expectParserListenersRemoved(request);
  });

  it("rejects an aborted request exactly once with a stable public error", async () => {
    const request = fakeRequest({});
    const result = readJsonBody(request, { label: "test", maxBytes: 100 });

    request.emit("aborted");
    request.emit("close");

    await expect(result).rejects.toMatchObject({ status: 400, message: "Request body was aborted." });
    expectParserListenersRemoved(request);
  });

  it("rejects a premature close instead of leaving the body promise pending", async () => {
    const request = fakeRequest({});
    const result = readJsonBody(request, { label: "test", maxBytes: 100 });

    request.write('{"x":');
    request.emit("close");

    await expect(result).rejects.toMatchObject({ status: 400, message: "Request body closed before completion." });
    expectParserListenersRemoved(request);
  });

  it("redacts the underlying stream error and cleans up listeners", async () => {
    const request = fakeRequest({});
    const result = readJsonBody(request, { label: "test", maxBytes: 100 });

    request.emit("error", new Error("Bearer secret-provider-response"));

    await expect(result).rejects.toMatchObject({ status: 400, message: "Request body stream failed." });
    expectParserListenersRemoved(request);
  });

  it("times out a stalled body with an injectable deterministic deadline", async () => {
    vi.useFakeTimers();
    const request = fakeRequest({});
    const result = readJsonBody(request, { label: "test", maxBytes: 100, readTimeoutMs: 50 });
    const rejected = expect(result).rejects.toMatchObject({ status: 408, message: "Request body read timed out.", closeConnection: true });

    request.write('{"x":');
    await vi.advanceTimersByTimeAsync(50);

    await rejected;
    expect(request.isPaused()).toBe(true);
    expectParserListenersRemoved(request);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not expose invalid UTF-8 bytes or the decoder label in the error", async () => {
    const request = fakeRequest({});
    const result = readJsonBody(request, { label: "secret-label", maxBytes: 100 });

    request.end(Buffer.from([0xff, 0xfe]));

    await expect(result).rejects.toMatchObject({ status: 400, message: "Invalid UTF-8 request body." });
    expectParserListenersRemoved(request);
  });

  it("rejects invalid JSON with a stable public error", async () => {
    const request = fakeRequest({});
    const result = readJsonBody(request, { label: "test", maxBytes: 100 });

    request.end("{not-json}");

    await expect(result).rejects.toMatchObject({ status: 400, message: "Invalid JSON request body." });
    expectParserListenersRemoved(request);
  });

  it("treats an empty RPC body as a validation error", async () => {
    const request = fakeRequest({ "content-length": "0" });
    const result = readJsonBody(request, { label: "test", maxBytes: 100 });

    request.end();

    await expect(result).rejects.toMatchObject({ status: 400, message: "Request body is required." });
    expectParserListenersRemoved(request);
  });
});

describe("HTTP ingress policy", () => {
  it("uses conservative defaults that keep body ingress separate from request handling", () => {
    expect(resolveHttpServerPolicy(undefined, {})).toEqual({
      headersTimeoutMs: 15_000,
      requestTimeoutMs: 60_000,
      bodyReadTimeoutMs: 30_000,
      keepAliveTimeoutMs: 5_000,
      maxRequestsPerSocket: 100,
      connectionsCheckingIntervalMs: 2_000
    });
  });

  it("accepts bounded environment configuration and rejects inconsistent deadlines", () => {
    expect(
      resolveHttpServerPolicy(undefined, {
        AETHEROPS_HTTP_HEADERS_TIMEOUT_MS: "12000",
        AETHEROPS_HTTP_REQUEST_TIMEOUT_MS: "90000",
        AETHEROPS_HTTP_BODY_READ_TIMEOUT_MS: "15000",
        AETHEROPS_HTTP_KEEP_ALIVE_TIMEOUT_MS: "4000",
        AETHEROPS_HTTP_MAX_REQUESTS_PER_SOCKET: "25",
        AETHEROPS_HTTP_CONNECTIONS_CHECKING_INTERVAL_MS: "2000"
      })
    ).toEqual({
      headersTimeoutMs: 12_000,
      requestTimeoutMs: 90_000,
      bodyReadTimeoutMs: 15_000,
      keepAliveTimeoutMs: 4_000,
      maxRequestsPerSocket: 25,
      connectionsCheckingIntervalMs: 2_000
    });
    expect(() => resolveHttpServerPolicy({ headersTimeoutMs: 61_000, requestTimeoutMs: 60_000 }, {})).toThrow("headers timeout must not exceed");
  });
});

function fakeRequest(headers: Record<string, string>): IncomingMessage & PassThrough {
  const stream = new PassThrough() as IncomingMessage & PassThrough;
  Object.defineProperty(stream, "headers", { value: headers, configurable: true });
  return stream;
}

function expectParserListenersRemoved(request: IncomingMessage & PassThrough): void {
  for (const event of ["data", "end", "error", "aborted", "close"]) expect(request.listenerCount(event), event).toBe(0);
}
