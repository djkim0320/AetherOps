import type { StorageTerminalTransitionResult } from "../v2/jobAtomicTypes.js";
import type { TerminalCasFinalizeError } from "../v2/terminalCasStore.js";

export function withTerminalCasPostCommitWarning(
  result: StorageTerminalTransitionResult,
  error: TerminalCasFinalizeError,
  disposition: "finalize" | "abort",
  affectedObjectCount: number
): StorageTerminalTransitionResult {
  const integrity = error.stage === "integrity";
  const abort = disposition === "abort";
  return {
    ...result,
    postCommitWarnings: [
      ...(result.postCommitWarnings ?? []),
      {
        code: integrity ? "ENGINEERING_CAS_INTEGRITY_RECONCILIATION_REQUIRED" : abort ? "ENGINEERING_CAS_ABORT_DEFERRED" : "ENGINEERING_CAS_FINALIZE_DEFERRED",
        operation: integrity ? "engineering_cas_integrity" : abort ? "engineering_cas_abort" : "engineering_cas_finalize",
        severity: integrity ? "error" : "warning",
        message: integrity
          ? "Committed engineering CAS integrity requires fail-closed startup reconciliation before further trusted readback."
          : abort
            ? "Uncommitted engineering CAS claims require bounded startup reconciliation."
            : "Engineering CAS journal finalization was deferred to durable startup reconciliation.",
        affectedObjectCount
      }
    ]
  };
}
