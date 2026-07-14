import { isAbsolute } from "node:path";
import { redactTraceText, sanitizeTraceValue } from "../../security/traceSanitizer.js";

const LOWER_SHA256 = /^[a-f0-9]{64}$/;
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

export function assertTraceIdentifier(value: unknown, label: string, maxLength = 256): asserts value is string {
  assertTraceText(value, label, maxLength);
  if (containsAsciiControl(value)) throw new Error(`${label} contains a control character.`);
}

export function assertTraceText(value: unknown, label: string, maxLength: number): asserts value is string {
  if (typeof value !== "string" || !value || value.length > maxLength || value.trim() !== value) throw new Error(`${label} is invalid.`);
  const sanitized = redactTraceText(value)
    ?.replace(/[\r\n]+/g, " ")
    .trim();
  if (sanitized !== value) throw new Error(`${label} is not sanitized.`);
}

export function assertLowerSha256(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !LOWER_SHA256.test(value)) throw new Error(`${label} is not a lowercase SHA-256 value.`);
}

export function assertIsoTimestamp(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !ISO_TIMESTAMP.test(value) || !Number.isFinite(Date.parse(value))) throw new Error(`${label} is not a valid ISO timestamp.`);
}

export function assertTimestampOrder(start: string, end: string | undefined, label: string): void {
  if (end === undefined) return;
  assertIsoTimestamp(end, `${label} completion timestamp`);
  if (Date.parse(end) < Date.parse(start)) throw new Error(`${label} completion precedes its start.`);
}

export function assertTraceIdentifierList(value: unknown, label: string, maximum: number): asserts value is string[] {
  if (!Array.isArray(value) || value.length > maximum) throw new Error(`${label} exceeds its item bound.`);
  for (const item of value) assertTraceIdentifier(item, `${label} item`);
  if (new Set(value).size !== value.length) throw new Error(`${label} contains duplicate identifiers.`);
}

export function assertWorkspaceReference(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !value || value.length > 1_024 || value.trim() !== value || isAbsolute(value) || value.includes("\\")) {
    throw new Error(`${label} is not a bounded relative workspace reference.`);
  }
  const segments = value.split("/");
  if (segments.some((segment) => !/^[A-Za-z0-9._:@-]+$/u.test(segment) || segment === "." || segment === "..")) {
    throw new Error(`${label} is not a safe workspace reference.`);
  }
}

export function assertCanonicalRelativePath(value: unknown, label: string, maxLength = 240): asserts value is string {
  if (typeof value !== "string" || !value || value.length > maxLength || value.startsWith("/") || value.includes("\\") || isAbsolute(value)) {
    throw new Error(`${label} is invalid.`);
  }
  const segments = value.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === ".." || /[?#=&]/u.test(segment) || containsAsciiControl(segment))) {
    throw new Error(`${label} is unsafe.`);
  }
  if (sanitizeTraceValue(value) !== value) throw new Error(`${label} is not sanitized.`);
}

function containsAsciiControl(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 31 || code === 127) return true;
  }
  return false;
}
