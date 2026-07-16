import { createHash } from "node:crypto";
import type { ResearchSnapshot } from "../../../core/shared/types.js";
import type { LegacyProjectMutationReceipt, LegacyProjectMutationRequest } from "./legacyProjectMutationTypes.js";

export function legacyProjectMutationCommandHash(request: LegacyProjectMutationRequest): string {
  return sha256Canonical({
    method: request.method,
    projectId: request.projectId,
    expectedBeforeHash: request.expectedBeforeHash,
    command: request.command,
    appliedAt: request.appliedAt
  });
}

export function legacyProjectSnapshotHash(snapshot: ResearchSnapshot): string {
  return sha256Canonical(
    jsonValue({
      project: snapshot.project,
      sessions: [...snapshot.sessions].sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id))
    })
  );
}

export function legacyProjectMutationResultHash(resultJson: string): string {
  const parsed = JSON.parse(resultJson) as unknown;
  if (storageCanonicalJson(parsed) !== resultJson) throw new Error("Legacy project mutation result JSON is not canonical.");
  return sha256Canonical(parsed);
}

export function legacyProjectMutationReceiptHash(receipt: Omit<LegacyProjectMutationReceipt, "receiptHash">): string {
  return sha256Canonical(receipt);
}

export function canonicalLegacyProjectMutationResult(value: unknown): string {
  return storageCanonicalJson(jsonValue(value));
}

function sha256Canonical(value: unknown): string {
  return createHash("sha256").update(storageCanonicalJson(value)).digest("hex");
}

function jsonValue(value: unknown): unknown {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new TypeError("Legacy project mutation hashing requires a JSON value.");
  return JSON.parse(serialized) as unknown;
}

function storageCanonicalJson(value: unknown): string {
  return canonicalJson(value, new Set<object>());
}

function canonicalJson(value: unknown, ancestors: Set<object>): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("Canonical legacy storage hashing rejects non-finite numbers.");
    return JSON.stringify(Object.is(value, -0) ? 0 : value);
  }
  if (Array.isArray(value)) return canonicalArray(value, ancestors);
  if (isPlainObject(value)) return canonicalObject(value, ancestors);
  throw new TypeError(`Canonical legacy storage hashing rejects unsupported value type: ${typeof value}`);
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
  if (ancestors.has(value)) throw new TypeError("Canonical legacy storage hashing rejects cyclic values.");
  ancestors.add(value);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
