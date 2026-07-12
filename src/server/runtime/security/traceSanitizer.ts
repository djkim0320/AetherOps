const SECRET_KEY = /(?:authorization|cookie|password|secret|token|api.?key|cipher|prompt|response|stdout|stderr)/i;

export function redactTraceText(value: string | undefined): string | undefined {
  if (!value) return undefined;
  return value
    .replace(/Bearer\s+[A-Za-z0-9._~+/-]+=*/gi, "Bearer [redacted]")
    .replace(/(?:sk|sess)-[A-Za-z0-9_-]{12,}/g, "[redacted]")
    .replace(/((?:api[_-]?key|token|secret|password)=)[^&\s]+/gi, "$1[redacted]")
    .slice(0, 4_000);
}

export function safeTraceUrl(value: string): string {
  try {
    const url = new URL(value);
    url.username = "";
    url.password = "";
    url.hash = "";
    for (const key of [...url.searchParams.keys()]) if (SECRET_KEY.test(key)) url.searchParams.set(key, "[redacted]");
    return url.toString();
  } catch {
    return "https://invalid.local/redacted";
  }
}

export function sanitizeTraceRecord(value: unknown): Record<string, unknown> {
  const sanitized = sanitizeTraceValue(value);
  return sanitized && typeof sanitized === "object" && !Array.isArray(sanitized) ? (sanitized as Record<string, unknown>) : {};
}

export function sanitizeTraceValue(value: unknown, key = "", depth = 0): unknown {
  if (SECRET_KEY.test(key)) return "[redacted]";
  if (depth > 6) return "[truncated]";
  if (typeof value === "string") return sanitizeString(value);
  if (value === null || typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.slice(0, 100).map((item) => sanitizeTraceValue(item, key, depth + 1));
  if (!value || typeof value !== "object") return String(value ?? "");
  const output: Record<string, unknown> = {};
  for (const [entryKey, entryValue] of Object.entries(value).slice(0, 100)) {
    output[entryKey] = sanitizeTraceValue(entryValue, entryKey, depth + 1);
  }
  return output;
}

function sanitizeString(value: string): string {
  const trimmed = value.slice(0, 4_000);
  if (/^https?:\/\//i.test(trimmed)) return safeTraceUrl(trimmed);
  return redactTraceText(trimmed) ?? "";
}
