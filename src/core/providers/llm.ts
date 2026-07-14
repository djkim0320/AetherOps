import type { ZodType } from "zod";
import type { ContextProviderIdentity } from "../context/contextTypes.js";

export interface LlmJsonRequest<T = unknown> {
  system: string;
  user: string;
  schemaName: string;
  timeoutMs?: number;
  schema?: ZodType<T>;
  promptVersion?: string;
  schemaVersion?: string;
  invocationReceipt?: {
    /** Stable identity chosen by the caller before any provider side effect. */
    invocationId: string;
    /** Must durably commit before the provider process is spawned. */
    onRunning(metadata: LlmInvocationRunningMetadata): void | Promise<void>;
  };
}

export interface LlmInvocationRunningMetadata {
  invocationId: string;
  provider: string;
  model?: string;
  reasoningEffort?: string;
  schemaName: string;
  promptVersion: string;
  schemaVersion: string;
  promptHash: string;
  startedAt: string;
  status: "running";
}

export interface LlmInvocationMetadata {
  invocationId?: string;
  provider: string;
  model?: string;
  reasoningEffort?: string;
  schemaName: string;
  promptVersion: string;
  schemaVersion: string;
  promptHash?: string;
  responseHash?: string;
  contextPackId?: string;
  canonicalHash?: string;
  finalInputHash?: string;
  startedAt: string;
  completedAt: string;
  durationMs: number;
  /** Deterministic estimates. They are never presented as provider-reported token usage. */
  inputTokenEstimate: number;
  outputTokenEstimate: number;
  tokenEstimator: "utf8_bytes_div_4_ceil_v1";
  monetaryCostAvailability: "unavailable";
  repairCount: 0 | 1;
  status?: "completed" | "failed";
  validationErrors?: string[];
}

export interface LlmJsonCompletion<T> {
  value: T;
  metadata: LlmInvocationMetadata;
}

export interface DurableLlmInvocationObserver {
  onRunning(metadata: LlmInvocationRunningMetadata): void | Promise<void>;
  onTerminal(metadata: LlmInvocationMetadata): void | Promise<void>;
}

export function invocationMetadataFromError(error: unknown): LlmInvocationMetadata | undefined {
  if (!error || typeof error !== "object" || !("llmInvocationMetadata" in error)) return undefined;
  return (error as { llmInvocationMetadata?: LlmInvocationMetadata }).llmInvocationMetadata;
}

export interface LlmProvider {
  readonly name: string;
  isAvailable(): Promise<boolean>;
  contextIdentity?(): Promise<ContextProviderIdentity>;
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
      inputTokenEstimate: estimateUtf8Tokens(`${request.system}\n${request.user}`),
      outputTokenEstimate: estimateUtf8Tokens(JSON.stringify(value)),
      tokenEstimator: "utf8_bytes_div_4_ceil_v1",
      monetaryCostAvailability: "unavailable",
      repairCount: 0
    }
  };
}

export async function completeDurableJson<T>(
  provider: LlmProvider,
  request: LlmJsonRequest<T>,
  invocationId: string,
  observer: DurableLlmInvocationObserver
): Promise<LlmJsonCompletion<T>> {
  if (!provider.completeJsonWithMetadata) {
    throw new Error(`LLM provider ${provider.name} does not support durable invocation metadata; execution is NOT_READY.`);
  }
  let runningCommitted = false;
  const observedRequest: LlmJsonRequest<T> = {
    ...request,
    invocationReceipt: {
      invocationId,
      onRunning: async (metadata) => {
        await observer.onRunning(metadata);
        runningCommitted = true;
      }
    }
  };
  let completion: LlmJsonCompletion<T>;
  try {
    completion = await provider.completeJsonWithMetadata(observedRequest);
  } catch (error) {
    const metadata = invocationMetadataFromError(error);
    if (runningCommitted && metadata) await observer.onTerminal({ ...metadata, invocationId: metadata.invocationId ?? invocationId });
    throw error;
  }
  if (!runningCommitted) {
    throw new Error(`LLM provider ${provider.name} returned without committing its pre-spawn running receipt; execution is NOT_READY.`);
  }
  const metadata = { ...completion.metadata, invocationId: completion.metadata.invocationId ?? invocationId };
  await observer.onTerminal(metadata);
  return { value: completion.value, metadata };
}

export function estimateUtf8Tokens(value: string): number {
  return Math.ceil(new TextEncoder().encode(value).byteLength / 4);
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
