import { createHash } from "node:crypto";
import { parseContextPackPersistenceReceipt, type ContextPackCanonicalHasher, type ContextPackPersistenceReceipt } from "../../../../core/context/public.js";
import { type CanonicalHasher } from "../../../../core/orchestration/orchestrationSchemas.js";
import { parseRunStateRevision, type RunStateRevision } from "../../../../core/orchestration/runStateCapsule.js";
import { parseTaskContract, type TaskContract } from "../../../../core/orchestration/taskContract.js";

export const storageCanonicalHasher: CanonicalHasher & ContextPackCanonicalHasher = {
  sha256Canonical(value: unknown): string {
    return sha256(storageCanonicalJson(value));
  },
  sha256Text(value: string): string {
    return sha256(value);
  }
};

export function storageCanonicalJson(value: unknown): string {
  return canonicalJson(value, new Set<object>());
}

export function parseStoredTaskContract(value: unknown): TaskContract {
  return parseTaskContract(value, storageCanonicalHasher);
}

export function parseStoredRunStateRevision(value: unknown): RunStateRevision {
  return parseRunStateRevision(value, storageCanonicalHasher);
}

export function parseStoredContextPack(value: unknown): ContextPackPersistenceReceipt {
  return parseContextPackPersistenceReceipt(value, storageCanonicalHasher);
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalJson(value: unknown, ancestors: Set<object>): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("Canonical storage hashing rejects non-finite numbers.");
    return JSON.stringify(Object.is(value, -0) ? 0 : value);
  }
  if (Array.isArray(value)) return canonicalArray(value, ancestors);
  if (isPlainObject(value)) return canonicalObject(value, ancestors);
  throw new TypeError(`Canonical storage hashing rejects unsupported value type: ${typeof value}`);
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
  if (ancestors.has(value)) throw new TypeError("Canonical storage hashing rejects cyclic values.");
  ancestors.add(value);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
