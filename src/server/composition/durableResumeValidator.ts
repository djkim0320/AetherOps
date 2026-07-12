import type { StorageWorkerClient } from "../runtime/storage/worker/typedRuntime.js";
import type { StorageCheckpoint, StorageJob } from "../runtime/storage/v2/types.js";
import type { StorageToolAttempt } from "../runtime/storage/v2/traceTypes.js";
import type { EnqueueDurableJob } from "./durableJobTypes.js";

export async function assertDurableResumeSource(client: StorageWorkerClient, input: EnqueueDurableJob): Promise<void> {
  const checkpoint = await client.request<StorageCheckpoint | undefined>({
    name: "checkpoint.get",
    checkpointId: input.resumeCheckpointId as string
  });
  const source = input.resumesJobId ? await client.request<StorageJob | undefined>({ name: "job.get", jobId: input.resumesJobId }) : undefined;
  if (
    !checkpoint ||
    checkpoint.status !== "committed" ||
    checkpoint.jobId !== source?.id ||
    !["paused", "interrupted", "blocked", "failed"].includes(source.status)
  ) {
    throw new Error("Resume requires a committed checkpoint from a paused, interrupted, blocked, or failed source job.");
  }
  await assertCheckpointAttemptHashes(client, checkpoint);
}

async function assertCheckpointAttemptHashes(client: StorageWorkerClient, checkpoint: StorageCheckpoint): Promise<void> {
  if (!checkpoint.data || typeof checkpoint.data !== "object" || (checkpoint.data as { phase?: unknown }).phase !== "execute_tools_completed") return;
  const expected = (checkpoint.data as { attempts?: Array<{ id: string; inputHash: string; outputHash?: string }> }).attempts ?? [];
  if (!expected.length) throw new Error("Resume checkpoint does not contain verified tool attempts.");
  const actual = await client.request<StorageToolAttempt[]>({ name: "trace.attempt.listJob", jobId: checkpoint.jobId, limit: 1_000 });
  for (const item of expected) {
    const attempt = actual.find((candidate) => candidate.id === item.id && candidate.status === "completed");
    if (!attempt || attempt.inputHash !== item.inputHash || attempt.outputHash !== item.outputHash) {
      throw new Error("Resume checkpoint tool output hash verification failed.");
    }
  }
}
