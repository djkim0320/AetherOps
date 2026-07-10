export interface LlmJsonRequest {
  system: string;
  user: string;
  schemaName: string;
  timeoutMs?: number;
}

export interface LlmProvider {
  readonly name: string;
  isAvailable(): Promise<boolean>;
  completeJson<T>(request: LlmJsonRequest): Promise<T>;
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
