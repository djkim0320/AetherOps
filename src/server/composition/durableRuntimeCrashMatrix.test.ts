import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { migrateStorageV2Schema } from "../runtime/storage/v2/schema.js";
import { DurableJobRuntime } from "./durableJobRuntime.js";
import { DurableJobRuntimeTestSupport } from "./durableJobRuntimeTestSupport.js";
import type { DurableRuntimeTimer } from "./durableRuntimeConfig.js";

let root: string | undefined;
let runtime: DurableJobRuntime | undefined;
const support = new DurableJobRuntimeTestSupport(
  () => runtime,
  () => root
);

afterEach(async () => {
  await runtime?.close().catch(() => undefined);
  runtime = undefined;
  if (root) rmSync(root, { recursive: true, force: true });
  root = undefined;
});

describe("durable runtime crash boundaries", () => {
  it("commits a handler that returns during graceful close and does not execute it again after restart", async () => {
    const databasePath = createDatabase();
    const timer = manualTimer();
    const started = deferred<void>();
    const release = deferred<void>();
    runtime = new DurableJobRuntime(databasePath, { concurrency: 1, shutdownGraceMs: 10, timer });
    runtime.registerHandler("chat_reply", async (job) => {
      started.resolve();
      await release.promise;
      await support.finishCurrent(job);
    });
    await runtime.initialize();
    const receipt = await support.enqueueCurrent({
      projectId: "project-close-return",
      kind: "chat_reply",
      currentStep: "EXECUTE_TOOLS",
      idempotencyKey: "close-return",
      payload: { operation: "deterministic" }
    });
    await started.promise;

    const closing = runtime.close();
    release.resolve();
    await closing;
    runtime = undefined;

    const readback = new DatabaseSync(databasePath, { readOnly: true });
    expect(readback.prepare("select status,attempt,lease_generation from jobs where id=?").get(receipt.jobId)).toEqual({
      status: "completed",
      attempt: 1,
      lease_generation: 1
    });
    expect(readback.prepare("select status from step_attempts where job_id=?").all(receipt.jobId)).toEqual([{ status: "completed" }]);
    expect(readback.prepare("select status from checkpoints where job_id=?").all(receipt.jobId)).toEqual([{ status: "committed" }]);
    expect(readback.prepare("select count(*) as count from job_events where job_id=?").get(receipt.jobId)).toEqual({ count: 4 });
    expect(readback.prepare("select count(distinct event_id) as count from job_events where job_id=?").get(receipt.jobId)).toEqual({ count: 4 });
    expect(readback.prepare("select count(*) as count from tool_output_links where job_id=? and promoted=1").get(receipt.jobId)).toEqual({ count: 0 });
    readback.close();

    let restartedExecution = false;
    runtime = new DurableJobRuntime(databasePath, { concurrency: 1, timer: manualTimer() });
    runtime.registerHandler("chat_reply", async () => {
      restartedExecution = true;
    });
    await runtime.initialize();
    expect(restartedExecution).toBe(false);
    await expect(runtime.get(receipt.jobId)).resolves.toMatchObject({ status: "completed" });
  });
});

function createDatabase(): string {
  root = mkdtempSync(join(tmpdir(), "aetherops-runtime-crash-matrix-"));
  const databasePath = join(root, "storage.sqlite");
  const db = new DatabaseSync(databasePath);
  migrateStorageV2Schema(db);
  db.close();
  return databasePath;
}

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

function manualTimer(): DurableRuntimeTimer {
  const scheduled = new Set<ReturnType<typeof setTimeout>>();
  return {
    setTimeout() {
      const handle = {} as ReturnType<typeof setTimeout>;
      scheduled.add(handle);
      return handle;
    },
    clearTimeout(handle) {
      scheduled.delete(handle);
    }
  };
}
