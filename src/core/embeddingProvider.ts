import { tokenize } from "./chunking.js";
import type { EmbeddingSettings } from "./types.js";

export interface EmbeddingProvider {
  embed(text: string): Promise<number[]>;
}

export class EmbeddingProviderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EmbeddingProviderError";
  }
}

export class LocalHashEmbeddingProvider implements EmbeddingProvider {
  constructor(private readonly dimensions = 96) {}

  async embed(text: string): Promise<number[]> {
    const vector = new Array(this.dimensions).fill(0);
    for (const token of tokenize(text)) {
      const hash = hashToken(token);
      const index = hash % this.dimensions;
      vector[index] += 1 + (token.length % 7) / 10;
    }
    return normalize(vector);
  }
}

export class ApiEmbeddingProvider implements EmbeddingProvider {
  private readonly localProvider: LocalHashEmbeddingProvider;

  constructor(private readonly settings: EmbeddingSettings) {
    this.localProvider = new LocalHashEmbeddingProvider(settings.dimensions);
  }

  async embed(text: string): Promise<number[]> {
    if (this.settings.provider === "local") {
      return this.localProvider.embed(text);
    }

    if (!this.settings.apiKey) {
      throw new EmbeddingProviderError(`${this.settings.provider} embedding API key is not configured.`);
    }

    try {
      if (this.settings.provider === "google") {
        return this.embedWithGoogle(text);
      }
      const endpoint = this.endpoint();
      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.settings.apiKey}`
        },
        body: JSON.stringify({
          model: this.settings.model || "text-embedding-3-small",
          input: text.slice(0, 8000),
          ...(this.settings.dimensions ? { dimensions: this.settings.dimensions } : {})
        })
      });
      if (!response.ok) {
        throw new EmbeddingProviderError(
          `${this.settings.provider} embedding request failed (${response.status} ${response.statusText}) at ${endpoint}: ${await response.text()}`
        );
      }
      const parsed = (await response.json()) as { data?: Array<{ embedding?: number[] }> };
      if (!parsed.data?.[0]?.embedding?.length) {
        throw new EmbeddingProviderError(`${this.settings.provider} embedding response did not include an embedding vector.`);
      }
      return normalize(parsed.data[0].embedding);
    } catch (error) {
      if (error instanceof EmbeddingProviderError) {
        throw error;
      }
      throw new EmbeddingProviderError(`${this.settings.provider} embedding request failed: ${formatError(error)}`);
    }
  }

  private endpoint(): string {
    if (this.settings.baseUrl) {
      return `${this.settings.baseUrl.replace(/\/$/, "")}/embeddings`;
    }
    if (this.settings.provider === "custom") {
      throw new EmbeddingProviderError("custom embedding provider requires baseUrl.");
    }
    return "https://api.openai.com/v1/embeddings";
  }

  private async embedWithGoogle(text: string): Promise<number[]> {
    const model = this.settings.model || "gemini-embedding-001";
    const endpoint =
      this.settings.baseUrl?.replace(/\/$/, "") ||
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:embedContent`;
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-goog-api-key": this.settings.apiKey ?? ""
      },
      body: JSON.stringify({
        model: `models/${model}`,
        content: {
          parts: [{ text: text.slice(0, 8000) }]
        },
        outputDimensionality: this.settings.dimensions
      })
    });
    if (!response.ok) {
      throw new EmbeddingProviderError(`google embedding request failed (${response.status} ${response.statusText}) at ${endpoint}: ${await response.text()}`);
    }
    const parsed = (await response.json()) as { embedding?: { values?: number[] } };
    if (!parsed.embedding?.values?.length) {
      throw new EmbeddingProviderError("google embedding response did not include an embedding vector.");
    }
    return normalize(parsed.embedding.values);
  }
}

export function cosineSimilarity(left: number[], right: number[]): number {
  const length = Math.min(left.length, right.length);
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < length; index += 1) {
    dot += left[index] * right[index];
    leftNorm += left[index] * left[index];
    rightNorm += right[index] * right[index];
  }
  if (!leftNorm || !rightNorm) {
    return 0;
  }
  return dot / (Math.sqrt(leftNorm) * Math.sqrt(rightNorm));
}

function hashToken(token: string): number {
  let hash = 2166136261;
  for (let index = 0; index < token.length; index += 1) {
    hash ^= token.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function normalize(vector: number[]): number[] {
  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
  if (!norm) {
    return vector;
  }
  return vector.map((value) => Number((value / norm).toFixed(8)));
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
