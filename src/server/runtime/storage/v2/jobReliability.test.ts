import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { StorageWorkerRuntime } from "../worker/typedRuntime.js";
import { LeaseLostError } from "./leaseFence.js";
import { createStorageV2Repositories } from "./repositories.js";
import { migrateStorageV2Schema } from "./schema.js";
import { STORAGE_JOB_MIGRATION_CHECKSUM, STORAGE_JOB_SCHEMA_VERSION } from "./jobSchema.js";
import { fencedAttemptCommands } from "./traceTestFixtures.js";
import type { StorageClaimStartResult, StorageJob, StorageLeaseFence } from "./types.js";

let root: string | undefined;
let runtime: StorageWorkerRuntime | undefined;

afterEach(() => {
  runtime?.close();
  if (root) rmSync(root, { recursive: true, force: true });
  runtime = undefined;
});

describe("durable job storage fencing", () => {
  it("installs the additive v4 lease generation migration idempotently", () => {
    const path = createDatabase();
    const db = new DatabaseSync(path);

    migrateStorageV2Schema(db);
    migrateStorageV2Schema(db);

    expect(db.prepare("pragma table_info(jobs)").all()).toContainEqual(expect.objectContaining({ name: "lease_generation", notnull: 1, dflt_value: "0" }));
    expect(db.prepare("select name, checksum_sha256 from schema_migrations where version=?").get(STORAGE_JOB_SCHEMA_VERSION)).toEqual({
      name: "operational-job-fencing-v4",
      checksum_sha256: STORAGE_JOB_MIGRATION_CHECKSUM
    });
    db.close();
  });

  it("atomically enqueues a new job with one durable queued event and reads it back on idempotent retry", () => {
    createRuntime();
    const input = {
      id: "job-enqueue",
      projectId: "project-enqueue",
      operation: "research_loop",
      idempotencyKey: "enqueue-key",
      requestHash: "request-hash",
      createdAt: "2026-07-14T00:00:00.000Z",
      queuedAt: "2026-07-14T00:00:00.000Z",
      payload: { projectRevision: 9, currentStep: "EXECUTE_TOOLS" }
    };
    const first = runtime?.handle({ name: "job.enqueue", job: input }) as { job: StorageJob; event?: { type: string; payload: unknown } };
    const retry = runtime?.handle({ name: "job.enqueue", job: { ...input, id: "job-enqueue-retry" } }) as {
      job: StorageJob;
      event?: { sequence: number };
    };

    expect(first).toMatchObject({ job: { id: "job-enqueue", status: "queued" }, event: { type: "run.status.changed" } });
    expect(retry.job.id).toBe("job-enqueue");
    expect(retry.event?.sequence).toBe((first.event as { sequence: number }).sequence);
    expect(runtime?.handle({ name: "event.after", projectId: "project-enqueue" })).toHaveLength(1);
  });

  it("claims exact queued_at/id FIFO and atomically records its running attempt and event", () => {
    createRuntime();
    const queuedAt = "2026-07-14T00:00:00.000Z";
    enqueue({ id: "job-z", projectId: "project-1", priority: 100, queuedAt });
    enqueue({ id: "job-a", projectId: "project-1", priority: 0, queuedAt });

    const claimed = claim("project-1");

    expect(claimed.job).toMatchObject({ id: "job-a", status: "running", attempt: 1, leaseGeneration: 1, leaseOwner: "worker-a" });
    expect(claimed.stepAttempt).toMatchObject({ jobId: "job-a", attemptIndex: 1, status: "running", workerId: "worker-a" });
    expect(claimed.event).toMatchObject({ jobId: "job-a", type: "run.status.changed" });
    expect(runtime?.handle({ name: "job.claimAndStart", options: claimOptions("project-1") })).toBeUndefined();
  });

  it("derives claim revision and step from the persisted payload and rolls back invalid metadata", () => {
    createRuntime();
    enqueue({ id: "job-metadata", projectId: "project-metadata", projectRevision: 44 });
    const claimed = claim("project-metadata");
    expect(claimed.event.payload).toMatchObject({ projectRevision: 44 });
    expect(claimed.stepAttempt).toMatchObject({ step: "EXECUTE_TOOLS" });

    expect(() =>
      runtime?.handle({
        name: "job.enqueue",
        job: {
          id: "job-invalid-metadata",
          projectId: "project-invalid-metadata",
          operation: "research_loop",
          queuedAt: "2026-07-14T00:00:00.000Z",
          createdAt: "2026-07-14T00:00:00.000Z",
          payload: { currentStep: "EXECUTE_TOOLS" }
        }
      })
    ).toThrow(/project revision/i);
    expect(runtime?.handle({ name: "job.get", jobId: "job-invalid-metadata" })).toBeUndefined();
  });

  it("rolls back the claim when its attempt or running event cannot be committed", () => {
    const path = createRuntime();
    enqueue({ id: "job-rollback", projectId: "project-rollback", projectRevision: 45 });
    const db = new DatabaseSync(path);
    db.prepare("insert into job_events (event_id,project_id,job_id,type,created_at,payload) values (?,?,?,?,?,?)").run(
      stableTestId("event", "job-rollback", "1", "running"),
      "project-rollback",
      "job-rollback",
      "run.status.changed",
      "2026-07-14T00:00:00.000Z",
      JSON.stringify({ conflict: true })
    );
    db.close();

    expect(() => runtime?.handle({ name: "job.claimAndStart", options: claimOptions("project-rollback") })).toThrow(/event id conflict/i);
    expect(runtime?.handle({ name: "job.get", jobId: "job-rollback" })).toMatchObject({ status: "queued", attempt: 0, leaseGeneration: 0 });
    expect(runtime?.handle({ name: "checkpoint.listStepAttempts", jobId: "job-rollback" })).toEqual([]);
  });

  it("rejects an absent or already expired claim lease before changing the queue", () => {
    createRuntime();
    enqueue({ id: "job-invalid-lease", projectId: "project-invalid-lease", projectRevision: 46 });
    expect(() =>
      runtime?.handle({
        name: "job.claimAndStart",
        options: {
          projectId: "project-invalid-lease",
          leaseOwner: "worker-a",
          leaseExpiresAt: "2026-07-14T00:00:00.000Z",
          now: "2026-07-14T00:00:01.000Z"
        }
      })
    ).toThrow(/lease.*future|expire.*after/i);
    expect(runtime?.handle({ name: "job.get", jobId: "job-invalid-lease" })).toMatchObject({ status: "queued", attempt: 0 });
  });

  it("rejects every stale terminal and checkpoint write after lease expiry", () => {
    const path = createRuntime();
    enqueue({ id: "job-stale", projectId: "project-stale", projectRevision: 2 });
    const claimed = claim("project-stale");
    const fence = fenceOf(claimed.job);
    const db = new DatabaseSync(path);
    db.prepare("update jobs set lease_expires_at=? where id=?").run("2000-01-01T00:00:00.000Z", claimed.job.id);
    db.close();
    runtime?.handle({ name: "job.markInterruptedExpiredLeases", now: "2026-07-14T00:02:00.000Z" });

    expect(() =>
      runtime?.handle({
        name: "job.transitionTerminal",
        input: { fence, status: "completed", projectRevision: 2, occurredAt: "2026-07-14T00:02:01.000Z" }
      })
    ).toThrow(LeaseLostError);
    expect(() =>
      runtime?.handle({
        name: "job.commitStep",
        input: { fence, step: "EXECUTE_TOOLS", projectRevision: 2, occurredAt: "2026-07-14T00:02:01.000Z" }
      })
    ).toThrow(LeaseLostError);
    expect(runtime?.handle({ name: "checkpoint.listForJob", jobId: claimed.job.id })).toEqual([]);
  });

  it("fences every late writer after an expired job is replaced in the same project lane", () => {
    createRuntime();
    enqueue({ id: "job-a-expired", projectId: "project-race", projectRevision: 1 });
    const jobA = claimAt("project-race", "2026-07-14T00:00:01.000Z", "2026-07-14T00:01:00.000Z");
    saveFencedToolAttempt(jobA.job, toolAttempt(jobA.job, "attempt-a-output", "completed"));
    saveFencedToolAttempt(jobA.job, toolAttempt(jobA.job, "attempt-a-active", "running"));
    runtime?.handle({ name: "job.markInterruptedExpiredLeases", now: "2026-07-14T00:02:00.000Z" });

    enqueue({ id: "job-b-successor", projectId: "project-race", projectRevision: 2, queuedAt: "2026-07-14T00:02:01.000Z" });
    const jobB = claimAt("project-race", "2026-07-14T00:02:02.000Z", "2026-07-14T00:03:00.000Z");
    runtime?.handle({
      name: "job.commitStep",
      input: { fence: fenceOf(jobB.job), step: "EXECUTE_TOOLS", projectRevision: 2, occurredAt: "2026-07-14T00:02:03.000Z" }
    });
    runtime?.handle({
      name: "job.transitionTerminal",
      input: { fence: fenceOf(jobB.job), status: "completed", projectRevision: 2, occurredAt: "2026-07-14T00:02:04.000Z" }
    });

    const fenceA = fenceOf(jobA.job);
    const lateAt = "2026-07-14T00:02:05.000Z";
    const lateWrites = [
      () =>
        runtime?.handle({
          name: "job.transitionTerminal",
          input: {
            fence: fenceA,
            status: "completed",
            projectRevision: 1,
            occurredAt: lateAt,
            promotions: [
              {
                link: promotedArtifactLink(jobA.job, "attempt-a-output", "artifact-a-late"),
                artifact: { name: "late.json", kind: "engineering_result" }
              }
            ]
          }
        }),
      () =>
        runtime?.handle({
          name: "job.commitStep",
          input: { fence: fenceA, step: "EXECUTE_TOOLS", projectRevision: 1, occurredAt: lateAt }
        }),
      () =>
        runtime?.handle({
          name: "job.quarantineStep",
          input: { fence: fenceA, step: "EXECUTE_TOOLS", projectRevision: 1, error: "late writer", occurredAt: lateAt }
        }),
      () =>
        runtime?.handle({
          name: "fencedTransaction",
          fence: fenceA,
          now: lateAt,
          commands: [
            {
              name: "event.append",
              event: {
                eventId: "late-job-a-event",
                projectId: "project-race",
                jobId: "job-a-expired",
                type: "run.status.changed",
                createdAt: lateAt,
                payload: { projectRevision: 1, data: { jobId: "job-a-expired", status: "completed" } }
              }
            }
          ]
        })
    ];
    for (const write of lateWrites) expect(write).toThrow(LeaseLostError);

    expect(runtime?.handle({ name: "job.get", jobId: "job-a-expired" })).toMatchObject({ status: "interrupted" });
    expect(runtime?.handle({ name: "job.get", jobId: "job-b-successor" })).toMatchObject({ status: "completed", result: { projectRevision: 2 } });
    expect(runtime?.handle({ name: "checkpoint.listForJob", jobId: "job-a-expired" })).toEqual([]);
    expect(runtime?.handle({ name: "checkpoint.listStepAttempts", jobId: "job-a-expired" })).toEqual([
      expect.objectContaining({ status: "interrupted", error: "Worker lease expired." })
    ]);
    expect(runtime?.handle({ name: "trace.attempt.get", attemptId: "attempt-a-active" })).toMatchObject({
      status: "interrupted",
      terminalCause: "lease_expired",
      error: "Worker lease expired."
    });
    expect(runtime?.handle({ name: "checkpoint.listForJob", jobId: "job-b-successor" })).toEqual([expect.objectContaining({ status: "committed" })]);
    expect(runtime?.handle({ name: "trace.output.listAttempt", attemptId: "attempt-a-output" })).toEqual([]);
  });

  it("commits terminal status with one durable event and rejects a conflicting retry", () => {
    createRuntime();
    enqueue({ id: "job-terminal", projectId: "project-terminal" });
    const claimed = claim("project-terminal");
    const input = {
      fence: fenceOf(claimed.job),
      status: "completed" as const,
      projectRevision: 7,
      occurredAt: "2026-07-14T00:00:02.000Z"
    };

    const first = runtime?.handle({ name: "job.transitionTerminal", input }) as { job: StorageJob };
    const second = runtime?.handle({ name: "job.transitionTerminal", input }) as { job: StorageJob };

    expect(first.job.status).toBe("completed");
    expect(second.job.status).toBe("completed");
    expect(runtime?.handle({ name: "event.after", projectId: "project-terminal" })).toHaveLength(3);
    expect(() => runtime?.handle({ name: "job.transitionTerminal", input: { ...input, status: "failed", reason: "conflicting failure" } })).toThrow(
      /transition/i
    );
  });

  it("atomically records completed and quarantined step dispositions", () => {
    createRuntime();
    enqueue({ id: "job-complete-step", projectId: "project-step" });
    const completed = claim("project-step");
    const committed = runtime?.handle({
      name: "job.commitStep",
      input: {
        fence: fenceOf(completed.job),
        step: "EXECUTE_TOOLS",
        projectRevision: 3,
        occurredAt: "2026-07-14T00:00:03.000Z",
        checkpointData: { outputHash: "a".repeat(64) }
      }
    }) as { checkpoint: { status: string }; stepAttempt: { status: string }; event: { type: string } };
    expect(committed).toMatchObject({ checkpoint: { status: "committed" }, stepAttempt: { status: "completed" }, event: { type: "run.step.changed" } });

    runtime?.handle({
      name: "job.transitionTerminal",
      input: { fence: fenceOf(completed.job), status: "failed", projectRevision: 3, reason: "forced", occurredAt: "2026-07-14T00:00:04.000Z" }
    });
    enqueue({ id: "job-quarantine-step", projectId: "project-step" });
    const failed = claim("project-step");
    const quarantined = runtime?.handle({
      name: "job.quarantineStep",
      input: {
        fence: fenceOf(failed.job),
        step: "EXECUTE_TOOLS",
        projectRevision: 4,
        error: "safe failure",
        occurredAt: "2026-07-14T00:00:05.000Z"
      }
    }) as { checkpoint: { status: string }; stepAttempt: { status: string }; event: { type: string } };
    expect(quarantined).toMatchObject({ checkpoint: { status: "quarantined" }, stepAttempt: { status: "quarantined" }, event: { type: "run.step.changed" } });
  });

  it("commits pause and cancel requests with their durable status events", () => {
    createRuntime();
    enqueue({ id: "job-pause", projectId: "project-control", projectRevision: 11 });
    const running = claim("project-control");
    const paused = runtime?.handle({
      name: "job.requestControl",
      input: { jobId: running.job.id, control: "pause", projectRevision: 11, occurredAt: "2026-07-14T00:00:02.000Z" }
    }) as { job: StorageJob; event: { type: string; payload: unknown } };
    expect(paused).toMatchObject({ job: { status: "pause_requested" }, event: { type: "run.status.changed" } });

    expect(() =>
      runtime?.handle({
        name: "job.requestControl",
        input: { jobId: running.job.id, control: "pause", projectRevision: 11, occurredAt: "2026-07-14T00:00:03.000Z" }
      })
    ).toThrow(/transition|running/i);

    enqueue({ id: "job-cancel", projectId: "project-cancel", projectRevision: 12 });
    const cancelled = runtime?.handle({
      name: "job.requestControl",
      input: { jobId: "job-cancel", control: "cancel", projectRevision: 12, occurredAt: "2026-07-14T00:00:04.000Z" }
    }) as { job: StorageJob; event: { type: string } };
    expect(cancelled).toMatchObject({ job: { status: "aborted" }, event: { type: "run.status.changed" } });
    expect(runtime?.handle({ name: "event.after", projectId: "project-cancel" })).toHaveLength(2);
    expect(() =>
      runtime?.handle({
        name: "job.requestControl",
        input: { jobId: "job-cancel", control: "cancel", projectRevision: 12, occurredAt: "2026-07-14T00:00:05.000Z" }
      })
    ).toThrow(/transition|cancel/i);
  });

  it("atomically interrupts expired leases and appends one durable event per job", () => {
    const path = createRuntime();
    enqueue({ id: "job-expired", projectId: "project-expired", projectRevision: 21 });
    claim("project-expired");
    const db = new DatabaseSync(path);
    db.prepare("update jobs set lease_expires_at=? where id=?").run("2026-07-14T00:00:01.000Z", "job-expired");
    db.close();

    const swept = runtime?.handle({ name: "job.markInterruptedExpiredLeases", now: "2026-07-14T00:02:00.000Z" }) as {
      jobs: StorageJob[];
      events: Array<{ type: string }>;
      projectIds: string[];
    };

    expect(swept).toMatchObject({
      jobs: [{ id: "job-expired", status: "interrupted" }],
      events: [{ type: "run.status.changed" }],
      projectIds: ["project-expired"]
    });
    expect(runtime?.handle({ name: "event.after", projectId: "project-expired" })).toHaveLength(3);
  });

  it("promotes only completed tool outputs in the same transaction as completed status", () => {
    createRuntime();
    enqueue({ id: "job-promote", projectId: "project-promote", projectRevision: 31 });
    const running = claim("project-promote");
    saveFencedToolAttempt(running.job, toolAttempt(running.job, "attempt-completed", "completed"));

    const completed = runtime?.handle({
      name: "job.transitionTerminal",
      input: {
        fence: fenceOf(running.job),
        status: "completed",
        projectRevision: 31,
        occurredAt: "2026-07-14T00:00:06.000Z",
        promotions: [
          {
            link: promotedArtifactLink(running.job, "attempt-completed", "artifact-1"),
            artifact: { name: "결과.json", kind: "engineering_result" }
          }
        ]
      }
    }) as { job: StorageJob; events: Array<{ type: string }>; links: Array<{ outputId: string }> };

    expect(completed.job.status).toBe("completed");
    expect(completed.events.map((event) => event.type)).toEqual(["artifact.created", "run.status.changed"]);
    expect(completed.links).toEqual([expect.objectContaining({ outputId: "artifact-1", promoted: true })]);

    enqueue({ id: "job-reject-promotion", projectId: "project-reject", projectRevision: 32 });
    const reject = claim("project-reject");
    saveFencedToolAttempt(reject.job, toolAttempt(reject.job, "attempt-running", "running"));
    expect(() =>
      runtime?.handle({
        name: "job.transitionTerminal",
        input: {
          fence: fenceOf(reject.job),
          status: "completed",
          projectRevision: 32,
          occurredAt: "2026-07-14T00:00:07.000Z",
          promotions: [{ link: promotedArtifactLink(reject.job, "attempt-running", "artifact-invalid") }]
        }
      })
    ).toThrow(/completed tool attempt/i);
    expect(runtime?.handle({ name: "job.get", jobId: reject.job.id })).toMatchObject({ status: "running" });
    expect(runtime?.handle({ name: "trace.output.listAttempt", attemptId: "attempt-running" })).toEqual([]);
  });

  it("rejects primary promotion through generic fenced writes", () => {
    createRuntime();
    enqueue({ id: "job-generic-promote", projectId: "project-generic-promote", projectRevision: 33 });
    const running = claim("project-generic-promote");
    saveFencedToolAttempt(running.job, toolAttempt(running.job, "attempt-generic", "completed"));

    expect(() =>
      runtime?.handle({
        name: "fencedTransaction",
        fence: fenceOf(running.job),
        commands: [{ name: "trace.output.record", link: promotedArtifactLink(running.job, "attempt-generic", "artifact-generic") }]
      })
    ).toThrow(/promotion.*terminal|terminal.*promotion/i);
    expect(runtime?.handle({ name: "trace.output.listAttempt", attemptId: "attempt-generic" })).toEqual([]);
  });

  it("prevents terminal checkpoint and attempt records from being downgraded", () => {
    const path = createRuntime();
    enqueue({ id: "job-monotonic", projectId: "project-monotonic", projectRevision: 34 });
    const running = claim("project-monotonic");
    const checkpoint = {
      id: "checkpoint-monotonic",
      projectId: running.job.projectId,
      jobId: running.job.id,
      step: "EXECUTE_TOOLS",
      checkpointKey: "monotonic",
      status: "committed" as const,
      createdAt: "2026-07-14T00:00:01.000Z",
      committedAt: "2026-07-14T00:00:02.000Z"
    };
    const db = new DatabaseSync(path);
    const checkpoints = createStorageV2Repositories({ appDb: db }).checkpoints;
    checkpoints.saveCheckpoint(checkpoint);
    expect(() => checkpoints.saveCheckpoint({ ...checkpoint, status: "pending", committedAt: undefined })).toThrow(/checkpoint retry conflicts/i);
    db.close();

    const attempt = toolAttempt(running.job, "attempt-monotonic", "completed");
    saveFencedToolAttempt(running.job, attempt);
    expect(() => saveFencedToolAttempt(running.job, { ...attempt, status: "running", completedAt: undefined })).toThrow(/attempt transition/i);
  });
});

