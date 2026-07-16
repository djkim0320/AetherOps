import type { DurableJobRuntime } from "../../composition/durableJobRuntime.js";
import { RpcConflictError, RpcNotReadyError } from "./rpcErrors.js";

export async function requireStoredProjectRevision(jobs: DurableJobRuntime, projectId: string): Promise<number> {
  const head = await jobs.getProjectRevision(projectId);
  if (!Number.isInteger(head) || Number(head) < 0) {
    throw new RpcNotReadyError("The durable project revision is unavailable.", { projectId, reason: "PROJECT_REVISION_UNAVAILABLE" });
  }
  return Number(head);
}

export async function assertStoredProjectRevision(jobs: DurableJobRuntime, projectId: string, expectedRevision: number): Promise<number> {
  const actualRevision = await requireStoredProjectRevision(jobs, projectId);
  if (actualRevision !== expectedRevision) throw new RpcConflictError("Project revision changed.");
  return actualRevision;
}
