const SECRET_KEY = /(?:authorization|cookie|password|secret|token|api.?key|cipher|prompt|response|stdout|stderr)/i;
const SECRET_QUERY_KEY = /(?:^|[-_.])(?:authorization|auth|code|cookie|credential|password|secret|session|sig|signature|token|api.?key|cipher)(?:$|[-_.])/i;
const TRACE_TEXT_LIMIT = 4_000;
const TRACE_URL_LIMIT = 1_024;
const SANITIZED_STRING_LIMIT = 512;
const SANITIZED_NODE_LIMIT = 64;
const SANITIZED_ENTRY_LIMIT = 40;
const SANITIZED_ARRAY_LIMIT = 20;
const SANITIZED_DEPTH_LIMIT = 5;
const TRUNCATED = "[truncated]";

export function redactTraceText(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const redacted = truncateText(value, TRACE_TEXT_LIMIT * 2)
    .replace(/Authorization\s*:\s*(?:Basic|Bearer)\s+[^\s,;]+/gi, "Authorization: [redacted]")
    .replace(/Cookie\s*:\s*[^\r\n]+/gi, "Cookie: [redacted]")
    .replace(/Bearer\s+[A-Za-z0-9._~+/-]+=*/gi, "Bearer [redacted]")
    .replace(/(?:sk|sess)-[A-Za-z0-9_-]{12,}/g, "[redacted]")
    .replace(/((?:api[_-]?key|token|secret|password)\s*[:=]\s*)[^&\s]+/gi, "$1[redacted]")
    .replace(/((?:provider\s+response|prompt|stdout|stderr)\s*:\s*)[^\r\n]*/gi, "$1[redacted]")
    .replace(/\b[A-Za-z]:\\[^\r\n"',;<>|]*/gu, "[path]")
    .replace(/(^|[\s(=])\/(?:Users|home|tmp|var\/tmp|private\/tmp)\/[^\r\n"',;<>]*/gimu, "$1[path]")
    .replace(/\b[A-Za-z]:\\(?:[^\\\s]+\\)*[^\\\s]+/g, "[path]")
    .replace(/(?:\/[A-Za-z0-9._-]+){2,}/g, "[path]");
  return truncateText(redacted, TRACE_TEXT_LIMIT);
}

export function boundedTraceText(value: string | undefined, maxLength = 1_000): string | undefined {
  const redacted = redactTraceText(value);
  return redacted === undefined ? undefined : truncateText(redacted, maxLength);
}

export function safeTraceUrl(value: string): string {
  try {
    if (value.length > 65_536) return "https://trace.invalid/truncated?reason=url_length";
    const url = new URL(value);
    url.username = "";
    url.password = "";
    url.hash = "";
    for (const [key, parameter] of [...url.searchParams.entries()]) {
      if (SECRET_QUERY_KEY.test(key) || secretQueryValue(parameter)) url.searchParams.set(key, "[redacted]");
    }
    const rendered = url.toString();
    if (rendered.length <= TRACE_URL_LIMIT) return rendered;
    url.search = "";
    url.searchParams.set("__trace_truncated", "query");
    const withoutQuery = url.toString();
    if (withoutQuery.length <= TRACE_URL_LIMIT) return withoutQuery;
    return url.origin === "null" ? "https://invalid.local/redacted" : `${url.origin}/trace-truncated`;
  } catch {
    return "https://invalid.local/redacted";
  }
}

export function sanitizeTraceRecord(value: unknown): Record<string, unknown> {
  const sanitized = sanitizeTraceValueWithBudget(value, "", 0, { nodes: 0 });
  return sanitized && typeof sanitized === "object" && !Array.isArray(sanitized) ? (sanitized as Record<string, unknown>) : {};
}

export function sanitizeTraceValue(value: unknown, key = "", depth = 0): unknown {
  return sanitizeTraceValueWithBudget(value, key, depth, { nodes: 0 });
}

function sanitizeTraceValueWithBudget(value: unknown, key: string, depth: number, budget: { nodes: number }): unknown {
  if (SECRET_KEY.test(key)) return "[redacted]";
  budget.nodes += 1;
  if (budget.nodes > SANITIZED_NODE_LIMIT || depth > SANITIZED_DEPTH_LIMIT) return TRUNCATED;
  if (typeof value === "string") return sanitizeString(value);
  if (value === null || typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) {
    const output = value.slice(0, SANITIZED_ARRAY_LIMIT).map((item) => sanitizeTraceValueWithBudget(item, key, depth + 1, budget));
    if (value.length > SANITIZED_ARRAY_LIMIT) output.push(`[truncated ${value.length - SANITIZED_ARRAY_LIMIT} items]`);
    return output;
  }
  if (!value || typeof value !== "object") return String(value ?? "");
  const output: Record<string, unknown> = {};
  const entries = Object.entries(value);
  for (const [entryKey, entryValue] of entries.slice(0, SANITIZED_ENTRY_LIMIT)) {
    output[entryKey] = sanitizeTraceValueWithBudget(entryValue, entryKey, depth + 1, budget);
  }
  if (entries.length > SANITIZED_ENTRY_LIMIT) output.__traceTruncated = entries.length - SANITIZED_ENTRY_LIMIT;
  return output;
}

function sanitizeString(value: string): string {
  const trimmed = truncateText(value, SANITIZED_STRING_LIMIT);
  if (/^https?:\/\//i.test(trimmed)) return safeTraceUrl(trimmed);
  return redactTraceText(trimmed) ?? "";
}

function secretQueryValue(value: string): boolean {
  return (
    /^(?:Basic|Bearer)\s+/i.test(value) ||
    /^(?:sk|sess)-[A-Za-z0-9_-]{12,}$/i.test(value) ||
    /^eyJ[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{8,}/.test(value) ||
    /(?:token|secret|credential|signature)\s*[:=]/i.test(value)
  );
}

function truncateText(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  if (maxLength <= TRUNCATED.length) return TRUNCATED.slice(0, maxLength);
  return `${value.slice(0, maxLength - TRUNCATED.length)}${TRUNCATED}`;
}
