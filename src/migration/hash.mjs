import { createHash } from "node:crypto";

export function sha256Hex(value) {
  const hash = createHash("sha256");
  if (typeof value === "string") {
    hash.update(value, "utf8");
  } else if (value instanceof Uint8Array) {
    hash.update(value);
  } else {
    hash.update(Buffer.from(String(value), "utf8"));
  }
  return hash.digest("hex");
}

export function stableStringify(value) {
  return JSON.stringify(normalizeForStableJson(value));
}

export function stableJsonHash(value) {
  return sha256Hex(stableStringify(value));
}

export function normalizeText(value) {
  return String(value ?? "")
    .replace(/^\uFEFF/, "")
    .replace(/\r\n?/g, "\n");
}

export function semanticTextHash(value) {
  return sha256Hex(normalizeText(value));
}

export function normalizeForStableJson(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    if (Number.isNaN(value)) return "NaN";
    return value;
  }
  if (typeof value === "bigint") {
    return value.toString();
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (value instanceof Uint8Array) {
    return { $type: "Uint8Array", base64: Buffer.from(value).toString("base64") };
  }
  if (Buffer.isBuffer(value)) {
    return { $type: "Buffer", base64: value.toString("base64") };
  }
  if (Array.isArray(value)) {
    return value.map((entry) => normalizeForStableJson(entry));
  }
  if (typeof value === "object") {
    const output = {};
    for (const key of Object.keys(value).sort((left, right) => left.localeCompare(right))) {
      const next = normalizeForStableJson(value[key]);
      if (next !== undefined) {
        output[key] = next;
      }
    }
    return output;
  }
  return String(value);
}
