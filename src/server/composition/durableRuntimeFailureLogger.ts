import { randomUUID } from "node:crypto";
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

function isLeaseLost(error: unknown): boolean {
  return error instanceof Error && error.name === "LeaseLostError";
}
