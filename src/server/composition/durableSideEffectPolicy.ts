import type { StorageToolAttempt, StorageToolAttemptStatus } from "../runtime/storage/v2/traceTypes.js";
import {
  assertStorageToolAttemptTrace,
  assertVerifiedToolPostcondition,
  toolAttemptRequiresVerifiedPostcondition
} from "../runtime/storage/v2/toolPostcondition.js";
import { CanonicalRunRuntimeError, type CanonicalExternalEffect } from "./canonicalRunTypes.js";

export function canonicalEffectsFromToolAttempts(attempts: StorageToolAttempt[]): CanonicalExternalEffect[] {
  const seen = new Set<string>();
  return [...attempts]
    .sort((left, right) => left.id.localeCompare(right.id))
    .map((attempt) => {
      if (seen.has(attempt.id)) throw new CanonicalRunRuntimeError("CANONICAL_RUN_NOT_READY", `Duplicate canonical tool attempt: ${attempt.id}`);
      seen.add(attempt.id);
      return { attemptId: attempt.id, status: classifyCanonicalToolEffect(attempt) };
    });
}

export function assertToolAttemptResumeSafe(attempt: StorageToolAttempt): void {
  if (attempt.status === "queued" || attempt.status === "running") {
    throw new CanonicalRunRuntimeError("PENDING_EXTERNAL_SIDE_EFFECT", `Tool attempt ${attempt.id} has no durable terminal receipt.`);
  }
  classifyCanonicalToolEffect(attempt);
}

export function classifyCanonicalToolEffect(attempt: StorageToolAttempt): CanonicalExternalEffect["status"] {
  if (attempt.status === "queued" || attempt.status === "running") return attempt.status;
  if (attempt.status === "blocked") return "failed";
  if (attempt.traceVersion === undefined) return legacyTerminalStatus(attempt.status);
  assertVnextTrace(attempt);
  if (!attempt.descriptorVersion || attempt.descriptorSideEffects === undefined) {
    throw ambiguousSideEffect(attempt, "descriptor version and side-effect metadata are unavailable");
  }
  if (!toolAttemptRequiresVerifiedPostcondition(attempt)) return legacyTerminalStatus(attempt.status);
  try {
    assertVerifiedToolPostcondition(attempt);
  } catch (error) {
    throw ambiguousSideEffect(attempt, error instanceof Error ? error.message : "postcondition receipt verification failed");
  }
  if (attempt.postconditionDisposition === "applied") return "committed";
  if (attempt.status === "completed") {
    throw ambiguousSideEffect(attempt, "completed status conflicts with a verified not_applied postcondition");
  }
  return legacyTerminalStatus(attempt.status);
}

function assertVnextTrace(attempt: StorageToolAttempt): void {
  try {
    assertStorageToolAttemptTrace(attempt);
  } catch (error) {
    throw ambiguousSideEffect(attempt, error instanceof Error ? error.message : "side-effect trace verification failed");
  }
}

function legacyTerminalStatus(status: StorageToolAttemptStatus): CanonicalExternalEffect["status"] {
  if (status === "completed") return "committed";
  if (status === "blocked") return "failed";
  return status;
}

function ambiguousSideEffect(attempt: StorageToolAttempt, reason: string): CanonicalRunRuntimeError {
  return new CanonicalRunRuntimeError(
    "PENDING_EXTERNAL_SIDE_EFFECT",
    `Tool attempt ${attempt.id} has an ambiguous external side effect: ${reason}. A trusted postcondition verifier must resolve it before canonical prepare or resume.`
  );
}
