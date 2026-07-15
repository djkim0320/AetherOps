export type BoundedHttpErrorCode =
  | "REQUEST_TIMEOUT"
  | "REQUEST_ABORTED"
  | "RESPONSE_TOO_LARGE"
  | "RESPONSE_BODY_TIMEOUT"
  | "RESPONSE_ABORTED"
  | "INVALID_UTF8"
  | "EMPTY_JSON"
  | "INVALID_JSON"
  | "REDIRECT_MISSING_LOCATION"
  | "REDIRECT_BODY_BLOCKED"
  | "REDIRECT_LOOP"
  | "TOO_MANY_REDIRECTS";

export class BoundedHttpError extends Error {
  constructor(
    readonly code: BoundedHttpErrorCode,
    message: string,
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = "BoundedHttpError";
  }
}

export async function readLimitedBytes(
  response: Response,
  safeUrl: string,
  maxBytes: number,
  deadline: number,
  signal: AbortSignal,
  externalSignal?: AbortSignal | null
): Promise<Uint8Array> {
  const contentLength = Number(response.headers.get("content-length") ?? "0");
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    await cancelResponseBody(response);
    throw new BoundedHttpError("RESPONSE_TOO_LARGE", `content-length exceeds ${formatBytes(maxBytes)} for ${safeUrl}`);
  }
  if (!response.body) return new Uint8Array();

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const readResult = await withDeadlineAndSignal(reader.read(), deadline, signal, externalSignal);
      if (readResult.done) break;
      total += readResult.value.byteLength;
      if (total > maxBytes) {
        throw new BoundedHttpError("RESPONSE_TOO_LARGE", `body exceeds ${formatBytes(maxBytes)} for ${safeUrl}`);
      }
      chunks.push(readResult.value);
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    // Some injected stream readers used by adapters expose only read/cancel.
    // Cleanup must never replace the original transport or limit error.
    const releaseLock = (reader as ReadableStreamDefaultReader<Uint8Array> & { releaseLock?: () => void }).releaseLock;
    releaseLock?.call(reader);
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

export function parseJsonBytes<T>(bytes: Uint8Array): T {
  if (bytes.byteLength === 0) throw new BoundedHttpError("EMPTY_JSON", "empty JSON response body");
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) {
    throw new BoundedHttpError("INVALID_UTF8", "invalid UTF-8 response body", { cause: error });
  }
  if (!text.trim()) throw new BoundedHttpError("EMPTY_JSON", "empty JSON response body");
  try {
    return JSON.parse(text) as T;
  } catch (error) {
    throw new BoundedHttpError("INVALID_JSON", "invalid JSON response", { cause: error });
  }
}

export async function cancelResponseBody(response: Response): Promise<void> {
  await response.body?.cancel().catch(() => undefined);
}

function formatBytes(value: number): string {
  if (value >= 1024 * 1024) return `${Math.round(value / (1024 * 1024))}MB`;
  if (value >= 1024) return `${Math.round(value / 1024)}KB`;
  return `${value} bytes`;
}

function withDeadlineAndSignal<T>(promise: Promise<T>, deadline: number, signal: AbortSignal, externalSignal?: AbortSignal | null): Promise<T> {
  const remaining = deadline - Date.now();
  if (remaining <= 0) return Promise.reject(new BoundedHttpError("RESPONSE_BODY_TIMEOUT", "body read timeout"));
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let removeAbortListener: (() => void) | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => reject(new BoundedHttpError("RESPONSE_BODY_TIMEOUT", "body read timeout")), remaining);
  });
  const abortPromise = new Promise<never>((_, reject) => {
    const abort = () =>
      reject(
        externalSignal?.aborted
          ? new BoundedHttpError("RESPONSE_ABORTED", "response body aborted")
          : new BoundedHttpError("RESPONSE_BODY_TIMEOUT", "body read timeout")
      );
    if (signal.aborted) abort();
    else {
      signal.addEventListener("abort", abort, { once: true });
      removeAbortListener = () => signal.removeEventListener("abort", abort);
    }
  });
  return Promise.race([promise, timeoutPromise, abortPromise]).finally(() => {
    if (timeout) clearTimeout(timeout);
    removeAbortListener?.();
  });
}
