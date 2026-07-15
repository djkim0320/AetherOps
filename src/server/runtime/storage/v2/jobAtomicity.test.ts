import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { StorageWorkerRuntime } from "../worker/typedRuntime.js";
import { createStorageV2Repositories } from "./repositories.js";
import { migrateStorageV2Schema } from "./schema.js";
import type { StorageClaimStartResult, StorageJob, StorageStepDispositionInput, StorageStepDispositionResult } from "./types.js";

let root: string | undefined;
let runtime: StorageWorkerRuntime | undefined;
let leaseNowMs = Date.parse("2026-07-14T00:00:01.000Z");

afterEach(() => {
  runtime?.close();
  runtime = undefined;
  if (root) rmSync(root, { recursive: true, force: true });
  root = undefined;
});

describe("durable job transaction fault injection", () => {
  it("recovers a claim committed immediately before process loss without duplicate execution or events", () => {
    const path = createRuntime();
    runtime?.handle({ name: "job.enqueue", job: jobInput("job-crashed-after-claim", "project-claim-crash") });
    const crashed = runtime?.handle({ name: "job.claimAndStart", options: claimOptions("project-claim-crash") }) as StorageClaimStartResult;
    runtime?.handle({ name: "job.enqueue", job: jobInput("job-successor-after-crash", "project-claim-crash") });
    expect(crashed.job).toMatchObject({ status: "running", attempt: 1, leaseGeneration: 1 });

    runtime?.close();
    setLeaseNow("2026-07-14T00:02:00.000Z");
    runtime = createStorageWorkerRuntime(path);
    expect(runtime.handle({ name: "job.markInterruptedExpiredLeases", now: "2026-07-14T00:02:00.000Z" })).toMatchObject({
      jobs: [{ id: "job-crashed-after-claim", status: "interrupted", attempt: 1, leaseGeneration: 1 }],
      projectIds: ["project-claim-crash"]
    });
    const successor = runtime.handle({
      name: "job.claimAndStart",
      options: {
        projectId: "project-claim-crash",
        leaseOwner: "worker-restarted",
        leaseExpiresAt: "2026-07-14T00:03:00.000Z",
        now: "2026-07-14T00:02:01.000Z"
      }
    }) as StorageClaimStartResult;
    expect(successor.job).toMatchObject({ id: "job-successor-after-crash", status: "running", attempt: 1, leaseGeneration: 1 });

    const readback = new DatabaseSync(path, { readOnly: true });
    expect(readback.prepare("select status from step_attempts where job_id=?").all(crashed.job.id)).toEqual([{ status: "interrupted" }]);
    expect(readback.prepare("select count(*) as count from checkpoints where job_id=?").get(crashed.job.id)).toEqual({ count: 0 });
    expect(readback.prepare("select count(*) as count from tool_output_links where job_id=? and promoted=1").get(crashed.job.id)).toEqual({ count: 0 });
    expect(readback.prepare("select count(*) as count from job_events where job_id=?").get(crashed.job.id)).toEqual({ count: 3 });
    expect(readback.prepare("select count(distinct event_id) as count from job_events where job_id=?").get(crashed.job.id)).toEqual({ count: 3 });
    expect(readback.prepare("select type from job_events where job_id=? order by sequence").all(crashed.job.id)).toEqual([
      { type: "run.status.changed" },
      { type: "run.status.changed" },
      { type: "run.status.changed" }
    ]);
    readback.close();
  });

  it("rolls claim, attempt, and event back when the running event insert aborts", () => {
    const path = createRuntime();
    const setup = new DatabaseSync(path);
    createStorageV2Repositories({ appDb: setup }).jobs.enqueue(jobInput("job-claim-fault", "project-claim-fault"));
    setup.exec(`
      create trigger fail_running_event before insert on job_events
      when new.payload like '%"status":"running"%'
      begin select raise(abort, 'injected running event failure'); end;
    `);
    setup.close();

    expect(() => runtime?.handle({ name: "job.claimAndStart", options: claimOptions("project-claim-fault") })).toThrow("injected running event failure");

    const readback = new DatabaseSync(path, { readOnly: true });
    expect(readback.prepare("select status,attempt,lease_generation from jobs where id=?").get("job-claim-fault")).toEqual({
      status: "queued",
      attempt: 0,
      lease_generation: 0
    });
    expect(readback.prepare("select count(*) as count from step_attempts where job_id=?").get("job-claim-fault")).toEqual({ count: 0 });
    expect(readback.prepare("select count(*) as count from job_events where job_id=?").get("job-claim-fault")).toEqual({ count: 0 });
    readback.close();
  });

  it("rolls a completed checkpoint, attempt, and terminal status back when the terminal event insert aborts", () => {
    const path = createRuntime();
    const enqueued = runtime?.handle({ name: "job.enqueue", job: jobInput("job-terminal-fault", "project-terminal-fault") }) as { job: StorageJob };
    expect(enqueued.job.status).toBe("queued");
    const claimed = runtime?.handle({ name: "job.claimAndStart", options: claimOptions("project-terminal-fault") }) as StorageClaimStartResult;
    const setup = new DatabaseSync(path);
    setup.exec(`
      create trigger fail_terminal_event before insert on job_events
      when new.payload like '%"status":"completed"%'
      begin select raise(abort, 'injected terminal event failure'); end;
    `);
    setup.close();

    expect(() =>
      runtime?.handle({
        name: "job.transitionTerminal",
        input: {
          fence: claimed.fence,
          status: "completed",
          projectRevision: 1,
          occurredAt: "2026-07-14T00:00:02.000Z",
          completedStep: {
            step: "EXECUTE_TOOLS",
            checkpointData: { phase: "execute_tools_completed" },
            outputHash: "a".repeat(64)
          }
        }
      })
    ).toThrow("injected terminal event failure");

    const readback = new DatabaseSync(path, { readOnly: true });
    expect(readback.prepare("select status,result,completed_at from jobs where id=?").get("job-terminal-fault")).toEqual({
      status: "running",
      result: null,
      completed_at: null
    });
    expect(
      readback.prepare(`select count(*) as count from job_events where job_id=? and payload like '%"status":"completed"%'`).get("job-terminal-fault")
    ).toEqual({ count: 0 });
    readback.close();
    expectAtomicStepRollback(path, claimed.job.id);
  });

  it("rolls a quarantined checkpoint, attempt, and failed status back when the terminal event insert aborts", () => {
    const path = createRuntime();
    runtime?.handle({ name: "job.enqueue", job: jobInput("job-failed-terminal-fault", "project-failed-terminal-fault") });
    const claimed = runtime?.handle({ name: "job.claimAndStart", options: claimOptions("project-failed-terminal-fault") }) as StorageClaimStartResult;
    const setup = new DatabaseSync(path);
    setup.exec(`
      create trigger fail_failed_terminal_event before insert on job_events
      when new.payload like '%"status":"failed"%'
      begin select raise(abort, 'injected failed terminal event failure'); end;
    `);
    setup.close();

    expect(() =>
      runtime?.handle({
        name: "job.transitionTerminal",
        input: {
          fence: claimed.fence,
          status: "failed",
          projectRevision: 1,
          reason: "safe failure",
          occurredAt: "2026-07-14T00:00:02.000Z",
          quarantinedStep: { step: "EXECUTE_TOOLS", error: "safe failure", quarantineRef: "quarantine/job-failed-terminal-fault" }
        }
      })
    ).toThrow("injected failed terminal event failure");

    const readback = new DatabaseSync(path, { readOnly: true });
    expect(readback.prepare("select status,result,error,completed_at from jobs where id=?").get(claimed.job.id)).toEqual({
      status: "running",
      result: null,
      error: null,
      completed_at: null
    });
    expect(readback.prepare("select status from step_attempts where job_id=?").all(claimed.job.id)).toEqual([{ status: "running" }]);
    expect(readback.prepare("select count(*) as count from checkpoints where job_id=?").get(claimed.job.id)).toEqual({ count: 0 });
    expect(readback.prepare(`select count(*) as count from job_events where job_id=? and payload like '%"status":"failed"%'`).get(claimed.job.id)).toEqual({
      count: 0
    });
    readback.close();
  });

  it("rolls a completed checkpoint and attempt back when the attempt update aborts", () => {
    const path = createRuntime();
    runtime?.handle({ name: "job.enqueue", job: jobInput("job-checkpoint-fault", "project-checkpoint-fault") });
    const claimed = runtime?.handle({ name: "job.claimAndStart", options: claimOptions("project-checkpoint-fault") }) as StorageClaimStartResult;
    const setup = new DatabaseSync(path);
    setup.exec(`
      create trigger fail_completed_attempt before update on step_attempts
      when new.status = 'completed'
      begin select raise(abort, 'injected completed attempt failure'); end;
    `);
    setup.close();

    expect(() =>
      runtime?.handle({
        name: "job.commitStep",
        input: {
          fence: claimed.fence,
          step: "EXECUTE_TOOLS",
          projectRevision: 1,
          occurredAt: "2026-07-14T00:00:02.000Z",
          checkpointData: { outputHash: "a".repeat(64) }
        }
      })
    ).toThrow("injected completed attempt failure");

    expectAtomicStepRollback(path, claimed.job.id);
  });

  it("rolls a quarantine checkpoint and attempt back when the attempt update aborts", () => {
    const path = createRuntime();
    runtime?.handle({ name: "job.enqueue", job: jobInput("job-quarantine-fault", "project-quarantine-fault") });
    const claimed = runtime?.handle({ name: "job.claimAndStart", options: claimOptions("project-quarantine-fault") }) as StorageClaimStartResult;
    const setup = new DatabaseSync(path);
    setup.exec(`
      create trigger fail_quarantined_attempt before update on step_attempts
      when new.status = 'quarantined'
      begin select raise(abort, 'injected quarantined attempt failure'); end;
    `);
    setup.close();

    expect(() =>
      runtime?.handle({
        name: "job.quarantineStep",
        input: {
          fence: claimed.fence,
          step: "EXECUTE_TOOLS",
          projectRevision: 1,
          occurredAt: "2026-07-14T00:00:02.000Z",
          error: "safe failure",
          quarantineRef: "quarantine/job-quarantine-fault"
        }
      })
    ).toThrow("injected quarantined attempt failure");

    expectAtomicStepRollback(path, claimed.job.id);
  });

  it.each([
    { control: "pause" as const, status: "pause_requested" },
    { control: "cancel" as const, status: "cancel_requested" }
  ])("rejects a standalone completed checkpoint after $control is durably requested", ({ control, status }) => {
    const path = createRuntime();
    const jobId = `job-commit-after-${control}`;
    const projectId = `project-commit-after-${control}`;
    runtime?.handle({ name: "job.enqueue", job: jobInput(jobId, projectId) });
    const claimed = runtime?.handle({ name: "job.claimAndStart", options: claimOptions(projectId) }) as StorageClaimStartResult;
    runtime?.handle({
      name: "job.requestControl",
      input: { jobId, control, projectRevision: 1, occurredAt: "2026-07-14T00:00:02.000Z" }
    });

    expect(() =>
      runtime?.handle({
        name: "job.commitStep",
        input: {
          fence: claimed.fence,
          step: "EXECUTE_TOOLS",
          projectRevision: 1,
          occurredAt: "2026-07-14T00:00:03.000Z",
          checkpointData: { phase: "execute_tools_completed" }
        }
      })
    ).toThrow(/lease is no longer held/i);

    const readback = new DatabaseSync(path, { readOnly: true });
    expect(readback.prepare("select status from jobs where id=?").get(jobId)).toEqual({ status });
    expect(readback.prepare("select count(*) as count from checkpoints where job_id=?").get(jobId)).toEqual({ count: 0 });
    expect(readback.prepare("select status from step_attempts where job_id=?").all(jobId)).toEqual([{ status: "running" }]);
    expect(readback.prepare("select count(*) as count from job_events where job_id=?").get(jobId)).toEqual({ count: 3 });
    readback.close();
  });

  it.each([
    { control: "pause" as const, status: "paused" as const },
    { control: "cancel" as const, status: "aborted" as const }
  ])("replays a control-resolved $control completion without promoting its requested output", ({ control, status }) => {
    const path = createRuntime();
    const jobId = `job-control-retry-${control}`;
    const projectId = `project-control-retry-${control}`;
    runtime?.handle({ name: "job.enqueue", job: jobInput(jobId, projectId) });
    const claimed = runtime?.handle({ name: "job.claimAndStart", options: claimOptions(projectId) }) as StorageClaimStartResult;
    runtime?.handle({
      name: "job.requestControl",
      input: { jobId, control, projectRevision: 1, occurredAt: "2026-07-14T00:00:02.000Z" }
    });
    const input = {
      fence: claimed.fence,
      status: "completed" as const,
      projectRevision: 1,
      occurredAt: "2026-07-14T00:00:03.000Z",
      completedStep: { step: "EXECUTE_TOOLS", checkpointData: { phase: "execute_tools_completed" }, outputHash: "output-hash" },
      promotions: [
        {
          link: {
            id: `ignored-output-${control}`,
            projectId,
            jobId,
            attemptId: `ignored-attempt-${control}`,
            outputKind: "artifact" as const,
            outputId: `ignored-artifact-${control}`,
            promoted: true,
            createdAt: "2026-07-14T00:00:02.000Z",
            promotedAt: "2026-07-14T00:00:03.000Z"
          },
          artifact: { name: "ignored.json", kind: "engineering_result" }
        }
      ]
    };

    const first = runtime?.handle({ name: "job.transitionTerminal", input }) as { events: Array<{ sequence: number }> };
    const retry = runtime?.handle({ name: "job.transitionTerminal", input }) as { events: Array<{ sequence: number }> };

    expect(retry.events.map((event) => event.sequence)).toEqual(first.events.map((event) => event.sequence));
    const readback = new DatabaseSync(path, { readOnly: true });
    expect(readback.prepare("select status from jobs where id=?").get(jobId)).toEqual({ status });
    expect(readback.prepare("select status from checkpoints where job_id=?").all(jobId)).toEqual([{ status: "quarantined" }]);
    expect(readback.prepare("select status,output_hash from step_attempts where job_id=?").all(jobId)).toEqual([
      { status: "quarantined", output_hash: "output-hash" }
    ]);
    expect(readback.prepare("select count(*) as count from tool_output_links where job_id=? and promoted=1").get(jobId)).toEqual({ count: 0 });
    expect(readback.prepare("select count(*) as count from job_events where job_id=?").get(jobId)).toEqual({ count: 5 });
    readback.close();
  });

  it("returns an exact committed step retry and rolls every divergent retry back without changing rows or events", () => {
    const path = createRuntime();
    runtime?.handle({ name: "job.enqueue", job: jobInput("job-commit-retry", "project-commit-retry") });
    const claimed = runtime?.handle({ name: "job.claimAndStart", options: claimOptions("project-commit-retry") }) as StorageClaimStartResult;
    const input: StorageStepDispositionInput = {
      fence: claimed.fence,
      step: "EXECUTE_TOOLS",
      projectRevision: 1,
      occurredAt: "2026-07-14T00:00:02.000Z",
      checkpointData: { summary: { count: 1, status: "ok" }, items: ["artifact-1"] },
      outputRef: "staging/job-commit-retry/output.json",
      outputHash: "output-hash-first"
    };

    const first = runtime?.handle({ name: "job.commitStep", input }) as StorageStepDispositionResult;
    const beforeRetry = readStepPersistence(path, claimed.job.id);
    const retry = runtime?.handle({
      name: "job.commitStep",
      input: { ...input, checkpointData: { items: ["artifact-1"], summary: { status: "ok", count: 1 } } }
    }) as StorageStepDispositionResult;

    expect(retry).toEqual(first);
    expect(retry.stepAttempt.outputHash).toBe("output-hash-first");
    expect(readStepPersistence(path, claimed.job.id)).toEqual(beforeRetry);

    const conflicts: StorageStepDispositionInput[] = [
      { ...input, checkpointData: { privatePayload: "changed" } },
      { ...input, outputRef: "staging/private-other-output.json" },
      { ...input, outputHash: "private-other-output-hash" },
      { ...input, occurredAt: "2026-07-14T00:00:03.000Z" },
      { ...input, projectRevision: 2 }
    ];
    for (const conflict of conflicts) {
      const failure = captureThrown(() => runtime?.handle({ name: "job.commitStep", input: conflict }));
      expect(failure.message).not.toMatch(/privatePayload|private-other/);
      expect(readStepPersistence(path, claimed.job.id)).toEqual(beforeRetry);
    }
  });

  it("treats a lease as expired at its exact expiry instant", () => {
    createRuntime();
    runtime?.handle({ name: "job.enqueue", job: jobInput("job-expiry-boundary", "project-expiry-boundary") });
    const claimed = runtime?.handle({
      name: "job.claimAndStart",
      options: {
        projectId: "project-expiry-boundary",
        leaseOwner: "worker-boundary",
        leaseExpiresAt: "2026-07-14T00:01:00.000Z",
        now: "2026-07-14T00:00:01.000Z"
      }
    }) as StorageClaimStartResult;
    setLeaseNow("2026-07-14T00:01:00.000Z");

    expect(() =>
      runtime?.handle({
        name: "fencedTransaction",
        fence: claimed.fence,
        now: "2026-07-14T00:01:00.000Z",
        commands: []
      })
    ).toThrow("lease is no longer held");
    expect(runtime?.handle({ name: "job.markInterruptedExpiredLeases", now: "2026-07-14T00:01:00.000Z" })).toMatchObject({
      jobs: [{ id: "job-expiry-boundary", status: "interrupted" }]
    });
  });

  it("reads an identical completed promotion retry without creating duplicate events", () => {
    const path = createRuntime();
    runtime?.handle({ name: "job.enqueue", job: jobInput("job-promotion-retry", "project-promotion-retry") });
    const claimed = runtime?.handle({ name: "job.claimAndStart", options: claimOptions("project-promotion-retry") }) as StorageClaimStartResult;
    runtime?.handle({
      name: "fencedTransaction",
      fence: claimed.fence,
      now: "2026-07-14T00:00:02.000Z",
      commands: [
        {
          name: "trace.decision.record",
          decision: {
            id: "decision-promotion-retry",
            projectId: claimed.job.projectId,
            jobId: claimed.job.id,
            toolName: "TestTool",
            purpose: "Exercise promotion retry.",
            expectedOutcome: "A persisted promotion.",
            rawSelection: {},
            userPinned: false,
            policyStatus: "accepted",
            createdAt: "2026-07-14T00:00:01.000Z"
          }
        },
        {
          name: "trace.attempt.save",
          attempt: {
            id: "tool-attempt-promotion-retry",
            projectId: claimed.job.projectId,
            jobId: claimed.job.id,
            decisionId: "decision-promotion-retry",
            ordinal: 1,
            status: "running",
            inputHash: "a".repeat(64),
            dependsOnAttemptIds: [],
            queuedAt: "2026-07-14T00:00:01.000Z",
            startedAt: "2026-07-14T00:00:01.000Z"
          }
        },
        {
          name: "trace.attempt.save",
          attempt: {
            id: "tool-attempt-promotion-retry",
            projectId: claimed.job.projectId,
            jobId: claimed.job.id,
            decisionId: "decision-promotion-retry",
            ordinal: 1,
            status: "completed",
            inputHash: "a".repeat(64),
            outputHash: "b".repeat(64),
            terminalCause: "completed",
            dependsOnAttemptIds: [],
            queuedAt: "2026-07-14T00:00:01.000Z",
            startedAt: "2026-07-14T00:00:01.000Z",
            completedAt: "2026-07-14T00:00:02.000Z"
          }
        }
      ]
    });
    const input = {
      fence: claimed.fence,
      status: "completed" as const,
      projectRevision: 1,
      occurredAt: "2026-07-14T00:00:03.000Z",
      completedStep: {
        step: "EXECUTE_TOOLS",
        checkpointData: { phase: "execute_tools_completed" },
        outputHash: "output-hash"
      },
      promotions: [
        {
          link: {
            id: "output-link-promotion-retry",
            projectId: claimed.job.projectId,
            jobId: claimed.job.id,
            attemptId: "tool-attempt-promotion-retry",
            outputKind: "artifact" as const,
            outputId: "artifact-promotion-retry",
            promoted: true,
            createdAt: "2026-07-14T00:00:02.000Z",
            promotedAt: "2026-07-14T00:00:03.000Z"
          },
          artifact: { name: "result.json", kind: "engineering_result" }
        }
      ]
    };

    const first = runtime?.handle({ name: "job.transitionTerminal", input }) as { events: Array<{ sequence: number }> };
    expect(() =>
      runtime?.handle({
        name: "job.requestControl",
        input: { jobId: claimed.job.id, control: "cancel", projectRevision: 1, occurredAt: "2026-07-14T00:00:04.000Z" }
      })
    ).toThrow(/cancel|completed/i);
    runtime?.close();
    runtime = createStorageWorkerRuntime(path);
    const retry = runtime.handle({ name: "job.transitionTerminal", input }) as { events: Array<{ sequence: number }> };

    expect(retry.events.map((event) => event.sequence)).toEqual(first.events.map((event) => event.sequence));
    expect(runtime?.handle({ name: "event.after", projectId: claimed.job.projectId })).toHaveLength(5);
    expect(() =>
      runtime?.handle({
        name: "job.transitionTerminal",
        input: { ...input, completedStep: { ...input.completedStep, outputHash: "different-output-hash" } }
      })
    ).toThrow(/retry conflicts/i);
    expect(runtime?.handle({ name: "checkpoint.listForJob", jobId: claimed.job.id })).toEqual([
      expect.objectContaining({ status: "committed", data: { phase: "execute_tools_completed" } })
    ]);
  });
});

