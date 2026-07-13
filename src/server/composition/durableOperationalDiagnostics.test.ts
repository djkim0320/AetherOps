import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { StorageWorkerClient } from "../runtime/storage/worker/typedRuntime.js";
import { migrateStorageV2Schema } from "../runtime/storage/v2/schema.js";
import type { StorageClaimStartResult } from "../runtime/storage/v2/types.js";
import { DurableJobExecutionContext } from "./durableJobExecutionContext.js";
import { DurableJobExecutor } from "./durableJobExecutor.js";
import { DurableJobRuntime } from "./durableJobRuntime.js";
import { DurableJobTraceRuntime } from "./durableJobTraceRuntime.js";
import { resolveDurableRuntimeConfig } from "./durableRuntimeConfig.js";
import { DurableRuntimeDiagnostics } from "./durableRuntimeDiagnostics.js";
import { SseRuntimeDiagnostics } from "./sseRuntimeDiagnostics.js";

const roots: string[] = [];
const initialNow = Date.parse("2026-07-14T00:10:00.000Z");

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("durable operational diagnostics", () => {
  it("merges bounded storage queue gauges with process-local counters and injected-clock ages", async () => {
    let now = initialNow;
    const request = vi.fn(async (command: { name: string }) => {
      if (command.name === "diagnostics.storage") {
        return {
          traceQueries: { queryCount: 2, totalDurationMs: 8, maxDurationMs: 5, lastDurationMs: 3, totalRows: 7, maxRows: 4, lastRows: 3 },
          storageTransactions: { transactionCount: 1, totalDurationMs: 6, maxDurationMs: 6, lastDurationMs: 6 }
        };
      }
      return {
        projects: [{ projectId: "project-a", depth: 2, oldestQueuedAt: "2026-07-14T00:00:00.000Z" }],
        totalDepth: 2,
        oldestQueuedAt: "2026-07-14T00:00:00.000Z",
        totalProjects: 1,
        truncated: false
      };
    });
    const storageClient = { request, close: vi.fn() } as unknown as StorageWorkerClient;
    const sseDiagnostics = new SseRuntimeDiagnostics();
    sseDiagnostics.recordConnectionOpened();
    sseDiagnostics.recordReplay(2, 4);
    const runtime = new DurableJobRuntime("unused.sqlite", { concurrency: 1, clock: { now: () => now }, storageClient, sseDiagnostics });
    now += 5 * 60_000;

    const snapshot = await runtime.operationalDiagnostics();

    expect(request).toHaveBeenCalledWith({ name: "job.queueDiagnostics", limit: 100 });
    expect(request).toHaveBeenCalledWith({ name: "diagnostics.storage" });
    expect(snapshot).toEqual({
      generatedAt: "2026-07-14T00:15:00.000Z",
      countersSince: "2026-07-14T00:10:00.000Z",
      runtime: {
        activeProjectCount: 0,
        activeJobCount: 0,
        leaseRenewalSuccessCount: 0,
        leaseRenewalFailureCount: 0,
        leaseLostCount: 0,
        staleWriteRejectionCount: 0,
        recoveryScannedProjectCount: 0
      },
      sse: {
        activeConnectionCount: 1,
        bufferedEventCount: 0,
        bufferedBytes: 0,
        peakBufferedEventCount: 0,
        peakBufferedBytes: 0,
        slowConsumerDisconnectCount: 0,
        replayCount: 1,
        replayedEventCount: 2,
        replayTotalDurationMs: 4,
        replayMaxDurationMs: 4,
        replayLastDurationMs: 4
      },
      traceQueries: { queryCount: 2, totalDurationMs: 8, maxDurationMs: 5, lastDurationMs: 3, totalRows: 7, maxRows: 4, lastRows: 3 },
      storageTransactions: { transactionCount: 1, totalDurationMs: 6, maxDurationMs: 6, lastDurationMs: 6 },
      queue: {
        projects: [{ projectId: "project-a", depth: 2, oldestQueuedAt: "2026-07-14T00:00:00.000Z", oldestQueuedAgeMs: 900_000 }],
        totalDepth: 2,
        oldestQueuedAt: "2026-07-14T00:00:00.000Z",
        oldestQueuedAgeMs: 900_000,
        totalProjects: 1,
        truncated: false
      }
    });
  });

  it("counts the unique union of expired-lease and runnable projects during recovery", async () => {
    const databasePath = createDatabase("recovery-union");
    const db = new DatabaseSync(databasePath);
    insertJob(db, {
      id: "job-expired",
      projectId: "project-expired",
      status: "running",
      queuedAt: "2026-07-14T00:00:00.000Z",
      leaseOwner: "worker-old",
      leaseExpiresAt: "2026-07-14T00:01:00.000Z"
    });
    insertJob(db, { id: "job-queued", projectId: "project-queued", status: "queued", queuedAt: "2026-07-14T00:02:00.000Z" });
    db.close();
    const runtime = new DurableJobRuntime(databasePath, { concurrency: 1, clock: { now: () => Date.parse("2026-07-14T00:10:00.000Z") } });
    runtime.registerHandler("chat_reply", async (job) => {
      await runtime.finish(job.id, 1);
    });

    await runtime.initialize();

    expect(runtime.diagnosticSnapshot().recoveryScannedProjectCount).toBe(2);
    await runtime.close();
  });

  it("counts stale shutdown and claimed-before-execution writes without double-counting a job lease loss", async () => {
    const diagnostics = new DurableRuntimeDiagnostics();
    const client = rejectingLeaseClient();
    const timer = inertTimer();
    const handlers = new Map();
    handlers.set("chat_reply", async (_job: unknown, _request: unknown, context: { signal: AbortSignal }) => {
      await new Promise<void>((resolve) => context.signal.addEventListener("abort", () => resolve(), { once: true }));
    });
    const executor = new DurableJobExecutor({
      client,
      config: resolveDurableRuntimeConfig({ timer }),
      trace: new DurableJobTraceRuntime(client),
      execution: new DurableJobExecutionContext(),
      handlers,
      diagnostics,
      canWrite: () => true,
      logFailure: vi.fn()
    });
    const claimed = claimedJob("job-shutdown");
    const run = executor.run(claimed);
    await flushMicrotasks();

    await executor.revokeLingeringLeases();
    await run;
    await executor.interruptClaimedBeforeExecution(claimedJob("job-unstarted"));

    expect(diagnostics.snapshot()).toMatchObject({ staleWriteRejectionCount: 2, leaseLostCount: 2 });
  });
});

