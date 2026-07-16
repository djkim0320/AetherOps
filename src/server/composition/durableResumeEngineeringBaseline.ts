import type { StorageCheckpoint, StorageJob } from "../runtime/storage/v2/types.js";
import { durableJobRequestHash } from "./durableJobRequestHash.js";
import type { EnqueueDurableJob } from "./durableJobTypes.js";

type ResumeBaselineFailure = (code: "CONFLICT" | "NOT_READY", message: string) => never;

export function assertCheckpointEngineeringBaselineBinding(
  checkpoint: StorageCheckpoint,
  lineage: StorageJob[],
  input: EnqueueDurableJob,
  fail: ResumeBaselineFailure
): void {
  const bindings = lineage.map((job) => requiredBinding(record(record(job.payload)?.request), `job ${job.id}`, fail));
  const expected = bindings[0];
  const resume = requiredBinding(record(input.payload), "resume request", fail);
  const checkpointBinding = requiredBinding(record(checkpoint.data), `checkpoint ${checkpoint.id}`, fail);
  if (bindings.some((binding) => !sameCanonical(expected, binding)) || !sameCanonical(expected, resume) || !sameCanonical(expected, checkpointBinding)) {
    fail("CONFLICT", "Research resume attempted to change its checkpoint-bound engineering configuration baseline.");
  }
}

export function assertCheckpointFreeEngineeringBaselineBinding(source: StorageJob, input: EnqueueDurableJob, fail: ResumeBaselineFailure): void {
  const sourceBinding = requiredBinding(record(record(source.payload)?.request), `job ${source.id}`, fail);
  const resumeBinding = requiredBinding(record(input.payload), "resume request", fail);
  if (!sameCanonical(sourceBinding, resumeBinding)) {
    fail("CONFLICT", "Checkpoint-free resume attempted to change its engineering configuration baseline.");
  }
}

function requiredBinding(
  value: Record<string, unknown> | undefined,
  label: string,
  fail: ResumeBaselineFailure
): null | { id: string; revision: number; contentHash: string } {
  if (!value || !Object.prototype.hasOwnProperty.call(value, "engineeringBaseline")) {
    fail("NOT_READY", `Research ${label} is missing its immutable engineering baseline binding.`);
  }
  const binding = value.engineeringBaseline;
  if (binding === null) return null;
  const parsed = record(binding);
  const keys = parsed ? Object.keys(parsed).sort() : [];
  if (
    !parsed ||
    keys.join("\u0000") !== ["contentHash", "id", "revision"].join("\u0000") ||
    typeof parsed.id !== "string" ||
    !parsed.id ||
    !Number.isInteger(parsed.revision) ||
    Number(parsed.revision) < 1 ||
    typeof parsed.contentHash !== "string" ||
    !/^[a-f0-9]{64}$/.test(parsed.contentHash)
  ) {
    fail("NOT_READY", `Research ${label} contains an invalid engineering baseline binding.`);
  }
  return { id: parsed.id, revision: Number(parsed.revision), contentHash: parsed.contentHash };
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function sameCanonical(left: unknown, right: unknown): boolean {
  return left !== undefined && right !== undefined && durableJobRequestHash(left) === durableJobRequestHash(right);
}
