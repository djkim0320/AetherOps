import { afterEach, describe, expect, it } from "vitest";
import { ApiEmbeddingProvider, EmbeddingProviderError, LocalHashEmbeddingProvider } from "./embeddingProvider.js";

const originalFetch = globalThis.fetch;

describe("EmbeddingProvider", () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("uses local hash only when local provider is explicitly selected", async () => {
    const embedding = await new LocalHashEmbeddingProvider(12).embed("urban heat island mitigation");

    expect(embedding).toHaveLength(12);
    expect(embedding.some((value) => value > 0)).toBe(true);
  });

  it("throws when an API embedding provider has no key", async () => {
    const provider = new ApiEmbeddingProvider({
      provider: "openai",
      model: "text-embedding-3-small",
      dimensions: 64
    });

    await expect(provider.embed("test")).rejects.toThrow(EmbeddingProviderError);
    await expect(provider.embed("test")).rejects.toThrow("API key is not configured");
  });

  it("throws instead of silently falling back when the API request fails", async () => {
    globalThis.fetch = (async () =>
      new Response("invalid key", {
        status: 401,
        statusText: "Unauthorized"
      })) as typeof fetch;

    const provider = new ApiEmbeddingProvider({
      provider: "openai",
      model: "text-embedding-3-small",
      apiKey: "bad-key",
      dimensions: 64
    });

    await expect(provider.embed("test")).rejects.toThrow("401 Unauthorized");
  });

  it("returns the API embedding vector when the request succeeds", async () => {
    globalThis.fetch = (async () =>
      Response.json({
        data: [{ embedding: [3, 4] }]
      })) as typeof fetch;

    const provider = new ApiEmbeddingProvider({
      provider: "openai",
      model: "text-embedding-3-small",
      apiKey: "test-key",
      dimensions: 2
    });

    await expect(provider.embed("test")).resolves.toEqual([0.6, 0.8]);
  });
});