function createDatabase(label: string): string {
  const root = mkdtempSync(join(tmpdir(), `aetherops-${label}-`));
  roots.push(root);
  const path = join(root, "storage.sqlite");
  const db = new DatabaseSync(path);
  migrateStorageV2Schema(db);
  db.close();
  return path;
}

function insertJob(
  db: DatabaseSync,
  input: { id: string; projectId: string; status: "queued" | "running"; queuedAt: string; leaseOwner?: string; leaseExpiresAt?: string }
): void {
  db.prepare(
    `insert into jobs
     (id,project_id,operation,status,priority,attempt,lease_generation,lease_owner,lease_expires_at,queued_at,started_at,created_at,updated_at,payload)
     values (?,?,?, ?,0,1,1,?,?,?,?,?,?,?)`
  ).run(
    input.id,
    input.projectId,
    "chat_reply",
    input.status,
    input.leaseOwner ?? null,
    input.leaseExpiresAt ?? null,
    input.queuedAt,
    input.status === "running" ? input.queuedAt : null,
    input.queuedAt,
    input.queuedAt,
    JSON.stringify({ projectRevision: 1 })
  );
}

function rejectingLeaseClient(): StorageWorkerClient {
  return {
    request: vi.fn(() => Promise.reject(leaseLostError())),
    close: vi.fn()
  } as unknown as StorageWorkerClient;
}

function inertTimer() {
  const handles = new Set<ReturnType<typeof setTimeout>>();
  return {
    setTimeout: vi.fn(() => {
      const handle = { unref: vi.fn() } as unknown as ReturnType<typeof setTimeout>;
      handles.add(handle);
      return handle;
    }),
    clearTimeout: vi.fn((handle: ReturnType<typeof setTimeout>) => handles.delete(handle))
  };
}

function claimedJob(jobId: string): StorageClaimStartResult {
  const timestamp = "2026-07-14T00:00:00.000Z";
  const fence = { jobId, attempt: 1, leaseOwner: "worker-a", leaseGeneration: 1 };
  return {
    job: {
      id: jobId,
      projectId: `project-${jobId}`,
      operation: "chat_reply",
      status: "running",
      priority: 0,
      attempt: 1,
      leaseGeneration: 1,
      payload: { projectRevision: 1 },
      leaseOwner: fence.leaseOwner,
      leaseExpiresAt: "2099-01-01T00:00:00.000Z",
      queuedAt: timestamp,
      startedAt: timestamp,
      createdAt: timestamp,
      updatedAt: timestamp
    },
    fence,
    event: {
      sequence: 1,
      eventId: `event-${jobId}`,
      projectId: `project-${jobId}`,
      jobId,
      type: "run.status.changed",
      payload: { projectRevision: 1, data: { jobId, status: "running" } },
      createdAt: timestamp
    }
  };
}

function leaseLostError(): Error {
  const error = new Error("lease lost");
  error.name = "LeaseLostError";
  return error;
}

async function flushMicrotasks(): Promise<void> {
  for (let index = 0; index < 8; index += 1) await Promise.resolve();
}