describe("durable queue discovery", () => {
  it("paginates every runnable project and calculates queue position in SQL", () => {
    createRuntime();
    const queuedAt = "2026-07-14T00:00:00.000Z";
    for (const id of ["job-c", "job-a", "job-b"]) enqueue({ id, projectId: "project-many", queuedAt });
    enqueue({ id: "job-p2", projectId: "project-2", queuedAt });
    enqueue({ id: "job-p3", projectId: "project-3", queuedAt });

    expect(runtime?.handle({ name: "job.queuePosition", jobId: "job-c" })).toBe(2);
    const first = runtime?.handle({ name: "job.listRunnableProjects", limit: 2 }) as { projectIds: string[]; nextCursor?: string };
    const second = runtime?.handle({ name: "job.listRunnableProjects", cursor: first.nextCursor, limit: 2 }) as { projectIds: string[]; nextCursor?: string };
    expect([...first.projectIds, ...second.projectIds]).toEqual(["project-2", "project-3", "project-many"]);
    expect(second.nextCursor).toBeUndefined();
  });

  it("filters project jobs in SQL before applying a queued_at/id keyset page", () => {
    createRuntime();
    enqueue({ id: "job-aborted-a", projectId: "project-filter", queuedAt: "2026-07-13T00:00:00.000Z" });
    enqueue({ id: "job-aborted-b", projectId: "project-filter", queuedAt: "2026-07-13T00:00:01.000Z" });
    runtime?.handle({
      name: "job.requestControl",
      input: { jobId: "job-aborted-a", control: "cancel", projectRevision: 1, occurredAt: "2026-07-13T00:00:02.000Z" }
    });
    runtime?.handle({
      name: "job.requestControl",
      input: { jobId: "job-aborted-b", control: "cancel", projectRevision: 1, occurredAt: "2026-07-13T00:00:03.000Z" }
    });
    const queuedAt = "2026-07-14T00:00:00.000Z";
    for (const id of ["job-c", "job-a", "job-b"]) enqueue({ id, projectId: "project-filter", queuedAt });

    const first = runtime?.handle({ name: "job.listProject", projectId: "project-filter", status: "queued", limit: 2 }) as {
      jobs: StorageJob[];
      nextCursor?: string;
    };
    const second = runtime?.handle({
      name: "job.listProject",
      projectId: "project-filter",
      status: "queued",
      cursor: first.nextCursor,
      limit: 2
    }) as { jobs: StorageJob[]; nextCursor?: string };

    expect(first.jobs.map((job) => job.id)).toEqual(["job-a", "job-b"]);
    expect(first.nextCursor).toEqual(expect.any(String));
    expect(second.jobs.map((job) => job.id)).toEqual(["job-c"]);
    expect(second.nextCursor).toBeUndefined();
  });

  it("enforces one active lease holder per project at the SQLite boundary", () => {
    const path = createRuntime();
    enqueue({ id: "job-active-a", projectId: "project-active", projectRevision: 1 });
    enqueue({ id: "job-active-b", projectId: "project-active", projectRevision: 1 });
    claim("project-active");
    const db = new DatabaseSync(path);
    expect(() => db.prepare("update jobs set status='running' where id=?").run("job-active-b")).toThrow(/unique/i);
    db.close();
  });
});

