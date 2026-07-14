const SECRET_KEY =
  /(?:authorization|api[-_]?key|cookie|oauth|password|prompt(?:Text|Raw)?|secret|token|stdout|stderr|providerResponse|rawResponse|reasoning|chainOfThought|absolutePath|workingDirectory|cwd)/i;
const SAFE_HASH_KEY = /^(?:promptHash|responseHash|stdoutHash|stderrHash|outputHash|traceHash)$/i;
const SAFE_VERSION_KEY = /^promptVersion$/i;
const SAFE_NUMERIC_METADATA_KEY = /^(?:inputTokens|outputTokens|contextTokens|totalToolOutputBytes|maxInputTokens|maxOutputTokens|tokenUsage)$/i;
const SAFE_ENUM_METADATA_KEY = /^reasoningEffort$/i;
const SAFE_AUTHORIZATION_RECEIPT_KEY = /^authorizationReceipt$/i;
const SHA256 = /^[a-f0-9]{64}$/i;
const STABLE_VERSION = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,159}$/;
const RECEIPT_ID = /^receipt-[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/;
const REASONING_EFFORT = /^(?:low|medium|high|xhigh|max)$/;
const SECRET_TEXT = /(?:bearer\s+[a-z0-9._~+/=-]+|basic\s+[a-z0-9+/=]{4,}|sk-[a-z0-9_-]{8,}|gh[oprsu]_[a-z0-9_]{12,})/gi;
const JWT_TEXT = /\beyJ[a-z0-9_-]+\.[a-z0-9_-]+\.[a-z0-9_-]+\b/gi;
const KNOWN_TOKEN_TEXT = /(?:glpat-[a-z0-9_-]{10,}|AKIA[0-9A-Z]{16}|xox[baprs]-[a-z0-9-]{10,}|AIza[a-z0-9_-]{20,})/gi;
const PEM_PRIVATE_KEY = /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g;
const EMBEDDED_URL = /https?:\/\/[^\s<>"'`]+/gi;
const LABELED_SECRET =
  /((?:authorization|analysis|reasoning|chain[- ]?of[- ]?thought|provider(?:\s+raw)?\s+response|raw\s+response|stdout|stderr|prompt(?:\s+(?:text|raw))?)\s*[:=]\s*)([^\r\n]*)/gi;
const ASSIGNED_SECRET =
  /\b((?:(?:[a-z0-9]+)[-_])*(?:api[-_]?key|access[-_]?token|refresh[-_]?token|token|session(?:[-_]?token|id)?|cookie|oauth|password|secret|secret[-_]?access[-_]?key|access[-_]?key[-_]?id|client[-_]?secret|private[-_]?key)\s*[:=]\s*)(?!\[REDACTED\])[^\s,;]+/gi;
const WINDOWS_ABSOLUTE_PATH = /(^|[\s"'(])([A-Za-z]:[\\/](?:[^\s"'`<>|]+[\\/]?)+)/gm;
const WINDOWS_UNC_PATH = /\\\\[^\\\s"'`]+\\[^\\\s"'`]+(?:\\[^\\\s"'`]*)*/g;
const POSIX_PRIVATE_PATH = /(^|[\s"'(])\/(?:Users|home|tmp|var\/tmp)\/[^\s"'`]*/gm;

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
    output[key] = sanitizeEntry(key, entry, seen);
  }
  return output;
}

function sanitizeEntry(key, entry, seen) {
  if (SAFE_HASH_KEY.test(key)) return typeof entry === "string" && SHA256.test(entry) ? entry.toLowerCase() : "[REDACTED]";
  if (SAFE_VERSION_KEY.test(key)) return typeof entry === "string" && STABLE_VERSION.test(entry) ? entry : "[REDACTED]";
  if (SAFE_NUMERIC_METADATA_KEY.test(key)) return sanitizeNumericMetadata(entry);
  if (SAFE_ENUM_METADATA_KEY.test(key)) return typeof entry === "string" && REASONING_EFFORT.test(entry) ? entry : "[REDACTED]";
  if (SAFE_AUTHORIZATION_RECEIPT_KEY.test(key)) return sanitizeAuthorizationReceipt(entry);
  return SECRET_KEY.test(key) ? "[REDACTED]" : sanitizeValue(entry, seen);
}

function sanitizeNumericMetadata(entry) {
  if (typeof entry === "number") return Number.isFinite(entry) && entry >= 0 ? entry : "[REDACTED]";
  if (!isPlainObject(entry) || !hasOnlyKeys(entry, ["value", "unit", "sampleCount", "unmeasuredReason", "reason", "originReceiptIds"])) return "[REDACTED]";
  if (!Object.hasOwn(entry, "value") || !Object.hasOwn(entry, "unit")) return "[REDACTED]";
  const validValue = entry.value === null || (typeof entry.value === "number" && Number.isFinite(entry.value) && entry.value >= 0);
  const validUnit = typeof entry.unit === "string" && STABLE_VERSION.test(entry.unit);
  const validSampleCount = !Object.hasOwn(entry, "sampleCount") || (Number.isSafeInteger(entry.sampleCount) && entry.sampleCount > 0);
  const hasBothReasonKeys = Object.hasOwn(entry, "unmeasuredReason") && Object.hasOwn(entry, "reason");
  const reasonKey = Object.hasOwn(entry, "unmeasuredReason") ? "unmeasuredReason" : Object.hasOwn(entry, "reason") ? "reason" : undefined;
  const reason = reasonKey ? entry[reasonKey] : undefined;
  const hasReason = typeof reason === "string" && reason.trim().length > 0 && reason.length <= 2_000;
  const receiptIds = Object.hasOwn(entry, "originReceiptIds") ? entry.originReceiptIds : undefined;
  const validReceiptIds =
    receiptIds === undefined ||
    (entry.value !== null &&
      Array.isArray(receiptIds) &&
      receiptIds.length > 0 &&
      receiptIds.length <= 256 &&
      receiptIds.every((receiptId) => typeof receiptId === "string" && RECEIPT_ID.test(receiptId) && sanitizeString(receiptId) === receiptId) &&
      new Set(receiptIds).size === receiptIds.length);
  if (
    !validValue ||
    !validUnit ||
    !validSampleCount ||
    (entry.value === null && Object.hasOwn(entry, "sampleCount")) ||
    !validReceiptIds ||
    hasBothReasonKeys ||
    (entry.value === null ? !hasReason : reasonKey !== undefined)
  )
    return "[REDACTED]";
  return {
    value: entry.value,
    unit: entry.unit,
    ...(Object.hasOwn(entry, "sampleCount") ? { sampleCount: entry.sampleCount } : {}),
    ...(receiptIds ? { originReceiptIds: [...receiptIds] } : {}),
    ...(hasReason && reasonKey ? { [reasonKey]: sanitizeString(reason) } : {})
  };
}

function sanitizeAuthorizationReceipt(entry) {
  if (!isPlainObject(entry) || !hasOnlyKeys(entry, ["requestedProjectId", "decision", "policyHash"])) return "[REDACTED]";
  if (!["requestedProjectId", "decision", "policyHash"].every((key) => Object.hasOwn(entry, key))) return "[REDACTED]";
  if (typeof entry.requestedProjectId !== "string" || !STABLE_VERSION.test(entry.requestedProjectId)) return "[REDACTED]";
  if (entry.decision !== "allowed" && entry.decision !== "denied") return "[REDACTED]";
  if (typeof entry.policyHash !== "string" || !SHA256.test(entry.policyHash)) return "[REDACTED]";
  return { requestedProjectId: entry.requestedProjectId, decision: entry.decision, policyHash: entry.policyHash.toLowerCase() };
}

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

function hasOnlyKeys(value, allowed) {
  const keys = Object.keys(value);
  return keys.length === allowed.filter((key) => Object.hasOwn(value, key)).length && keys.every((key) => allowed.includes(key));
}

function sanitizeString(value) {
  const redacted = value
    .replace(PEM_PRIVATE_KEY, "[REDACTED_PRIVATE_KEY]")
    .replace(EMBEDDED_URL, sanitizeUrl)
    .replace(LABELED_SECRET, sanitizeLabeledSecret)
    .replace(ASSIGNED_SECRET, "$1[REDACTED]")
    .replace(JWT_TEXT, "[REDACTED]")
    .replace(KNOWN_TOKEN_TEXT, "[REDACTED]")
    .replace(SECRET_TEXT, "[REDACTED]")
    .replace(WINDOWS_ABSOLUTE_PATH, "$1[LOCAL_PATH]")
    .replace(WINDOWS_UNC_PATH, "[LOCAL_PATH]")
    .replace(POSIX_PRIVATE_PATH, "$1[LOCAL_PATH]");
  return redacted;
}

function sanitizeLabeledSecret(_match, label, content) {
  if (/reasoning/i.test(label) && /^`?(?:low|medium|high|xhigh|max)`?[.!]?$/i.test(content.trim())) return `${label}${content}`;
  return `${label}[REDACTED]`;
}

function sanitizeUrl(match) {
  const trailing = match.match(/[),.;!\]}]+$/)?.[0] ?? "";
  const candidate = trailing ? match.slice(0, -trailing.length) : match;
  try {
    const url = new URL(candidate);
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return `${url.toString()}${trailing}`;
  } catch {
    return "[REDACTED_URL]";
  }
}

export function assertSanitizedArtifact(value) {
  assertSanitizedValue(value, new WeakSet());
}

function assertSanitizedValue(value, seen) {
  if (typeof value === "string") {
    if (sanitizeString(value) !== value) throw new Error("Sanitized autonomy artifact still contains sensitive text or a local path.");
    return;
  }
  if (value === null || typeof value !== "object" || seen.has(value)) return;
  seen.add(value);
  if (Array.isArray(value)) {
    for (const entry of value) assertSanitizedValue(entry, seen);
    return;
  }
  for (const [key, entry] of Object.entries(value)) {
    const sanitizedEntry = sanitizeEntry(key, entry, new WeakSet());
    if (JSON.stringify(sanitizedEntry) !== JSON.stringify(entry)) {
      throw new Error(`Sanitized autonomy artifact still contains unsafe field: ${key}`);
    }
    assertSanitizedValue(entry, seen);
  }
}