function createRuntime(): string {
  setLeaseNow("2026-07-14T00:00:01.000Z");
  root = mkdtempSync(join(tmpdir(), "aetherops-job-atomicity-"));
  const path = join(root, "storage.sqlite");
  const db = new DatabaseSync(path);
  migrateStorageV2Schema(db);
  db.close();
  runtime = createStorageWorkerRuntime(path);
  return path;
}

function createStorageWorkerRuntime(path: string): StorageWorkerRuntime {
  return new StorageWorkerRuntime({ appDbPath: path, vectorDbPath: path, ontologyDbPath: path }, { leaseClock: () => leaseNowMs });
}

function setLeaseNow(value: string): void {
  leaseNowMs = Date.parse(value);
}

function jobInput(id: string, projectId: string) {
  return {
    id,
    projectId,
    operation: "research_loop",
    idempotencyKey: id,
    createdAt: "2026-07-14T00:00:00.000Z",
    queuedAt: "2026-07-14T00:00:00.000Z",
    payload: { projectRevision: 1, currentStep: "EXECUTE_TOOLS" }
  };
}

function claimOptions(projectId: string) {
  return {
    projectId,
    leaseOwner: "worker-fault",
    leaseExpiresAt: "2026-07-14T00:01:00.000Z",
    now: "2026-07-14T00:00:01.000Z"
  };
}

