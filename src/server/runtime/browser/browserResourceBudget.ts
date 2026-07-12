export const DEFAULT_BROWSER_RESOURCE_BUDGET = Object.freeze({
  maxTextCharacters: 20_000,
  maxScreenshotBytes: 4 * 1024 * 1024,
  maxAggregateCaptureBytes: 8 * 1024 * 1024
});

export class BrowserResourceLimitError extends Error {
  readonly code = "BROWSER_RESOURCE_LIMIT";

  constructor(message: string) {
    super(message);
    this.name = "BrowserResourceLimitError";
  }
}

export function enforceCaptureBudget(kind: string, captureBytes: number, perCaptureLimit: number, aggregateLimit: number, consumedBytes: number): number {
  if (captureBytes > perCaptureLimit) {
    throw new BrowserResourceLimitError(`${kind} exceeded its byte limit.`);
  }
  const next = consumedBytes + captureBytes;
  if (next > aggregateLimit) {
    throw new BrowserResourceLimitError(`Browser aggregate capture byte limit was exceeded.`);
  }
  return next;
}

export interface BoundedPageText {
  text: string;
  truncated: boolean;
}

export function collectBoundedPageText(body: HTMLElement, maxCharacters: number): BoundedPageText {
  const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT);
  const parts: string[] = [];
  let length = 0;
  let node = walker.nextNode();
  while (node) {
    const value = node.textContent ?? "";
    const remaining = maxCharacters + 1 - length;
    if (remaining <= 0) break;
    const part = value.slice(0, remaining);
    parts.push(part);
    length += part.length;
    if (length > maxCharacters) break;
    node = walker.nextNode();
  }
  return { text: parts.join(""), truncated: length > maxCharacters || node !== null };
}
