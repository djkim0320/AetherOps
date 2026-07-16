import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { migrateStorageV2Schema } from "../runtime/storage/v2/schema.js";
import type { StorageWorkerCommand } from "../runtime/storage/worker/typedProtocol.js";
import { StorageWorkerClient, StorageWorkerRuntime } from "../runtime/storage/worker/typedRuntime.js";
import { DurableJobRuntime } from "./durableJobRuntime.js";
import { DurableJobRuntimeTestSupport } from "./durableJobRuntimeTestSupport.js";
import type { DurableRuntimeTimer } from "./durableRuntimeConfig.js";

const LEASE_NOW_MS = Date.parse("2026-07-14T00:00:00.000Z");
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

describe("DurableJobRuntime cross-runtime control", () => {
  it("observes a control requested by another runtime and prevents late completion overwrite", async () => {
    const databasePath = createDatabase();
    const timer = manualTimer();
    const clock = { now: () => LEASE_NOW_MS };
    runtime = new DurableJobRuntime(databasePath, {
      concurrency: 1,
      leaseTtlMs: 1_000,
      leaseRenewalMs: 10,
      leaseSweepMs: 500,
      clock,
      timer,
      storageClient: inProcessStorageClient(databasePath)
    });
    const started = deferred<void>();
    const abortObserved = deferred<void>();
    const cleanupRelease = deferred<void>();
    runtime.registerHandler("chat_reply", async (job, _request, context) => {
      started.resolve();
      await Promise.race([observeAbort(context.signal, abortObserved), cleanupRelease.promise]);
      await support.finishCurrent(job);
    });
    await runtime.initialize();
    const receipt = await support.enqueueCurrent({
      projectId: "project-control",
      kind: "chat_reply",
      idempotencyKey: "control-key",
      payload: {}
    });
    await started.promise;

    const other = new DurableJobRuntime(databasePath, { concurrency: 1, clock, storageClient: inProcessStorageClient(databasePath) });
    try {
      await other.initialize();
      await other.requestAbort(receipt.jobId);
      timer.fireDelay(10);
      await abortObserved.promise;
      await waitUntil(async () => (await runtime?.get(receipt.jobId))?.status === "aborted");
      await expect(runtime.get(receipt.jobId)).resolves.toMatchObject({ status: "aborted" });
    } finally {
      cleanupRelease.resolve();
      await other.close();
    }
  });
});

function createDatabase(): string {
  root = mkdtempSync(join(tmpdir(), "aetherops-durable-cross-runtime-control-"));
  const databasePath = join(root, "storage.sqlite");
  const db = new DatabaseSync(databasePath);
  migrateStorageV2Schema(db);
  db.close();
  return databasePath;
}

function inProcessStorageClient(databasePath: string): StorageWorkerClient {
  const storage = new StorageWorkerRuntime(
    { appDbPath: databasePath, vectorDbPath: databasePath, ontologyDbPath: databasePath, requireFts5: true },
    { leaseClock: () => LEASE_NOW_MS }
  );
  return {
    async request<T>(command: StorageWorkerCommand): Promise<T> {
      return storage.handle(command) as T;
    },
    async close(): Promise<void> {
      storage.close();
    }
  } as StorageWorkerClient;
}

function observeAbort(signal: AbortSignal, observed: { resolve(value: void): void }): Promise<void> {
  return new Promise((resolve) => {
    signal.addEventListener(
      "abort",
      () => {
        observed.resolve();
        resolve();
      },
      { once: true }
    );
  });
}

async function waitUntil(predicate: () => Promise<boolean>): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("Durable async runtime condition timed out.");
}

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

function manualTimer(): DurableRuntimeTimer & { fireDelay(delayMs: number): void } {
  const scheduled = new Map<object, { callback: () => void; delayMs: number }>();
  return {
    setTimeout(callback, delayMs) {
      const handle = {} as ReturnType<typeof setTimeout>;
      scheduled.set(handle, { callback, delayMs });
      return handle;
    },
    clearTimeout(handle) {
      scheduled.delete(handle);
    },
    fireDelay(delayMs) {
      const entry = [...scheduled.entries()].find(([, value]) => value.delayMs === delayMs);
      if (!entry) throw new Error(`No ${delayMs}ms timer is pending.`);
      scheduled.delete(entry[0]);
      entry[1].callback();
    }
  };
}
