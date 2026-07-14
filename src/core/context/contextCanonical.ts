export async function hashContextCanonical(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalJson(value, new Set<object>()));
  return sha256(bytes);
}

export async function hashContextText(value: string): Promise<string> {
  return sha256(new TextEncoder().encode(value));
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", Uint8Array.from(bytes).buffer);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function canonicalJson(value: unknown, ancestors: Set<object>): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("Context canonicalization rejects non-finite numbers.");
    return JSON.stringify(Object.is(value, -0) ? 0 : value);
  }
  if (Array.isArray(value)) return canonicalArray(value, ancestors);
  if (isPlainObject(value)) return canonicalObject(value, ancestors);
  throw new TypeError(`Context canonicalization rejects unsupported value type: ${typeof value}`);
}

function canonicalArray(value: readonly unknown[], ancestors: Set<object>): string {
  guardCycle(value, ancestors);
  try {
    return `[${value.map((entry) => canonicalJson(entry, ancestors)).join(",")}]`;
  } finally {
    ancestors.delete(value);
  }
}

function canonicalObject(value: Record<string, unknown>, ancestors: Set<object>): string {
  guardCycle(value, ancestors);
  try {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key], ancestors)}`)
      .join(",")}}`;
  } finally {
    ancestors.delete(value);
  }
}

function guardCycle(value: object, ancestors: Set<object>): void {
  if (ancestors.has(value)) throw new TypeError("Context canonicalization rejects cyclic values.");
  ancestors.add(value);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
