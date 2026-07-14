import { z } from "zod";

export const StableIdentifierSchema = z
  .string()
  .min(1)
  .max(160)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/, "Expected a stable identifier.");

export const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/, "Expected a lowercase SHA-256 digest.");
export const IsoTimestampSchema = z.string().datetime({ offset: true });
export const BoundedTextSchema = z.string().trim().min(1).max(8_000);
export const ReasonCodeSchema = z
  .string()
  .min(1)
  .max(120)
  .regex(/^[A-Z][A-Z0-9_]*$/, "Expected an uppercase machine-readable reason code.");

/** Platform adapters provide the SHA-256 implementation; core owns the canonical projection. */
export interface CanonicalHasher {
  sha256Canonical(value: unknown): string;
}

export function assertCanonicalHash(label: string, actual: string, payload: unknown, hasher: CanonicalHasher): void {
  const expected = hasher.sha256Canonical(payload);
  if (actual !== expected) throw new Error(`${label} content hash does not match its canonical payload.`);
}

export type DeepReadonly<T> = T extends (...args: never[]) => unknown
  ? T
  : T extends readonly (infer Item)[]
    ? readonly DeepReadonly<Item>[]
    : T extends object
      ? { readonly [Key in keyof T]: DeepReadonly<T[Key]> }
      : T;

export function deepFreeze<T>(value: T): DeepReadonly<T> {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value as DeepReadonly<T>;
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  return Object.freeze(value) as DeepReadonly<T>;
}

export function addDuplicateIssues(values: readonly string[], context: z.RefinementCtx, path: PropertyKey): void {
  const seen = new Set<string>();
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (seen.has(value)) context.addIssue({ code: "custom", path: [path, index], message: `Duplicate identifier: ${value}` });
    seen.add(value);
  }
}
