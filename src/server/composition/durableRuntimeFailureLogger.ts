import { randomUUID } from "node:crypto";
import type { StoragePostCommitReconciliationWarning } from "../runtime/storage/v2/jobAtomicTypes.js";
import { durableFailureFrom } from "./durableFailure.js";

interface DurableRuntimeFailureContext {
  jobId?: string;
  projectId?: string;
  diagnosticId?: string;
}

export function logDurableRuntimeFailure(error: unknown, context: DurableRuntimeFailureContext): void {
  const failure = durableFailureFrom(error, {
    diagnosticId: () => context.diagnosticId ?? `job-${randomUUID()}`
  });
  console.error(
    JSON.stringify({
      level: "error",
      operation: "durable_job_runtime",
      diagnosticId: failure.internalDiagnosticId,
      errorCode: isLeaseLost(error) ? "LEASE_LOST" : failure.code,
      ...(context.jobId ? { jobId: context.jobId } : {}),
      ...(context.projectId ? { projectId: context.projectId } : {})
    })
  );
}

export function logDurablePostCommitWarning(
  warning: StoragePostCommitReconciliationWarning,
  context: Pick<DurableRuntimeFailureContext, "jobId" | "projectId">
): void {
  console.warn(
    JSON.stringify({
      level: "warn",
      operation: "durable_job_post_commit_reconciliation",
      warningCode: warning.code,
      reconciliationOperation: warning.operation,
      affectedObjectCount: warning.affectedObjectCount,
      ...(context.jobId ? { jobId: context.jobId } : {}),
      ...(context.projectId ? { projectId: context.projectId } : {})
    })
  );
}

function isLeaseLost(error: unknown): boolean {
  return error instanceof Error && error.name === "LeaseLostError";
}
