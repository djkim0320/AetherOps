import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { StorageWorkerRuntime } from "../worker/typedRuntime.js";
import { createStorageV2Repositories } from "./repositories.js";
import { migrateStorageV2Schema } from "./schema.js";
import type { StorageCheckpoint, StorageJob } from "./types.js";

let root: string | undefined;
let runtime: StorageWorkerRuntime | undefined;

afterEach(() => {
  runtime?.close();
  if (root) rmSync(root, { recursive: true, force: true });
  runtime = undefined;
  root = undefined;
});

describe("latest project execution read", () => {
  it("reads the exact newest operation and its checkpoint beyond the list pagination window", () => {
    root = mkdtempSync(join(tmpdir(), "aetherops-latest-execution-"));
    const databasePath = join(root, "storage.sqlite");
    const db = new DatabaseSync(databasePath);
    migrateStorageV2Schema(db);
    const repositories = createStorageV2Repositories({ appDb: db });
    for (let index = 0; index < 205; index += 1) {
      repositories.jobs.enqueue(job(`research-${index.toString().padStart(3, "0")}`, "research_loop", timestamp(index)));
    }
    repositories.jobs.enqueue(job("chat-newer", "chat_reply", timestamp(400)));
    repositories.jobs.enqueue(job("research-tie-a", "research_loop", timestamp(300)));
    repositories.jobs.enqueue(job("research-tie-z", "research_loop", timestamp(300)));
    repositories.checkpoints.saveCheckpoint(checkpoint("research-tie-z"));
    db.close();

    runtime = new StorageWorkerRuntime({ appDbPath: databasePath, vectorDbPath: databasePath, ontologyDbPath: databasePath });
    const result = runtime.handle({
      name: "job.latestProjectExecution",
      projectId: "project-latest",
      operation: "research_loop"
    }) as { job?: StorageJob; checkpoint?: StorageCheckpoint };

    expect(result.job?.id).toBe("research-tie-z");
    expect(result.checkpoint).toMatchObject({ id: "checkpoint-latest", jobId: "research-tie-z", status: "committed" });
  });
});

function job(id: string, operation: string, createdAt: string) {
  return { id, projectId: "project-latest", operation, createdAt, queuedAt: createdAt };
}

function checkpoint(jobId: string): StorageCheckpoint {
  return {
    id: "checkpoint-latest",
    projectId: "project-latest",
    jobId,
    step: "EXECUTE_TOOLS",
    checkpointKey: "latest",
    status: "committed",
    createdAt: timestamp(301),
    committedAt: timestamp(301)
  };
}

function timestamp(offsetSeconds: number): string {
  return new Date(Date.parse("2026-07-14T00:00:00.000Z") + offsetSeconds * 1_000).toISOString();
}