function expectAtomicStepRollback(path: string, jobId: string): void {
  const readback = new DatabaseSync(path, { readOnly: true });
  expect(readback.prepare("select status,attempt,lease_generation from jobs where id=?").get(jobId)).toEqual({
    status: "running",
    attempt: 1,
    lease_generation: 1
  });
  expect(readback.prepare("select count(*) as count from checkpoints where job_id=?").get(jobId)).toEqual({ count: 0 });
  expect(readback.prepare("select status from step_attempts where job_id=?").all(jobId)).toEqual([{ status: "running" }]);
  expect(readback.prepare("select count(*) as count from job_events where job_id=?").get(jobId)).toEqual({ count: 2 });
  expect(readback.prepare("select count(*) as count from tool_output_links where job_id=? and promoted=1").get(jobId)).toEqual({ count: 0 });
  readback.close();
}

function readStepPersistence(path: string, jobId: string) {
  const readback = new DatabaseSync(path, { readOnly: true });
  const state = {
    checkpoints: readback.prepare("select * from checkpoints where job_id=? order by id").all(jobId),
    attempts: readback.prepare("select * from step_attempts where job_id=? order by id").all(jobId),
    events: readback.prepare("select * from job_events where job_id=? order by sequence").all(jobId)
  };
  readback.close();
  return state;
}

function captureThrown(action: () => unknown): Error {
  try {
    action();
  } catch (error) {
    if (error instanceof Error) return error;
  }
  throw new Error("Expected an Error to be thrown.");
}
