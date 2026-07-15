import { createHash } from "node:crypto";
import type { StorageLeaseFence } from "./types.js";

export function jobAtomicId(prefix: string, ...parts: string[]): string {
  return `${prefix}-${createHash("sha256").update(parts.join("\u0000")).digest("hex")}`;
}

export function storageStepCheckpointId(fence: StorageLeaseFence, step: string, disposition: "committed" | "quarantined" = "committed"): string {
  return jobAtomicId("checkpoint", fence.jobId, String(fence.attempt), step, disposition);
}
