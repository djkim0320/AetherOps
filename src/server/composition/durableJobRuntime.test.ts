import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { DurableJobRuntime } from "./durableJobRuntime.js";
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
  it("commits an explicit step checkpoint and its SSE event atomically", async () => {
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

    const checkpoint = await runtime.commitCheckpoint({
      projectId: "project-step",
      jobId: "job-step",
      step: "EXECUTE_TOOLS",
      projectRevision: 3
    });

    await expect(runtime.latestCommittedCheckpoint("job-step")).resolves.toMatchObject({ id: checkpoint.id, status: "committed" });
    await expect(runtime.eventsAfter("project-step")).resolves.toEqual([
      expect.objectContaining({ type: "run.step.changed", data: { jobId: "job-step", step: "EXECUTE_TOOLS", checkpointId: checkpoint.id } })
    ]);
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
    expect((await runtime.get("job-recovered"))?.status).toBe("completed");
    await waitForCheckpoint(databasePath);
    await runtime.close();
    runtime = undefined;

    const verify = new DatabaseSync(databasePath, { readOnly: true });
    const checkpoints = verify.prepare("select status, data from checkpoints where job_id=?").all("job-recovered") as Array<{ status: string; data: string }>;
    verify.close();
    expect(checkpoints).toHaveLength(1);
    expect(checkpoints[0]?.status).toBe("committed");
    expect(JSON.parse(checkpoints[0]?.data ?? "{}")).toMatchObject({ phase: "step_completed" });
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

    const first = await runtime.enqueue({ projectId: "project-a", kind: "chat_reply", projectRevision: 1, idempotencyKey: "a-1", payload: { label: "a-1" } });
    const duplicate = await runtime.enqueue({
      projectId: "project-a",
      kind: "chat_reply",
      projectRevision: 1,
      idempotencyKey: "a-1",
      payload: { label: "a-1" }
    });
    await expect(
      runtime.enqueue({ projectId: "project-a", kind: "chat_reply", projectRevision: 1, idempotencyKey: "a-1", payload: { label: "changed" } })
    ).rejects.toThrow(/request hash does not match/);
    await runtime.enqueue({ projectId: "project-a", kind: "chat_reply", projectRevision: 1, idempotencyKey: "a-2", payload: { label: "a-2" } });
    await runtime.enqueue({ projectId: "project-b", kind: "chat_reply", projectRevision: 1, idempotencyKey: "b-1", payload: { label: "b-1" } });

    expect(duplicate.jobId).toBe(first.jobId);
    await waitUntil(() => started.includes("a-1") && started.includes("b-1"));
    expect(started).not.toContain("a-2");
    releaseFirst();
    await waitUntil(() => started.includes("a-2"));
    expect(started.filter((label) => label === "a-1")).toHaveLength(1);
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
    const seed = new DatabaseSync(databasePath);
    const now = new Date().toISOString();
    seed
      .prepare(
        `insert into jobs (id, project_id, operation, status, priority, attempt, idempotency_key, request_hash, queued_at, created_at, updated_at, payload)
         values (?, ?, ?, 'queued', 0, 0, ?, ?, ?, ?, ?, ?)`
      )
      .run("job-trace", "project-trace", "research_loop", "trace-key", "request-hash", now, now, now, JSON.stringify({ projectRevision: 3 }));
    seed.close();
    runtime = new DurableJobRuntime(databasePath, 1);
    const eventIds: number[] = [];
    runtime.subscribe((item) => eventIds.push(item.id));
    await runtime.recordToolDecision({
      id: "decision-1",
      projectId: "project-trace",
      jobId: "job-trace",
      toolName: "WebFetchTool",
      purpose: "Fetch the pinned source.",
      expectedOutcome: "A validated source.",
      rawSelection: { url: "https://example.com/source" },
      userPinned: true,
      policyStatus: "accepted",
      createdAt: now
    });
    await runtime.recordToolAttemptAndEvent({
      projectRevision: 3,
      toolName: "WebFetchTool",
      attempt: {
        id: "attempt-1",
        projectId: "project-trace",
        jobId: "job-trace",
        decisionId: "decision-1",
        ordinal: 0,
        status: "queued",
        inputHash: "input-hash",
        queuedAt: now
      }
    });
    const detail = await runtime.getDetail("job-trace");
    const list = await runtime.list("project-trace");
    expect(detail).toMatchObject({
      traceAvailability: "available",
      trace: {
        toolDecisions: [{ id: "decision-1" }],
        toolAttempts: [{ id: "attempt-1", status: "queued" }]
      }
    });
    expect(list.jobs[0]).not.toHaveProperty("trace");
    expect(eventIds).toHaveLength(1);
    await expect(runtime.eventsAfter("project-trace")).resolves.toMatchObject([
      {
        type: "tool.run.changed",
        data: { decisionId: "decision-1", attemptId: "attempt-1", ordinal: 0, status: "queued" }
      }
    ]);
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
