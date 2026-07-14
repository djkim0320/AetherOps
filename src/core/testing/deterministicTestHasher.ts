/** Deterministic test adapter. This is deliberately not production cryptography. */
export const deterministicTestHasher = Object.freeze({
  sha256Canonical: (value: unknown): string => deterministicTestDigest(canonicalJson(value))
});

export function deterministicTestDigest(value: string): string {
  let seed = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) seed = Math.imul(seed ^ value.charCodeAt(index), 0x01000193) >>> 0;
  return Array.from({ length: 8 }, (_, index) => mix(seed, index).toString(16).padStart(8, "0")).join("");
}

function mix(seed: number, index: number): number {
  let value = (seed + Math.imul(index + 1, 0x9e3779b1)) >>> 0;
  value ^= value >>> 16;
  value = Math.imul(value, 0x85ebca6b) >>> 0;
  value ^= value >>> 13;
  value = Math.imul(value, 0xc2b2ae35) >>> 0;
  return (value ^ (value >>> 16)) >>> 0;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`;
}
