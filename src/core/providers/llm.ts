import type { ZodType } from "zod";

export interface LlmJsonRequest<T = unknown> {
  system: string;
  user: string;
  schemaName: string;
  timeoutMs?: number;
  schema?: ZodType<T>;
  promptVersion?: string;
  schemaVersion?: string;
}

export interface LlmInvocationMetadata {
  provider: string;
  model?: string;
  reasoningEffort?: string;
  schemaName: string;
  promptVersion: string;
  schemaVersion: string;
  promptHash?: string;
  responseHash?: string;
  startedAt: string;
  completedAt: string;
  durationMs: number;
  repairCount: 0 | 1;
  status?: "completed" | "failed";
  validationErrors?: string[];
}

export interface LlmJsonCompletion<T> {
  value: T;
  metadata: LlmInvocationMetadata;
}

export function invocationMetadataFromError(error: unknown): LlmInvocationMetadata | undefined {
  if (!error || typeof error !== "object" || !("llmInvocationMetadata" in error)) return undefined;
  return (error as { llmInvocationMetadata?: LlmInvocationMetadata }).llmInvocationMetadata;
}

export interface LlmProvider {
  readonly name: string;
  isAvailable(): Promise<boolean>;
  completeJson<T>(request: LlmJsonRequest<T>): Promise<T>;
  completeJsonWithMetadata?<T>(request: LlmJsonRequest<T>): Promise<LlmJsonCompletion<T>>;
}

export async function completeValidatedJson<T>(provider: LlmProvider, request: LlmJsonRequest<T> & { schema: ZodType<T> }): Promise<LlmJsonCompletion<T>> {
  if (provider.completeJsonWithMetadata) return provider.completeJsonWithMetadata(request);
  const startedAt = new Date().toISOString();
  const start = Date.now();
  const value = request.schema.parse(await provider.completeJson(request));
  const completedAt = new Date().toISOString();
  return {
    value,
    metadata: {
      provider: provider.name,
      schemaName: request.schemaName,
      promptVersion: request.promptVersion ?? "unspecified",
      schemaVersion: request.schemaVersion ?? request.schemaName,
      startedAt,
      completedAt,
      durationMs: Date.now() - start,
      repairCount: 0
    }
  };
}

export class LlmTimeoutError extends Error {
  constructor(
    message: string,
    readonly metadata: {
      provider: string;
      model?: string;
      timeoutMs: number;
      promptLength: number;
      promptTokenEstimate: number;
      retryAttempt: number;
      step?: string;
      schemaName?: string;
    }
  ) {
    super(message);
    this.name = "LlmTimeoutError";
  }
}

export class LlmAccessUnavailableError extends Error {
  readonly code = "LLM_ACCESS_UNAVAILABLE";

  constructor(
    message: string,
    readonly provider: string,
    readonly model: string,
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = "LlmAccessUnavailableError";
  }
}

export function extractJsonObject(text: string): unknown {
  const trimmed = text.trim();
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
    return JSON.parse(trimmed);
  }

  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]) {
    return JSON.parse(fenced[1].trim());
  }

  const first = trimmed.indexOf("{");
  const last = trimmed.lastIndexOf("}");
  if (first >= 0 && last > first) {
    return JSON.parse(trimmed.slice(first, last + 1));
  }

  throw new Error("LLM response did not contain a JSON object.");
}