function createDatabase(): string {
  root = mkdtempSync(join(tmpdir(), "aetherops-job-fence-"));
  const path = join(root, "storage.sqlite");
  const db = new DatabaseSync(path);
  migrateStorageV2Schema(db);
  db.close();
  return path;
}

function createRuntime(): string {
  const path = createDatabase();
  runtime = new StorageWorkerRuntime({ appDbPath: path, vectorDbPath: path, ontologyDbPath: path });
  return path;
}

function enqueue(input: { id: string; projectId: string; priority?: number; queuedAt?: string; projectRevision?: number }): StorageJob {
  const now = input.queuedAt ?? "2026-07-14T00:00:00.000Z";
  const result = runtime?.handle({
    name: "job.enqueue",
    job: {
      id: input.id,
      projectId: input.projectId,
      priority: input.priority,
      operation: "research_loop",
      idempotencyKey: input.id,
      createdAt: now,
      queuedAt: now,
      payload: { currentStep: "EXECUTE_TOOLS", projectRevision: input.projectRevision ?? 1 }
    }
  }) as { job: StorageJob };
  return result.job;
}

function claim(projectId: string): StorageClaimStartResult {
  return claimAt(projectId, "2026-07-14T00:00:01.000Z", "2026-07-14T00:01:00.000Z");
}

