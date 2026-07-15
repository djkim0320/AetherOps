import { describe, expect, it, vi } from "vitest";
import { BoundedHttpClient } from "./boundedHttpClient.js";

const publicPolicy = { assertPublicHttpUrl: async (value: string) => new URL(value).toString() };

describe("BoundedHttpClient JSON boundaries", () => {
  it("returns the original JSON bytes at the exact boundary", async () => {
    const bytes = new TextEncoder().encode(' { "ok": true }\n');
    const client = clientFor(() => new Response(bytes, { headers: { "content-type": "application/json" } }), bytes.byteLength);

    const result = await client.json<{ ok: boolean }>("https://api.example/data");

    expect(result.body).toEqual({ ok: true });
    expect(result.response.bytes).toEqual(bytes);
  });

  it("rejects declared oversized JSON before parsing and cancels the body", async () => {
    const cancelled = vi.fn();
    const body = pendingStream(cancelled);
    const client = clientFor(() => new Response(body, { headers: { "content-length": "9" } }), 8);

    await expect(client.json("https://api.example/data")).rejects.toThrow("content-length exceeds 8 bytes");
    expect(cancelled).toHaveBeenCalledOnce();
  });

  it("rejects chunked JSON once cumulative bytes exceed the limit", async () => {
    const cancelled = vi.fn();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"ok":'));
        controller.enqueue(new TextEncoder().encode("true}"));
      },
      cancel: cancelled
    });
    const client = clientFor(() => new Response(body), 8);

    await expect(client.json("https://api.example/data")).rejects.toThrow("body exceeds 8 bytes");
    expect(cancelled).toHaveBeenCalledOnce();
  });

  it("does not trust a smaller declared Content-Length", async () => {
    const body = streamBytes(new TextEncoder().encode('{"value":123}'));
    const client = clientFor(() => new Response(body, { headers: { "content-length": "2" } }), 8);

    await expect(client.json("https://api.example/data")).rejects.toThrow("body exceeds 8 bytes");
  });

  it.each([
    ["empty", new Uint8Array(), "empty JSON response body"],
    ["invalid JSON", new TextEncoder().encode("{broken"), "invalid JSON response"],
    ["invalid UTF-8", Uint8Array.from([0x7b, 0x22, 0x78, 0x22, 0x3a, 0xff, 0x7d]), "invalid UTF-8 response body"]
  ])("classifies %s without exposing the body", async (_label, bytes, expected) => {
    const client = clientFor(() => new Response(bytes), 1024);

    const error = await client.json("https://api.example/data?token=secret").catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain(expected);
    expect((error as Error).message).not.toContain("broken");
    expect((error as Error).message).not.toContain("secret");
  });

  it("cancels an in-progress JSON body when the caller aborts", async () => {
    const cancelled = vi.fn();
    const reading = deferred<void>();
    const controller = new AbortController();
    const body = new ReadableStream<Uint8Array>({
      pull() {
        reading.resolve();
      },
      cancel: cancelled
    });
    const client = clientFor(() => new Response(body), 1024);
    const request = client.json("https://api.example/data", { signal: controller.signal });
    await reading.promise;
    await flushMicrotasks(8);

    controller.abort();

    await expect(request).rejects.toThrow("response body aborted");
    expect(cancelled).toHaveBeenCalledOnce();
  });
});

