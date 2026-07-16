import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { StorageWorkerCommand } from "../runtime/storage/worker/typedProtocol.js";
import { StorageWorkerRuntime, type StorageWorkerClient } from "../runtime/storage/worker/typedRuntime.js";
import type { StorageOutputPromotion, StoragePostCommitReconciliationWarning, StorageTerminalTransitionResult } from "../runtime/storage/v2/jobAtomicTypes.js";
import { migrateStorageV2Schema } from "../runtime/storage/v2/schema.js";
import type { StorageClaimStartResult, StorageJobEvent } from "../runtime/storage/v2/types.js";
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
      await runtime.finish(job.id, await requiredProjectRevision(runtime, job.projectId));
    });

    await runtime.initialize();

    expect((await runtime.operationalDiagnostics()).runtime.recoveryScannedProjectCount).toBe(2);
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
      logFailure: vi.fn(),
      recordPostCommitWarning: vi.fn()
    });
    const claimed = claimedJob("job-shutdown");
    const run = executor.run(claimed);
    await flushMicrotasks();

    await executor.revokeLingeringLeases();
    await run;
    await executor.interruptClaimedBeforeExecution(claimedJob("job-unstarted"));

    expect(diagnostics.snapshot()).toMatchObject({ staleWriteRejectionCount: 2, leaseLostCount: 2 });
  });

  it("records post-commit reconciliation warnings before publishing committed SSE events", async () => {
    const claimed = claimedJob("job-post-commit-warning");
    const warning: StoragePostCommitReconciliationWarning = {
      code: "ENGINEERING_CAS_FINALIZE_DEFERRED",
      operation: "engineering_cas_finalize",
      severity: "warning",
      message: "Engineering CAS journal finalization was deferred to durable startup reconciliation.",
      affectedObjectCount: 1
    };
    const event = {
      ...claimed.event,
      sequence: 2,
      eventId: "event-post-commit-completed",
      payload: { projectRevision: 1, data: { jobId: claimed.job.id, status: "completed" } }
    };
    const committed: StorageTerminalTransitionResult = {
      job: { ...claimed.job, status: "completed", completedAt: "2026-07-14T00:00:01.000Z" },
      event,
      events: [event],
      links: [],
      postCommitWarnings: [warning]
    };
    const request = vi.fn(async (command: { name: string }) => {
      if (command.name === "project.revision.get") return revisionHead(claimed);
      if (command.name === "job.transitionTerminal") return committed;
      throw new Error(`Unexpected command: ${command.name}`);
    });
    const client = { request, close: vi.fn() } as unknown as StorageWorkerClient;
    const execution = new DurableJobExecutionContext();
    const trace = new DurableJobTraceRuntime(client);
    const order: string[] = [];
    trace.subscribe(() => order.push("publish"));
    const recorded: StoragePostCommitReconciliationWarning[] = [];
    const handlers = new Map();
    handlers.set("chat_reply", async (job: { id: string }) => {
      execution.settle(job.id, { status: "completed", projectRevision: 1 });
    });
    const executor = new DurableJobExecutor({
      client,
      config: resolveDurableRuntimeConfig({ timer: inertTimer() }),
      trace,
      execution,
      handlers,
      diagnostics: new DurableRuntimeDiagnostics(),
      canWrite: () => true,
      logFailure: vi.fn(),
      recordPostCommitWarning: (value, jobId, projectId) => {
        order.push("warning");
        recorded.push(value);
        expect({ jobId, projectId }).toEqual({ jobId: claimed.job.id, projectId: claimed.job.projectId });
      }
    });

    await executor.run(claimed);

    expect(recorded).toEqual([warning]);
    expect(order).toEqual(["warning", "publish"]);
    expect(request).toHaveBeenCalledWith(expect.objectContaining({ name: "job.transitionTerminal", input: expect.objectContaining({ status: "completed" }) }));
  });

  it("records an integrity warning and suppresses live SSE publication for the committed result", async () => {
    const claimed = claimedJob("job-post-commit-integrity");
    const warning: StoragePostCommitReconciliationWarning = {
      code: "ENGINEERING_CAS_INTEGRITY_RECONCILIATION_REQUIRED",
      operation: "engineering_cas_integrity",
      severity: "error",
      message: "Committed engineering CAS integrity requires fail-closed startup reconciliation before further trusted readback.",
      affectedObjectCount: 1
    };
    const event = terminalEvent(claimed, "completed", 2);
    const request = vi.fn(async (command: { name: string }) =>
      command.name === "project.revision.get" ? revisionHead(claimed) : terminalResult(claimed, "completed", event, [warning])
    );
    const client = { request, close: vi.fn() } as unknown as StorageWorkerClient;
    const execution = new DurableJobExecutionContext();
    const trace = new DurableJobTraceRuntime(client);
    const publish = vi.fn();
    trace.subscribe(publish);
    const record = vi.fn();
    const handlers = new Map();
    handlers.set("chat_reply", async (job: { id: string }) => {
      execution.settle(job.id, { status: "completed", projectRevision: 1 });
    });
    const executor = new DurableJobExecutor({
      client,
      config: resolveDurableRuntimeConfig({ timer: inertTimer() }),
      trace,
      execution,
      handlers,
      diagnostics: new DurableRuntimeDiagnostics(),
      canWrite: () => true,
      logFailure: vi.fn(),
      recordPostCommitWarning: record
    });

    await executor.run(claimed);

    expect(record).toHaveBeenCalledWith(warning, claimed.job.id, claimed.job.projectId);
    expect(publish).not.toHaveBeenCalled();
  });

  it("aborts owner-scoped CAS claims before settling a pre-command terminal persistence failure", async () => {
    const claimed = claimedJob("job-pre-command-cleanup");
    const promotion = pendingPromotion(claimed);
    const event = terminalEvent(claimed, "failed", 2);
    const commandOrder: string[] = [];
    let transitionCalls = 0;
    const request = vi.fn(async (command: { name: string }) => {
      commandOrder.push(command.name);
      if (command.name === "project.revision.get") return revisionHead(claimed);
      if (command.name === "job.transitionTerminal") {
        transitionCalls += 1;
        if (transitionCalls === 1) throw new Error("injected transport failure before command dispatch");
        return terminalResult(claimed, "failed", event);
      }
      if (command.name === "engineering.cas.abort") {
        return { removedJournals: 1, removedObjects: 1, preservedReferenced: 0, preservedPending: 0, deferredUnowned: 0 };
      }
      throw new Error(`Unexpected command: ${command.name}`);
    });
    const client = { request, close: vi.fn() } as unknown as StorageWorkerClient;
    const execution = new DurableJobExecutionContext();
    const handlers = new Map();
    handlers.set("chat_reply", async (job: { id: string }) => execution.settle(job.id, { status: "completed", projectRevision: 1, promotions: [promotion] }));
    const executor = new DurableJobExecutor({
      client,
      config: resolveDurableRuntimeConfig({ timer: inertTimer() }),
      trace: new DurableJobTraceRuntime(client),
      execution,
      handlers,
      diagnostics: new DurableRuntimeDiagnostics(),
      canWrite: () => true,
      logFailure: vi.fn(),
      recordPostCommitWarning: vi.fn()
    });

    await executor.run(claimed);

    expect(commandOrder).toEqual(["project.revision.get", "job.transitionTerminal", "engineering.cas.abort", "project.revision.get", "job.transitionTerminal"]);
    expect(request).toHaveBeenCalledWith({
      name: "engineering.cas.abort",
      fence: claimed.fence,
      claims: [
        {
          object: promotion.pendingCasObject,
          owner: {
            projectId: claimed.job.projectId,
            jobId: claimed.job.id,
            attemptId: "attempt-pre-command",
            outputKind: "artifact",
            outputId: "artifact-pre-command"
          }
        }
      ]
    });
  });

  it("drains the runtime and withholds terminal SSE when storage reports committed CAS integrity risk", async () => {
    const databasePath = createDatabase("integrity-warning-drain");
    const storage = new StorageWorkerRuntime({
      appDbPath: databasePath,
      vectorDbPath: databasePath,
      ontologyDbPath: databasePath
    });
    const warning: StoragePostCommitReconciliationWarning = {
      code: "ENGINEERING_CAS_INTEGRITY_RECONCILIATION_REQUIRED",
      operation: "engineering_cas_integrity",
      severity: "error",
      message: "Committed engineering CAS integrity requires fail-closed startup reconciliation before further trusted readback.",
      affectedObjectCount: 1
    };
    const storageClient = {
      async request<T>(command: StorageWorkerCommand): Promise<T> {
        const result = storage.handle(command);
        if (command.name === "job.transitionTerminal" && command.input.status === "completed") {
          return { ...(result as StorageTerminalTransitionResult), postCommitWarnings: [warning] } as T;
        }
        return result as T;
      },
      async close(): Promise<void> {
        storage.close();
      }
    } as StorageWorkerClient;
    const runtime = new DurableJobRuntime(databasePath, { concurrency: 1, storageClient });
    const publishedStatuses: string[] = [];
    runtime.subscribe((event) => {
      const status = (event.data as { status?: unknown }).status;
      if (typeof status === "string") publishedStatuses.push(status);
    });
    runtime.registerHandler("chat_reply", async (job) => {
      await runtime.finish(job.id, await requiredProjectRevision(runtime, job.projectId));
    });
    const warningLog = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    try {
      await runtime.initialize();
      const projectId = "project-integrity-warning";
      const timestamp = "2026-07-14T00:00:00.000Z";
      await runtime.syncProject({
        id: projectId,
        projectRoot: join(dirname(databasePath), projectId),
        topic: projectId,
        status: "active",
        createdAt: timestamp,
        updatedAt: timestamp
      });
      const receipt = await runtime.enqueue({
        projectId,
        kind: "chat_reply",
        projectRevision: await requiredProjectRevision(runtime, projectId),
        idempotencyKey: "integrity-warning",
        payload: {}
      });
      await waitUntilAsync(async () => (await runtime.get(receipt.jobId))?.status === "completed");

      await expect(
        runtime.enqueue({
          projectId: "project-after-integrity-warning",
          kind: "chat_reply",
          projectRevision: 1,
          idempotencyKey: "must-not-enqueue",
          payload: {}
        })
      ).rejects.toThrow(/not accepting/i);
      expect(publishedStatuses).not.toContain("completed");
      expect(warningLog).toHaveBeenCalledOnce();
    } finally {
      warningLog.mockRestore();
      await runtime.close();
    }
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
  const project = {
    id: input.projectId,
    projectRoot: join(tmpdir(), `aetherops-${input.projectId}`),
    topic: input.projectId,
    status: "active",
    createdAt: input.queuedAt,
    updatedAt: input.queuedAt
  };
  db.prepare(
    `insert into projects_v2 (id,short_id,project_root,topic,status,created_at,updated_at,data)
     values (?,?,?,?,?,?,?,?) on conflict(id) do nothing`
  ).run(project.id, project.id, project.projectRoot, project.topic, project.status, project.createdAt, project.updatedAt, JSON.stringify(project));
  db.prepare("insert into project_revision_heads (project_id,revision,last_receipt_id,updated_at) values (?,0,null,?) on conflict(project_id) do nothing").run(
    project.id,
    project.updatedAt
  );
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

function terminalEvent(claimed: StorageClaimStartResult, status: "completed" | "failed", sequence: number): StorageJobEvent {
  return {
    ...claimed.event,
    sequence,
    eventId: `event-${claimed.job.id}-${status}`,
    payload: { projectRevision: 1, data: { jobId: claimed.job.id, status } }
  };
}

function revisionHead(claimed: StorageClaimStartResult) {
  return { projectId: claimed.job.projectId, revision: 1, lastReceiptId: "receipt-test", updatedAt: claimed.job.updatedAt };
}

async function requiredProjectRevision(runtime: DurableJobRuntime, projectId: string): Promise<number> {
  const revision = await runtime.getProjectRevision(projectId);
  if (revision === undefined) throw new Error(`Missing test project revision: ${projectId}.`);
  return revision;
}

function terminalResult(
  claimed: StorageClaimStartResult,
  status: "completed" | "failed",
  event: StorageJobEvent,
  postCommitWarnings?: StoragePostCommitReconciliationWarning[]
): StorageTerminalTransitionResult {
  return {
    job: { ...claimed.job, status, completedAt: "2026-07-14T00:00:01.000Z" },
    event,
    events: [event],
    links: [],
    ...(postCommitWarnings ? { postCommitWarnings } : {})
  };
}

function pendingPromotion(claimed: StorageClaimStartResult): StorageOutputPromotion {
  const casHash = "a".repeat(64);
  const artifact = { casLocator: `terminal-cas/sha256/aa/${casHash}`, sha256: casHash, byteLength: 17 };
  return {
    link: {
      id: "output-link-pre-command",
      projectId: claimed.job.projectId,
      jobId: claimed.job.id,
      attemptId: "attempt-pre-command",
      outputKind: "artifact",
      outputId: "artifact-pre-command",
      promoted: true,
      createdAt: "2026-07-14T00:00:00.000Z",
      promotedAt: "2026-07-14T00:00:01.000Z"
    },
    engineering: { artifact } as NonNullable<StorageOutputPromotion["engineering"]>,
    pendingCasObject: { casLocator: artifact.casLocator, casHash, byteLength: artifact.byteLength, pendingClaimId: "12345678-1234-4123-8123-123456789abc" }
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

async function waitUntilAsync(predicate: () => Promise<boolean>): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Timed out waiting for durable runtime state.");
}
