import type { TraceEvent } from "./traceSchemas.js";

export function serializeCanonical(value: unknown): string {
  return canonicalValue(value, new Set<object>());
}

export function serializeTraceCanonical(events: readonly TraceEvent[]): string {
  return events.map((event) => serializeCanonical(event)).join("\n");
}

export async function hashCanonical(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(serializeCanonical(value));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function hashCanonicalSync(value: unknown): string {
  return sha256TextSync(serializeCanonical(value));
}

export async function hashTraceCanonical(events: readonly TraceEvent[]): Promise<string> {
  const bytes = new TextEncoder().encode(serializeTraceCanonical(events));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function canonicalValue(value: unknown, ancestors: Set<object>): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("Canonical serialization rejects non-finite numbers.");
    return JSON.stringify(Object.is(value, -0) ? 0 : value);
  }
  if (Array.isArray(value)) return canonicalArray(value, ancestors);
  if (isPlainObject(value)) return canonicalObject(value, ancestors);
  throw new TypeError(`Canonical serialization rejects unsupported value type: ${typeof value}`);
}

function canonicalArray(value: readonly unknown[], ancestors: Set<object>): string {
  guardCycle(value, ancestors);
  try {
    return `[${value.map((entry) => canonicalValue(entry, ancestors)).join(",")}]`;
  } finally {
    ancestors.delete(value);
  }
}

function canonicalObject(value: Record<string, unknown>, ancestors: Set<object>): string {
  guardCycle(value, ancestors);
  try {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalValue(value[key], ancestors)}`)
      .join(",")}}`;
  } finally {
    ancestors.delete(value);
  }
}

function guardCycle(value: object, ancestors: Set<object>): void {
  if (ancestors.has(value)) throw new TypeError("Canonical serialization rejects cyclic values.");
  ancestors.add(value);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

const SHA256_INITIAL = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19] as const;
const SHA256_ROUND = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74,
  0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d,
  0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e,
  0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5,
  0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
] as const;

function sha256TextSync(text: string): string {
  const source = new TextEncoder().encode(text);
  const paddedLength = Math.ceil((source.length + 9) / 64) * 64;
  const padded = new Uint8Array(paddedLength);
  padded.set(source);
  padded[source.length] = 0x80;
  const view = new DataView(padded.buffer);
  const bitLength = source.length * 8;
  view.setUint32(paddedLength - 8, Math.floor(bitLength / 0x1_0000_0000));
  view.setUint32(paddedLength - 4, bitLength >>> 0);
  const hash = [...SHA256_INITIAL];
  const words = new Uint32Array(64);
  for (let offset = 0; offset < paddedLength; offset += 64) compressSha256(view, offset, words, hash);
  return hash.map((word) => word.toString(16).padStart(8, "0")).join("");
}

function compressSha256(view: DataView, offset: number, words: Uint32Array, hash: number[]): void {
  for (let index = 0; index < 16; index += 1) words[index] = view.getUint32(offset + index * 4);
  for (let index = 16; index < 64; index += 1) {
    const left = words[index - 15]!;
    const right = words[index - 2]!;
    const sigma0 = rotateRight(left, 7) ^ rotateRight(left, 18) ^ (left >>> 3);
    const sigma1 = rotateRight(right, 17) ^ rotateRight(right, 19) ^ (right >>> 10);
    words[index] = (words[index - 16]! + sigma0 + words[index - 7]! + sigma1) >>> 0;
  }
  let [a, b, c, d, e, f, g, h] = hash as [number, number, number, number, number, number, number, number];
  for (let index = 0; index < 64; index += 1) {
    const upperSigma1 = rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25);
    const choice = (e & f) ^ (~e & g);
    const temporary1 = (h + upperSigma1 + choice + SHA256_ROUND[index]! + words[index]!) >>> 0;
    const upperSigma0 = rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22);
    const majority = (a & b) ^ (a & c) ^ (b & c);
    const temporary2 = (upperSigma0 + majority) >>> 0;
    [h, g, f, e, d, c, b, a] = [g, f, e, (d + temporary1) >>> 0, c, b, a, (temporary1 + temporary2) >>> 0];
  }
  const values = [a, b, c, d, e, f, g, h];
  for (let index = 0; index < 8; index += 1) hash[index] = (hash[index]! + values[index]!) >>> 0;
}

function rotateRight(value: number, count: number): number {
  return (value >>> count) | (value << (32 - count));
}
