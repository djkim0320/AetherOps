import type { StorageWorkerClient } from "../runtime/storage/worker/typedRuntime.js";
import type { StorageExpiredLeaseSweepResult } from "../runtime/storage/v2/jobAtomicTypes.js";
import type { StorageJobEvent, StorageRunnableProjectPage } from "../runtime/storage/v2/types.js";

export async function discoverDurableRunnableProjects(client: StorageWorkerClient): Promise<string[]> {
  const projectIds: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await client.request<StorageRunnableProjectPage>({ name: "job.listRunnableProjects", cursor, limit: 250 });
    projectIds.push(...page.projectIds);
    if (page.nextCursor && page.nextCursor === cursor) throw new Error("Runnable project recovery cursor made no progress.");
    cursor = page.nextCursor;
  } while (cursor);
  return projectIds;
}

export async function sweepDurableExpiredLeases(
  client: StorageWorkerClient,
  now: string,
  publish: (events: StorageJobEvent[]) => void
): Promise<StorageExpiredLeaseSweepResult> {
  const result = await client.request<StorageExpiredLeaseSweepResult>({ name: "job.markInterruptedExpiredLeases", now });
  publish(result.events);
  return result;
}