describe("BoundedHttpClient request cancellation", () => {
  it("propagates a caller abort to the initial fetch instead of waiting for the client timeout", async () => {
    const started = deferred<void>();
    const observedAbort = vi.fn();
    const fetchImpl = ((_input: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (!signal) return reject(new Error("Missing request signal."));
        const abort = () => {
          observedAbort();
          reject(signal.reason);
        };
        if (signal.aborted) abort();
        else signal.addEventListener("abort", abort, { once: true });
        started.resolve();
      })) as typeof fetch;
    const client = new BoundedHttpClient({ fetchImpl, publicUrlPolicy: publicPolicy, timeoutMs: 1_000 });
    const controller = new AbortController();
    const request = client.request("https://api.example/data", { signal: controller.signal });
    await started.promise;

    controller.abort(new Error("caller cancelled"));

    await expect(request).rejects.toMatchObject({ code: "REQUEST_ABORTED", message: "request aborted by caller" });
    expect(observedAbort).toHaveBeenCalledOnce();
  });

  it("bounds URL policy resolution with the same request deadline", async () => {
    const fetchImpl = vi.fn();
    const client = new BoundedHttpClient({
      fetchImpl,
      publicUrlPolicy: { assertPublicHttpUrl: () => new Promise<string>(() => undefined) },
      timeoutMs: 20
    });

    await expect(client.request("https://api.example/data")).rejects.toMatchObject({ code: "REQUEST_TIMEOUT" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("aborts URL policy resolution before any network request is issued", async () => {
    const fetchImpl = vi.fn();
    const client = new BoundedHttpClient({
      fetchImpl,
      publicUrlPolicy: { assertPublicHttpUrl: () => new Promise<string>(() => undefined) },
      timeoutMs: 1_000
    });
    const controller = new AbortController();
    const request = client.request("https://api.example/data", { signal: controller.signal });

    controller.abort();

    await expect(request).rejects.toMatchObject({ code: "REQUEST_ABORTED" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("BoundedHttpClient redirects", () => {
  it("preserves ordinary and credential headers on a same-origin redirect", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const client = clientFor(sequenceFetch(calls, [redirect(302, "/next"), jsonResponse("{}")]), 1024);

    await client.request("https://api.example/start", { headers: { Authorization: "Bearer secret", "X-Trace": "trace" } });

    const headers = new Headers(calls[1]?.init?.headers);
    expect(headers.get("authorization")).toBe("Bearer secret");
    expect(headers.get("x-trace")).toBe("trace");
  });

  it("strips credential headers after any cross-origin hop regardless of case", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const client = clientFor(sequenceFetch(calls, [redirect(302, "https://other.example/next"), jsonResponse("{}")]), 1024);

    await client.request("https://api.example/start", {
      headers: {
        AUTHORIZATION: "Bearer secret",
        "Proxy-Authorization": "proxy",
        Cookie: "session=secret",
        Cookie2: "legacy=secret",
        "X-API-Key": "api-secret",
        "X-Subscription-Token": "brave-secret",
        "X-Trace": "trace"
      }
    });

    const headers = new Headers(calls[1]?.init?.headers);
    for (const name of ["authorization", "proxy-authorization", "cookie", "cookie2", "x-api-key", "x-subscription-token"]) {
      expect(headers.has(name)).toBe(false);
    }
    expect(headers.get("x-trace")).toBe("trace");
  });

  it("keeps stripped credentials stripped after a cross-origin then same-origin redirect", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const client = clientFor(
      sequenceFetch(calls, [redirect(302, "https://other.example/one"), redirect(302, "https://other.example/two"), jsonResponse("{}")]),
      1024
    );

    await client.request("https://api.example/start", { headers: { Authorization: "Bearer secret" } });

    expect(new Headers(calls[1]?.init?.headers).has("authorization")).toBe(false);
    expect(new Headers(calls[2]?.init?.headers).has("authorization")).toBe(false);
  });

  it.each([
    [301, "POST", "GET", false],
    [302, "POST", "GET", false],
    [303, "PUT", "GET", false],
    [307, "POST", "POST", true],
    [308, "POST", "POST", true]
  ])("applies %i method and body semantics", async (status, method, expectedMethod, keepsBody) => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const client = clientFor(sequenceFetch(calls, [redirect(status, "/next"), jsonResponse("{}")]), 1024);

    await client.request("https://api.example/start", {
      method,
      body: "payload",
      headers: { "content-length": "7", "content-type": "text/plain" }
    });

    expect(calls[1]?.init?.method).toBe(expectedMethod);
    expect(calls[1]?.init?.body === undefined).toBe(!keepsBody);
    const headers = new Headers(calls[1]?.init?.headers);
    expect(headers.has("content-length")).toBe(keepsBody);
    expect(headers.has("content-type")).toBe(keepsBody);
  });

  it("blocks a credential-bearing body on a cross-origin 307/308 redirect", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const client = clientFor(sequenceFetch(calls, [redirect(307, "https://other.example/next")]), 1024);

    await expect(client.request("https://api.example/start", { method: "POST", body: '{"api_key":"secret"}' })).rejects.toThrow(
      "cross-origin redirect with a request body is not allowed"
    );
    expect(calls).toHaveLength(1);
  });

  it.each([300, 304, 305, 306])("does not follow unsupported redirect status %i", async (status) => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const client = clientFor(sequenceFetch(calls, [new Response(status === 304 ? null : "terminal", { status, headers: { location: "/next" } })]), 1024);

    const response = await client.request("https://api.example/start");

    expect(response.status).toBe(status);
    expect(calls).toHaveLength(1);
  });

  it("cancels a redirect response before issuing the next request", async () => {
    const cancelled = vi.fn();
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const first = new Response(pendingStream(cancelled), { status: 302, headers: { location: "/next" } });
    const client = clientFor(sequenceFetch(calls, [first, jsonResponse("{}")]), 1024);

    await client.request("https://api.example/start");

    expect(cancelled).toHaveBeenCalledOnce();
  });

  it("reports redirect loops and maximum redirect exhaustion deterministically", async () => {
    const loopClient = clientFor(() => redirect(302, "https://api.example/start"), 1024);
    await expect(loopClient.request("https://api.example/start")).rejects.toThrow("redirect loop detected");

    const maxClient = new BoundedHttpClient({
      fetchImpl: async () => redirect(302, "/next"),
      publicUrlPolicy: publicPolicy,
      maxBytes: 1024,
      maxRedirects: 0
    });
    await expect(maxClient.request("https://api.example/start")).rejects.toThrow("too many redirects");
  });
});

function clientFor(fetchImpl: typeof fetch, maxBytes: number): BoundedHttpClient {
  return new BoundedHttpClient({ fetchImpl, publicUrlPolicy: publicPolicy, maxBytes, timeoutMs: 1_000 });
}

function sequenceFetch(calls: Array<{ url: string; init?: RequestInit }>, responses: Response[]): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    const response = responses.shift();
    if (!response) throw new Error("Unexpected fetch call.");
    return response;
  }) as typeof fetch;
}

function redirect(status: number, location: string): Response {
  return new Response(null, { status, headers: { location } });
}

function jsonResponse(body: string): Response {
  return new Response(body, { headers: { "content-type": "application/json" } });
}

function streamBytes(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    }
  });
}

function pendingStream(cancelled: () => void): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("{"));
    },
    cancel: cancelled
  });
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function flushMicrotasks(count: number): Promise<void> {
  for (let index = 0; index < count; index += 1) await Promise.resolve();
}
