import { isDeepStrictEqual } from "node:util";
import type { StorageToolAttempt, StorageToolOutputLink } from "./traceTypes.js";

const terminalToolAttemptStatuses = new Set<StorageToolAttempt["status"]>(["completed", "blocked", "failed", "interrupted", "quarantined"]);

export function assertToolAttemptUpdate(existing: StorageToolAttempt, next: StorageToolAttempt): void {
  if (
    existing.projectId !== next.projectId ||
    existing.jobId !== next.jobId ||
    existing.decisionId !== next.decisionId ||
    existing.ordinal !== next.ordinal ||
    existing.inputHash !== next.inputHash ||
    existing.queuedAt !== next.queuedAt
  ) {
    throw new Error(`Tool attempt identity conflict: ${existing.id}.`);
  }
  if (terminalToolAttemptStatuses.has(existing.status) && !isDeepStrictEqual(comparableAttempt(existing), comparableAttempt(next))) {
    throw new Error(`Invalid terminal tool attempt transition; retry must be identical: ${existing.id}.`);
  }
  if (existing.status === "running" && next.status === "queued") {
    throw new Error(`Invalid tool attempt transition for ${existing.id}: running -> queued.`);
  }
}

function comparableAttempt(value: StorageToolAttempt): Record<string, unknown> {
  return {
    id: value.id,
    projectId: value.projectId,
    jobId: value.jobId,
    decisionId: value.decisionId,
    checkpointId: value.checkpointId ?? null,
    ordinal: value.ordinal,
    status: value.status,
    inputHash: value.inputHash,
    outputHash: value.outputHash ?? null,
    terminalCause: value.terminalCause ?? null,
    dependsOnAttemptIds: value.dependsOnAttemptIds,
    stagingRef: value.stagingRef ?? null,
    quarantineRef: value.quarantineRef ?? null,
    error: value.error ?? null,
    queuedAt: value.queuedAt,
    startedAt: value.startedAt ?? null,
    completedAt: value.completedAt ?? null,
    data: value.data ?? null
  };
}

export function assertOutputLinkUpdate(existing: StorageToolOutputLink, next: StorageToolOutputLink): void {
  if (
    existing.id !== next.id ||
    existing.projectId !== next.projectId ||
    existing.jobId !== next.jobId ||
    existing.attemptId !== next.attemptId ||
    existing.outputKind !== next.outputKind ||
    existing.outputId !== next.outputId ||
    existing.createdAt !== next.createdAt
  ) {
    throw new Error(`Tool output link identity conflict: ${next.id}.`);
  }
  if (existing.promoted && !next.promoted) {
    throw new Error(`Promoted tool output cannot be downgraded: ${existing.id}.`);
  }
}
