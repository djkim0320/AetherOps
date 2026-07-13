import { describe, expect, it } from "vitest";
import type { StorageWorkerClient } from "../runtime/storage/worker/typedRuntime.js";
import type { StorageCheckpoint, StorageJob } from "../runtime/storage/v2/types.js";
import { assertDurableResumeSource } from "./durableResumeValidator.js";

describe("durable resume validation", () => {
  it.each([
    { label: "checkpoint project", checkpointProject: "project-other", sourceProject: "project-1", operation: "chat_reply" },
    { label: "source project", checkpointProject: "project-1", sourceProject: "project-other", operation: "chat_reply" },
    { label: "job kind", checkpointProject: "project-1", sourceProject: "project-1", operation: "research_loop" }
  ])("rejects a mismatched $label", async ({ checkpointProject, sourceProject, operation }) => {
    const client = storageClient(checkpoint(checkpointProject), job(sourceProject, operation));
    await expect(assertDurableResumeSource(client, resumeInput())).rejects.toThrow(/committed checkpoint/);
  });

  it("accepts a committed checkpoint from the same project and kind", async () => {
    await expect(assertDurableResumeSource(storageClient(checkpoint("project-1"), job("project-1", "chat_reply")), resumeInput())).resolves.toBeUndefined();
  });
});

function storageClient(checkpointRow: StorageCheckpoint, jobRow: StorageJob): StorageWorkerClient {
  return {
    request: (command: { name: string }) => Promise.resolve(command.name === "checkpoint.get" ? checkpointRow : jobRow)
  } as unknown as StorageWorkerClient;
}

function resumeInput() {
  return {
    projectId: "project-1",
    kind: "chat_reply" as const,
    projectRevision: 2,
    idempotencyKey: "resume-key",
    resumesJobId: "job-source",
    resumeCheckpointId: "checkpoint-1"
  };
}

function checkpoint(projectId: string): StorageCheckpoint {
  return {
    id: "checkpoint-1",
    projectId,
    jobId: "job-source",
    step: "EXECUTE_TOOLS",
    checkpointKey: "checkpoint-key",
    status: "committed",
    data: { phase: "step_completed" },
    createdAt: "2026-07-14T00:00:00.000Z",
    committedAt: "2026-07-14T00:00:00.000Z"
  };
}

function job(projectId: string, operation: string): StorageJob {
  return {
    id: "job-source",
    projectId,
    operation,
    status: "interrupted",
    priority: 0,
    attempt: 1,
    leaseGeneration: 1,
    payload: null,
    idempotencyKey: "source-key",
    queuedAt: "2026-07-14T00:00:00.000Z",
    createdAt: "2026-07-14T00:00:00.000Z",
    updatedAt: "2026-07-14T00:00:00.000Z"
  };
}
