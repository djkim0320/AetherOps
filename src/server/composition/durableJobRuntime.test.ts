import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { IDEMPOTENCY_CONFLICT_PUBLIC_MESSAGE } from "../runtime/storage/v2/jobErrors.js";
import type { StorageWorkerCommand } from "../runtime/storage/worker/typedProtocol.js";
import { StorageWorkerClient, StorageWorkerRuntime } from "../runtime/storage/worker/typedRuntime.js";
import { DurableJobRuntime } from "./durableJobRuntime.js";
import type { DurableRuntimeTimer } from "./durableRuntimeConfig.js";
import { migrateStorageV2Schema } from "../runtime/storage/v2/schema.js";

let root: string | undefined;
let runtime: DurableJobRuntime | undefined;

afterEach(async () => {
  await runtime?.close().catch(() => undefined);
  runtime = undefined;
  if (root) rmSync(root, { recursive: true, force: true });
  root = undefined;
});

describe("DurableJobRuntime recovery", () => {
  it("fails enqueue closed when no durable handler is registered", async () => {
    const databasePath = createDatabase("missing-handler");
    runtime = new DurableJobRuntime(databasePath, 1);
    await runtime.initialize();

    await expect(
      runtime.enqueue({ projectId: "project-missing", kind: "chat_reply", projectRevision: 1, idempotencyKey: "missing", payload: {} })
    ).rejects.toThrow(/handler.*registered/i);
  });

  it("keeps a project active until its handler returns even after the handler commits completion", async () => {
    const databasePath = createDatabase("handler-lifetime-lane");
    runtime = new DurableJobRuntime(databasePath, 4);
    const firstMayReturn = deferred<void>();
    const firstCommitted = deferred<void>();
    let secondStarted = false;
    runtime.registerHandler("chat_reply", async (job, request) => {
      const label = (request as { label: string }).label;
      if (label === "first") {
        await runtime?.finish(job.id, 1);
        firstCommitted.resolve();
        await firstMayReturn.promise;
      } else {
        secondStarted = true;
        await runtime?.finish(job.id, 1);
      }
    });
    await runtime.initialize();
    await runtime.enqueue({ projectId: "project-one", kind: "chat_reply", projectRevision: 1, idempotencyKey: "first", payload: { label: "first" } });
    await firstCommitted.promise;
    await runtime.enqueue({ projectId: "project-one", kind: "chat_reply", projectRevision: 1, idempotencyKey: "second", payload: { label: "second" } });

    await flushTurns(20);
    expect(secondStarted).toBe(false);
    firstMayReturn.resolve();
    await waitUntil(() => secondStarted);
  });

  it("discovers runnable projects beyond the first 1,000 rows during startup", async () => {
    const databasePath = createDatabase("recovery-cursor");
    const seed = new DatabaseSync(databasePath);
    const insert = seed.prepare(
      `insert into jobs (id, project_id, operation, status, priority, attempt, idempotency_key, queued_at, created_at, updated_at, payload)
       values (?, ?, 'chat_reply', 'queued', 0, 0, ?, ?, ?, ?, ?)`
    );
    const queuedAt = "2026-07-14T00:00:00.000Z";
    seed.exec("begin immediate");
    for (let index = 0; index < 1_001; index += 1) {
      const suffix = String(index).padStart(4, "0");
      insert.run(`job-${suffix}`, `project-${suffix}`, `key-${suffix}`, queuedAt, queuedAt, queuedAt, JSON.stringify({ projectRevision: 1 }));
    }
    seed.exec("commit");
    seed.close();

    runtime = new DurableJobRuntime(databasePath, 8);
    let handled = 0;
    const firstThousand = deferred<void>();
    runtime.registerHandler("chat_reply", async (job) => {
      handled += 1;
      await runtime?.finish(job.id, 1);
      if (handled === 1_000) firstThousand.resolve();
    });
    await runtime.initialize();
    await firstThousand.promise;
    await waitUntil(() => handled === 1_001);

    expect(handled).toBe(1_001);
  }, 30_000);

  it("returns one shared shutdown promise for concurrent close calls", async () => {
    const databasePath = createDatabase("close-idempotent");
    runtime = new DurableJobRuntime(databasePath, 1);
    await runtime.initialize();
    const first = runtime.close();
    const second = runtime.close();
    expect(second).toBe(first);
    await first;
    runtime = undefined;
  });

  it("bounds shutdown, revokes an ignored handler lease, and leaves restart-readable state", async () => {
    const databasePath = createDatabase("close-revoke");
    const timer = manualTimer();
    runtime = new DurableJobRuntime(databasePath, { concurrency: 1, shutdownGraceMs: 1, timer });
    const started = deferred<void>();
    const release = deferred<void>();
    runtime.registerHandler("chat_reply", async (job) => {
      started.resolve();
      await release.promise;
      await runtime?.finish(job.id, 2);
    });
    await runtime.initialize();
    const receipt = await runtime.enqueue({
      projectId: "project-close",
      kind: "chat_reply",
      projectRevision: 1,
      idempotencyKey: "close-key",
      payload: {}
    });
    await started.promise;
    expect(timer.hasDelay(20_000)).toBe(true);

    const closing = runtime.close();
    timer.fireDelay(1);
    await flushTurns(2);
    timer.fireDelay(1);
    await closing;
    expect(timer.hasDelay(20_000)).toBe(false);
    const verify = new DatabaseSync(databasePath, { readOnly: true });
    const row = verify.prepare("select status from jobs where id=?").get(receipt.jobId) as { status: string };
    verify.close();
    expect(row.status).toBe("interrupted");

    release.resolve();
    await flushTurns(10);
    runtime = undefined;
  });

  it("interrupts a claim that commits after shutdown starts without running its handler", async () => {
    const databasePath = createDatabase("close-claim-race");
    const storage = new StorageWorkerRuntime({
      appDbPath: databasePath,
      vectorDbPath: databasePath,
      ontologyDbPath: databasePath,
      requireFts5: true
    });
    const claimStarted = deferred<void>();
    const releaseClaim = deferred<void>();
    const storageClient = {
      async request<T>(command: StorageWorkerCommand): Promise<T> {
        if (command.name === "job.claimAndStart") {
          claimStarted.resolve();
          await releaseClaim.promise;
        }
        return storage.handle(command) as T;
      },
      async close(): Promise<void> {
        storage.close();
      }
    } as unknown as StorageWorkerClient;
    runtime = new DurableJobRuntime(databasePath, { concurrency: 1, storageClient });
    let handlerRan = false;
    runtime.registerHandler("chat_reply", async () => {
      handlerRan = true;
    });
    await runtime.initialize();
    const receipt = await runtime.enqueue({
      projectId: "project-close-claim",
      kind: "chat_reply",
      projectRevision: 1,
      idempotencyKey: "close-claim-key",
      payload: {}
    });
    await claimStarted.promise;

    const closing = runtime.close();
    releaseClaim.resolve();
    await closing;

    const verify = new DatabaseSync(databasePath, { readOnly: true });
    const stored = verify.prepare("select status from jobs where id=?").get(receipt.jobId) as { status: string };
    const events = verify.prepare("select type from job_events where job_id=? order by sequence").all(receipt.jobId) as Array<{ type: string }>;
    verify.close();
    expect(handlerRan).toBe(false);
    expect(stored.status).toBe("interrupted");
    expect(events.map((event) => event.type)).toEqual(["run.status.changed", "run.status.changed", "run.status.changed"]);
    runtime = undefined;
  });

  it("reports the stored terminal status when an idempotent enqueue is replayed", async () => {
    const databasePath = createDatabase("terminal-receipt");
    runtime = new DurableJobRuntime(databasePath, 1);
    runtime.registerHandler("chat_reply", async (job) => {
      await runtime?.finish(job.id, 7);
    });
    await runtime.initialize();
    const input = {
      projectId: "project-terminal",
      kind: "chat_reply" as const,
      projectRevision: 7,
      idempotencyKey: "terminal-key",
      payload: { message: "same" }
    };
    const first = await runtime.enqueue(input);
    await waitUntilAsync(async () => (await runtime?.get(first.jobId))?.status === "completed");

    const replay = await runtime.enqueue(input);
    expect(replay).toMatchObject({ jobId: first.jobId, status: "completed" });
    expect(replay).not.toHaveProperty("queuePosition");
  });

  it("rejects an explicit checkpoint outside the active leased handler", async () => {
    const databasePath = createDatabase("step-checkpoint");
    const seed = new DatabaseSync(databasePath);
    const now = new Date().toISOString();
    seed
      .prepare(
        `insert into jobs (id, project_id, operation, status, priority, attempt, idempotency_key,
         queued_at, created_at, updated_at, payload) values (?, ?, 'research_loop', 'running', 0, 1, ?, ?, ?, ?, ?)`
      )
      .run("job-step", "project-step", "step-key", now, now, now, JSON.stringify({ projectRevision: 3 }));
    seed.close();
    runtime = new DurableJobRuntime(databasePath, 1);

    await expect(runtime.commitCheckpoint({ projectId: "project-step", jobId: "job-step", step: "EXECUTE_TOOLS", projectRevision: 3 })).rejects.toThrow(
      /active lease fence/
    );
    await expect(runtime.latestCommittedCheckpoint("job-step")).resolves.toBeUndefined();
    await expect(runtime.eventsAfter("project-step")).resolves.toEqual([]);
  });

  it("runs a persisted queued job through the registered handler and commits only the completed checkpoint", async () => {
    root = mkdtempSync(join(tmpdir(), "aetherops-durable-runtime-"));
    const databasePath = join(root, "storage.sqlite");
    const seed = new DatabaseSync(databasePath);
    migrateStorageV2Schema(seed);
    const now = new Date().toISOString();
    seed
      .prepare(
        `insert into jobs (id, project_id, operation, status, priority, attempt, idempotency_key, queued_at, created_at, updated_at, payload)
      values (?, ?, ?, 'queued', 0, 0, ?, ?, ?, ?, ?)`
      )
      .run(
        "job-recovered",
        "project-recovered",
        "chat_reply",
        "recover-key",
        now,
        now,
        now,
        JSON.stringify({ kind: "chat_reply", projectRevision: 1, currentStep: "PLAN_RESEARCH", request: { content: "persisted" } })
      );
    seed.close();

    runtime = new DurableJobRuntime(databasePath, 1);
    let resolveHandled!: () => void;
    const handled = new Promise<void>((resolve) => {
      resolveHandled = resolve;
    });
    runtime.registerHandler("chat_reply", async (job, request) => {
      expect(request).toEqual({ content: "persisted" });
      await runtime.finish(job.id, 2);
      resolveHandled();
    });
    await runtime.initialize();
    await Promise.race([handled, timeout(5_000)]);
    await waitUntilAsync(async () => (await runtime?.get("job-recovered"))?.status === "completed");
    await waitForCheckpoint(databasePath);
    await runtime.close();
    runtime = undefined;

    const verify = new DatabaseSync(databasePath, { readOnly: true });
    const checkpoints = verify.prepare("select status, data from checkpoints where job_id=?").all("job-recovered") as Array<{ status: string; data: string }>;
    verify.close();
    expect(checkpoints).toHaveLength(1);
    expect(checkpoints[0]?.status).toBe("committed");
    expect(JSON.parse(checkpoints[0]?.data ?? "{}")).toMatchObject({ phase: "execute_tools_completed" });
  });

  it("deduplicates idempotency keys, serializes each project FIFO, and runs different projects concurrently", async () => {
    const databasePath = createDatabase("lane");
    runtime = new DurableJobRuntime(databasePath, 2);
    const started: string[] = [];
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    runtime.registerHandler("chat_reply", async (job, request) => {
      const label = String((request as { label?: string }).label);
      started.push(label);
      if (label === "a-1") await firstGate;
      await runtime?.finish(job.id, 1);
    });
    await runtime.initialize();

    const first = await runtime.enqueue({
      projectId: "project-a",
      kind: "chat_reply",
      projectRevision: 1,
      currentStep: "PLAN_RESEARCH",
      idempotencyKey: "a-1",
      payload: { label: "a-1" }
    });
    const duplicate = await runtime.enqueue({
      projectId: "project-a",
      kind: "chat_reply",
      projectRevision: 99,
      currentStep: "FINALIZE_OUTPUT",
      idempotencyKey: "a-1",
      payload: { label: "a-1" }
    });
    await expect(
      runtime.enqueue({ projectId: "project-a", kind: "chat_reply", projectRevision: 1, idempotencyKey: "a-1", payload: { label: "changed" } })
    ).rejects.toThrow(IDEMPOTENCY_CONFLICT_PUBLIC_MESSAGE);
    await runtime.enqueue({ projectId: "project-a", kind: "chat_reply", projectRevision: 1, idempotencyKey: "a-2", payload: { label: "a-2" } });
    await runtime.enqueue({ projectId: "project-b", kind: "chat_reply", projectRevision: 1, idempotencyKey: "b-1", payload: { label: "b-1" } });

    expect(duplicate.jobId).toBe(first.jobId);
    await waitUntil(() => started.includes("a-1") && started.includes("b-1"));
    expect(started).not.toContain("a-2");
    releaseFirst();
    await waitUntil(() => started.includes("a-2"));
    expect(started.filter((label) => label === "a-1")).toHaveLength(1);
  });

  it("serializes simultaneous enqueues for one project without duplicate execution or events", async () => {
    const databasePath = createDatabase("simultaneous-enqueue");
    runtime = new DurableJobRuntime(databasePath, 4);
    const firstStarted = deferred<void>();
    const releaseFirst = deferred<void>();
    const allCompleted = deferred<void>();
    const executed = new Set<string>();
    let active = 0;
    let maxActive = 0;
    let completedEvents = 0;
    runtime.subscribe((event) => {
      if (event.type === "run.status.changed" && event.data.status === "completed") {
        completedEvents += 1;
        if (completedEvents === 12) allCompleted.resolve();
      }
    });
    runtime.registerHandler("chat_reply", async (job) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      executed.add(job.id);
      if (executed.size === 1) {
        firstStarted.resolve();
        await releaseFirst.promise;
      }
      await runtime?.finish(job.id, 1);
      active -= 1;
    });
    await runtime.initialize();

    const receiptsPromise = Promise.all(
      Array.from({ length: 12 }, (_, index) =>
        runtime?.enqueue({
          projectId: "project-simultaneous",
          kind: "chat_reply",
          projectRevision: 1,
          idempotencyKey: `simultaneous-${index}`,
          payload: { index }
        })
      )
    );
    await firstStarted.promise;
    const receipts = await receiptsPromise;
    await flushTurns(8);
    expect(maxActive).toBe(1);
    expect(executed.size).toBe(1);

    releaseFirst.resolve();
    await allCompleted.promise;
    expect(maxActive).toBe(1);
    expect(executed.size).toBe(12);
    expect(new Set(receipts.map((receipt) => receipt?.jobId)).size).toBe(12);

    const verify = new DatabaseSync(databasePath, { readOnly: true });
    expect(
      verify
        .prepare("select count(*) as count from jobs where project_id=? and status='completed' and attempt=1 and lease_generation=1")
        .get("project-simultaneous")
    ).toEqual({
      count: 12
    });
    expect(verify.prepare("select count(*) as count from job_events where project_id=?").get("project-simultaneous")).toEqual({ count: 36 });
    expect(verify.prepare("select count(distinct event_id) as count from job_events where project_id=?").get("project-simultaneous")).toEqual({ count: 36 });
    verify.close();
  });

  it("marks an expired running lease interrupted during startup recovery", async () => {
    const databasePath = createDatabase("expired");
    const seed = new DatabaseSync(databasePath);
    const now = new Date().toISOString();
    seed
      .prepare(
        `insert into jobs (id, project_id, operation, status, priority, attempt, idempotency_key, lease_owner, lease_expires_at, queued_at, started_at, created_at, updated_at, payload)
        values (?, ?, ?, 'running', 0, 1, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        "job-expired",
        "project-expired",
        "chat_reply",
        "expired-key",
        "dead-worker",
        "2000-01-01T00:00:00.000Z",
        now,
        now,
        now,
        now,
        JSON.stringify({ kind: "chat_reply", projectRevision: 1 })
      );
    seed.close();

    runtime = new DurableJobRuntime(databasePath, 1);
    await runtime.initialize();

    await expect(runtime.get("job-expired")).resolves.toMatchObject({ status: "interrupted", failureReason: "Worker lease expired." });
  });

  it("commits tool attempt state with its public lifecycle event and exposes detailed trace only from getDetail", async () => {
    const databasePath = createDatabase("trace");
    const now = new Date().toISOString();
    runtime = new DurableJobRuntime(databasePath, 1);
    const eventIds: number[] = [];
    runtime.subscribe((item) => eventIds.push(item.id));
    runtime.registerHandler("research_loop", async (job) => {
      await runtime?.recordToolDecision({
        id: "decision-1",
        projectId: job.projectId,
        jobId: job.id,
        toolName: "WebFetchTool",
        purpose: "Fetch the pinned source.",
        expectedOutcome: "A validated source.",
        rawSelection: { inputHash: "a".repeat(64) },
        userPinned: true,
        policyStatus: "accepted",
        createdAt: now
      });
      const attempt = {
        id: "attempt-1",
        projectId: job.projectId,
        jobId: job.id,
        decisionId: "decision-1",
        ordinal: 0,
        inputHash: "a".repeat(64),
        dependsOnAttemptIds: [],
        queuedAt: now
      };
      await runtime?.recordToolAttemptAndEvent({
        projectRevision: 3,
        toolName: "WebFetchTool",
        attempt: { ...attempt, status: "queued" }
      });
      await runtime?.recordToolAttemptAndEvent({
        projectRevision: 3,
        toolName: "WebFetchTool",
        attempt: { ...attempt, status: "running", startedAt: now }
      });
      await runtime?.recordToolAttemptAndEvent({
        projectRevision: 3,
        toolName: "WebFetchTool",
        attempt: {
          ...attempt,
          status: "completed",
          outputHash: "b".repeat(64),
          terminalCause: "completed",
          startedAt: now,
          completedAt: now
        }
      });
      await runtime?.finish(job.id, 3);
    });
    await runtime.initialize();
    const receipt = await runtime.enqueue({
      projectId: "project-trace",
      kind: "research_loop",
      projectRevision: 3,
      idempotencyKey: "trace-key",
      requestHash: "request-hash",
      payload: {}
    });
    await waitUntilAsync(async () => (await runtime?.get(receipt.jobId))?.status === "completed");
    const detail = await runtime.getDetail(receipt.jobId);
    const list = await runtime.list("project-trace");
    expect(detail).toMatchObject({
      traceAvailability: "available",
      trace: {
        toolDecisions: [{ id: "decision-1" }],
        toolAttempts: [{ id: "attempt-1", status: "completed" }]
      }
    });
    expect(list.jobs[0]).not.toHaveProperty("trace");
    expect(eventIds.length).toBeGreaterThanOrEqual(3);
    await expect(runtime.eventsAfter("project-trace")).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: expect.any(Number),
          projectId: "project-trace",
          projectRevision: 3,
          occurredAt: expect.any(String),
          type: "tool.run.changed",
          data: expect.objectContaining({ decisionId: "decision-1", attemptId: "attempt-1", ordinal: 0, status: "queued" })
        }),
        expect.objectContaining({
          type: "tool.run.changed",
          data: expect.objectContaining({ decisionId: "decision-1", attemptId: "attempt-1", ordinal: 0, status: "running" })
        }),
        expect.objectContaining({
          type: "tool.run.changed",
          data: expect.objectContaining({ decisionId: "decision-1", attemptId: "attempt-1", ordinal: 0, status: "completed" })
        })
      ])
    );
  });
});

function createDatabase(label: string): string {
  root = mkdtempSync(join(tmpdir(), `aetherops-durable-${label}-`));
  const databasePath = join(root, "storage.sqlite");
  const db = new DatabaseSync(databasePath);
  migrateStorageV2Schema(db);
  db.close();
  return databasePath;
}

function timeout(ms: number): Promise<never> {
  return new Promise((_, reject) => setTimeout(() => reject(new Error("Durable job handler timed out.")), ms));
}

async function waitForCheckpoint(databasePath: string): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const db = new DatabaseSync(databasePath, { readOnly: true });
    const row = db.prepare("select count(*) as count from checkpoints where job_id=?").get("job-recovered") as { count: number };
    db.close();
    if (row.count === 1) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("Completed checkpoint was not committed.");
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("Durable runtime condition timed out.");
}

async function waitUntilAsync(predicate: () => Promise<boolean>): Promise<void> {
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

async function flushTurns(count: number): Promise<void> {
  for (let index = 0; index < count; index += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

function manualTimer(): DurableRuntimeTimer & { fireDelay(delayMs: number): void; hasDelay(delayMs: number): boolean } {
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
    },
    hasDelay(delayMs) {
      return [...scheduled.values()].some((entry) => entry.delayMs === delayMs);
    }
  };
}
