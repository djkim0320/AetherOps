const SECRET_KEY = /(?:authorization|api[-_]?key|cookie|oauth|password|prompt(?:Text|Raw)?|secret|token)/i;
const SAFE_PROMPT_KEY = /^(?:promptHash|promptVersion)$/i;
const SECRET_TEXT = /(?:bearer\s+[a-z0-9._~+/=-]+|sk-[a-z0-9_-]{8,}|gh[oprsu]_[a-z0-9_]{12,})/gi;

export function sanitizeAutonomyArtifact(value) {
  return sanitizeValue(value, new WeakSet());
}

function sanitizeValue(value, seen) {
  if (typeof value === "string") return sanitizeString(value);
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value)) return "[CIRCULAR]";
  seen.add(value);
  if (Array.isArray(value)) return value.map((entry) => sanitizeValue(entry, seen));
  const output = {};
  for (const [key, entry] of Object.entries(value)) {
    output[key] = SECRET_KEY.test(key) && !SAFE_PROMPT_KEY.test(key) ? "[REDACTED]" : sanitizeValue(entry, seen);
  }
  return output;
}

function sanitizeString(value) {
  const redacted = value.replace(SECRET_TEXT, "[REDACTED]");
  if (!/^https?:\/\//i.test(redacted)) return redacted;
  try {
    const url = new URL(redacted);
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return redacted;
  }
}

export function assertSanitizedArtifact(value) {
  const encoded = JSON.stringify(value);
  const leaked = encoded.match(SECRET_TEXT);
  if (leaked) throw new Error("Sanitized autonomy artifact still contains a credential-like value.");
}
