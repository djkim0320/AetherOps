import { describe, expect, it, vi } from "vitest";
import { fetchBingRssLinks, parseRssLinks } from "./browserRssDiscovery.js";

const publicPolicy = { assertPublicHttpUrl: async (value: string) => new URL(value).toString() };

describe("browser RSS discovery", () => {
  it("reads bounded UTF-8 RSS and decodes link entities", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response("<rss><channel><link>https://www.bing.com/</link><item><link>https://example.test/paper?a=1&amp;b=2</link></item></channel></rss>")
    ) as typeof fetch;

    const links = await fetchBingRssLinks("aerospace verification", { timeoutMs: 1_000, publicUrlPolicy: publicPolicy, fetchImpl });

    expect(links).toEqual(["https://www.bing.com/", "https://example.test/paper?a=1&b=2"]);
    expect(new Headers(fetchImpl.mock.calls[0]?.[1]?.headers).get("accept")).toContain("application/rss+xml");
  });

  it("rejects non-success responses instead of silently returning no results", async () => {
    const fetchImpl = vi.fn(async () => new Response("unavailable", { status: 503 })) as typeof fetch;

    await expect(fetchBingRssLinks("aerospace", { timeoutMs: 1_000, publicUrlPolicy: publicPolicy, fetchImpl })).rejects.toThrow("HTTP 503");
  });

  it("propagates cancellation through the bounded HTTP client", async () => {
    const controller = new AbortController();
    const fetchImpl = ((_input: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
      })) as typeof fetch;
    const request = fetchBingRssLinks("aerospace", {
      timeoutMs: 1_000,
      signal: controller.signal,
      publicUrlPolicy: publicPolicy,
      fetchImpl
    });

    controller.abort();

    await expect(request).rejects.toMatchObject({ code: "REQUEST_ABORTED" });
  });

  it("rejects invalid UTF-8 without replacement decoding", () => {
    expect(() => parseRssLinks(Uint8Array.from([0x3c, 0xff, 0x3e]))).toThrow("invalid UTF-8");
  });
});