function claimAt(projectId: string, now: string, leaseExpiresAt: string): StorageClaimStartResult {
  const value = runtime?.handle({ name: "job.claimAndStart", options: { projectId, leaseOwner: "worker-a", leaseExpiresAt, now } });
  if (!value) throw new Error(`Expected a claim for ${projectId}.`);
  return value as StorageClaimStartResult;
}

function claimOptions(projectId: string) {
  return {
    projectId,
    leaseOwner: "worker-a",
    leaseExpiresAt: "2026-07-14T00:01:00.000Z",
    now: "2026-07-14T00:00:01.000Z"
  };
}

function fenceOf(job: StorageJob): StorageLeaseFence {
  if (!job.leaseOwner) throw new Error("Claimed job is missing its lease owner.");
  return { jobId: job.id, attempt: job.attempt, leaseOwner: job.leaseOwner, leaseGeneration: job.leaseGeneration };
}

function toolAttempt(job: StorageJob, id: string, status: "running" | "completed") {
  return {
    id,
    projectId: job.projectId,
    jobId: job.id,
    decisionId: `decision-${id}`,
    ordinal: 0,
    status,
    inputHash: "input-hash",
    outputHash: status === "completed" ? "output-hash" : undefined,
    terminalCause: status === "completed" ? "completed" : undefined,
    dependsOnAttemptIds: [],
    queuedAt: "2026-07-14T00:00:01.000Z",
    startedAt: "2026-07-14T00:00:02.000Z",
    completedAt: status === "completed" ? "2026-07-14T00:00:03.000Z" : undefined
  };
}

function promotedArtifactLink(job: StorageJob, attemptId: string, outputId: string) {
  return {
    id: `link-${outputId}`,
    projectId: job.projectId,
    jobId: job.id,
    attemptId,
    outputKind: "artifact" as const,
    outputId,
    promoted: true,
    createdAt: "2026-07-14T00:00:05.000Z",
    promotedAt: "2026-07-14T00:00:06.000Z"
  };
}

function saveFencedToolAttempt(job: StorageJob, attempt: ReturnType<typeof toolAttempt>): void {
  runtime?.handle({ name: "fencedTransaction", fence: fenceOf(job), commands: fencedAttemptCommands(job, attempt) });
}

function stableTestId(prefix: string, ...parts: string[]): string {
  return `${prefix}-${createHash("sha256").update(parts.join("\u0000")).digest("hex")}`;
}
