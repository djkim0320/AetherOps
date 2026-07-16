import type { DurableJobRuntime } from "./durableJobRuntime.js";

export async function requireDurableProjectRevision(jobs: Pick<DurableJobRuntime, "getProjectRevision">, projectId: string): Promise<number> {
  const revision = await jobs.getProjectRevision(projectId);
  if (revision === undefined) throw new Error(`Durable project revision is unavailable: ${projectId}.`);
  return revision;
}
