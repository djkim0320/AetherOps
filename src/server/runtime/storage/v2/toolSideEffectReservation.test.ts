import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { StorageWorkerRuntime } from "../worker/typedRuntime.js";
import type { StorageFencedWriteCommand } from "../worker/typedProtocol.js";
import type { StorageTerminalTransitionResult } from "./jobAtomicTypes.js";
import { migrateStorageV2Schema } from "./schema.js";
import { createStorageV2Repositories } from "./repositories.js";
import {
  assertStorageToolSideEffectV11SchemaReady,
  migrateStorageToolSideEffectV11Schema,
  STORAGE_TOOL_SIDE_EFFECT_MIGRATION_CHECKSUM,
  STORAGE_TOOL_SIDE_EFFECT_MIGRATION_NAME,
  STORAGE_TOOL_SIDE_EFFECT_SCHEMA_VERSION
} from "./toolSideEffectReservationSchema.js";
import { SideEffectReservationConflictError, type StorageToolSideEffectReservation } from "./toolSideEffectReservationTypes.js";
import type { StorageJob, StorageLeaseFence } from "./types.js";
import type { StorageToolAttempt, StorageToolDecision } from "./traceTypes.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("durable tool side-effect reservations", () => {
  it("installs the checksum-bound v11 ledger idempotently and fails readiness on object drift", () => {
    const db = new DatabaseSync(":memory:");
    try {
      migrateStorageV2Schema(db);
      const before = schemaSql(db);
      migrateStorageToolSideEffectV11Schema(db);
      expect(schemaSql(db)).toEqual(before);
      expect(db.prepare("select name,checksum_sha256 from schema_migrations where version=?").get(STORAGE_TOOL_SIDE_EFFECT_SCHEMA_VERSION)).toEqual({
        name: STORAGE_TOOL_SIDE_EFFECT_MIGRATION_NAME,
        checksum_sha256: STORAGE_TOOL_SIDE_EFFECT_MIGRATION_CHECKSUM
      });
      db.exec("drop trigger trg_tool_side_effect_reservations_owner_update");
      expect(() => assertStorageToolSideEffectV11SchemaReady(db)).toThrow(/trigger is missing/i);
    } finally {
      db.close();
    }
  });

  it("binds the migration checksum to normalized SQL and backfills duplicate executions as ambiguous", () => {
    const source = readFileSync(new URL("./toolSideEffectReservationSchema.ts", import.meta.url), "utf8");
    const anchor = source.indexOf("function installStorageToolSideEffectV11Objects");
    const marker = "db.exec(`";
    const start = source.indexOf(marker, anchor) + marker.length;
    const end = source.indexOf("`);", start);
    const normalized = source
      .slice(start, end)
      .replace(
        /values \(11, 'operational-tool-side-effect-reservations-v11', '[a-f0-9]{64}', datetime\('now'\)\)/,
        "values (11, 'operational-tool-side-effect-reservations-v11', '<checksum>', datetime('now'))"
      );
    expect(hash(normalized)).toBe(STORAGE_TOOL_SIDE_EFFECT_MIGRATION_CHECKSUM);

    const db = new DatabaseSync(":memory:");
    try {
      migrateStorageV2Schema(db);
      db.exec(`
        drop trigger trg_tool_side_effect_reservations_owner_insert;
        drop trigger trg_tool_side_effect_reservations_owner_update;
        drop table tool_side_effect_reservations;
        delete from schema_migrations where version=11;
      `);
      seedBackfillTrace(db, "job-backfill-1", "attempt-backfill-a", "completed", "2026-07-15T00:00:01.000Z");
      seedBackfillTrace(db, "job-backfill-2", "attempt-backfill-b", "interrupted", "2026-07-15T00:00:02.000Z");

      migrateStorageToolSideEffectV11Schema(db);
      const first = db.prepare("select * from tool_side_effect_reservations").get();
      const repositories = createStorageV2Repositories({ appDb: db });
      expect(() => repositories.toolSideEffects.observeAttempt(repositories.trace.getToolAttempt("attempt-backfill-b")!)).not.toThrow();
      migrateStorageToolSideEffectV11Schema(db);
      expect(db.prepare("select * from tool_side_effect_reservations").get()).toEqual(first);
      expect(first).toMatchObject({ attempt_id: "attempt-backfill-a", status: "ambiguous", generation: 2 });
    } finally {
      db.close();
    }
  });

  it("blocks a response-loss retry before the second external execution and terminalizes every attempt", () => {
    const fixture = runtimeFixture();
    const runtime = fixture.runtime;
    let externalExecutions = 0;
    try {
      const first = enqueueAndClaim(runtime, "job-effect-1", "request-1", fixture.now, "worker-1");
      const firstTrace = trace("job-effect-1", "attempt-effect-1", fixture.now);
      runtime.handle({ name: "fencedTransaction", fence: first.fence, commands: commands(firstTrace, "running") });
      externalExecutions += 1;

      const failed = runtime.handle({
        name: "job.transitionTerminal",
        input: { fence: first.fence, status: "failed", projectRevision: 1, reason: "Solver response was lost.", occurredAt: later(fixture.now, 1_000) }
      }) as StorageTerminalTransitionResult;
      expect(failed.events.map((event) => event.type)).toEqual(["tool.run.changed", "run.status.changed"]);
      expect(runtime.handle({ name: "trace.attempt.get", attemptId: firstTrace.attempt.id })).toMatchObject({
        status: "interrupted",
        terminalCause: "job_failed"
      });

      const second = enqueueAndClaim(runtime, "job-effect-2", "request-2", later(fixture.now, 2_000), "worker-2");
      const secondTrace = trace("job-effect-2", "attempt-effect-2", later(fixture.now, 2_000));
      runtime.handle({ name: "fencedTransaction", fence: second.fence, commands: commands(secondTrace, "queued") });
      expect(() =>
        runtime.handle({
          name: "fencedTransaction",
          fence: second.fence,
          commands: [{ name: "trace.attempt.save", attempt: runningAttempt(secondTrace.attempt) }]
        })
      ).toThrow(SideEffectReservationConflictError);
      expect(runtime.handle({ name: "trace.attempt.get", attemptId: secondTrace.attempt.id })).toMatchObject({ status: "queued" });

      runtime.handle({
        name: "job.transitionTerminal",
        input: {
          fence: second.fence,
          status: "failed",
          projectRevision: 1,
          reason: "Prior external side effect is unresolved.",
          occurredAt: later(fixture.now, 3_000)
        }
      });
      expect(runtime.handle({ name: "trace.attempt.get", attemptId: secondTrace.attempt.id })).toMatchObject({
        status: "interrupted",
        terminalCause: "job_failed"
      });
      expect(externalExecutions).toBe(1);
      expect(
        runtime.handle({ name: "trace.sideEffect.get", projectId: "project-effect", sideEffectKey: firstTrace.attempt.sideEffectKey as string })
      ).toMatchObject<StorageToolSideEffectReservation>({
        attemptId: firstTrace.attempt.id,
        status: "ambiguous",
        generation: 1
      });
    } finally {
      runtime.close();
    }
  });

  it("marks an in-flight reservation ambiguous in the same lease-expiry recovery transaction", () => {
    const fixture = runtimeFixture();
    const runtime = fixture.runtime;
    try {
      const claimed = enqueueAndClaim(runtime, "job-expired-effect", "request-expired", fixture.now, "worker-expired");
      const value = trace("job-expired-effect", "attempt-expired-effect", fixture.now);
      runtime.handle({ name: "fencedTransaction", fence: claimed.fence, commands: commands(value, "running") });

      fixture.advance(120_000);
      const sweep = runtime.handle({ name: "job.markInterruptedExpiredLeases", now: later(fixture.now, 120_000) }) as {
        jobs: StorageJob[];
        events: Array<{ type: string }>;
      };
      expect(sweep.jobs).toEqual([expect.objectContaining({ id: claimed.job.id, status: "interrupted" })]);
      expect(sweep.events.map((event) => event.type)).toEqual(["tool.run.changed", "run.status.changed"]);
      expect(runtime.handle({ name: "trace.attempt.get", attemptId: value.attempt.id })).toMatchObject({
        status: "interrupted",
        terminalCause: "lease_expired"
      });
      expect(runtime.handle({ name: "trace.sideEffect.getAttempt", attemptId: value.attempt.id })).toMatchObject({
        status: "ambiguous",
        generation: 1
      });
    } finally {
      runtime.close();
    }
  });
});

function runtimeFixture(): { runtime: StorageWorkerRuntime; now: string; advance(milliseconds: number): void } {
  const root = mkdtempSync(join(tmpdir(), "aetherops-side-effect-"));
  roots.push(root);
  const path = join(root, "storage.sqlite");
  const db = new DatabaseSync(path);
  migrateStorageV2Schema(db);
  db.close();
  let clockMs = Date.now();
  return {
    runtime: new StorageWorkerRuntime({ appDbPath: path, vectorDbPath: path, ontologyDbPath: path, dataRoot: root }, { leaseClock: () => clockMs }),
    now: new Date(clockMs).toISOString(),
    advance(milliseconds) {
      clockMs += milliseconds;
    }
  };
}

function enqueueAndClaim(
  runtime: StorageWorkerRuntime,
  jobId: string,
  idempotencyKey: string,
  now: string,
  leaseOwner: string
): { job: StorageJob; fence: StorageLeaseFence } {
  runtime.handle({
    name: "job.enqueue",
    job: {
      id: jobId,
      projectId: "project-effect",
      operation: "engineering_run",
      idempotencyKey,
      requestHash: hash(idempotencyKey),
      payload: { projectRevision: 1 },
      createdAt: now,
      queuedAt: now
    }
  });
  return runtime.handle({
    name: "job.claimAndStart",
    options: { projectId: "project-effect", leaseOwner, now, leaseExpiresAt: later(now, 60_000) }
  }) as { job: StorageJob; fence: StorageLeaseFence };
}

function trace(jobId: string, attemptId: string, queuedAt: string): { decision: StorageToolDecision; attempt: StorageToolAttempt } {
  const decisionId = `decision-${attemptId}`;
  return {
    decision: {
      id: decisionId,
      projectId: "project-effect",
      jobId,
      toolName: "EngineeringProgramTool",
      purpose: "Run one deterministic solver case.",
      expectedOutcome: "A solver receipt.",
      rawSelection: {},
      userPinned: true,
      policyStatus: "accepted",
      createdAt: queuedAt
    },
    attempt: {
      id: attemptId,
      projectId: "project-effect",
      jobId,
      decisionId,
      ordinal: 0,
      status: "queued",
      inputHash: hash("same-solver-input"),
      traceVersion: 1,
      traceAvailability: "vnext",
      descriptorVersion: "1",
      descriptorSideEffects: ["filesystem", "process"],
      sideEffectKey: hash("same-external-side-effect"),
      idempotencyKey: hash("same-tool-idempotency"),
      dependsOnAttemptIds: [],
      stagingRef: `staging/jobs/${jobId}/execution/actions/action-1`,
      queuedAt
    }
  };
}

function commands(value: ReturnType<typeof trace>, status: "queued" | "running"): StorageFencedWriteCommand[] {
  return [
    { name: "trace.decision.record", decision: value.decision },
    { name: "trace.attempt.save", attempt: value.attempt },
    ...(status === "running" ? [{ name: "trace.attempt.save", attempt: runningAttempt(value.attempt) } satisfies StorageFencedWriteCommand] : [])
  ];
}

function runningAttempt(attempt: StorageToolAttempt): StorageToolAttempt {
  return { ...attempt, status: "running", startedAt: later(attempt.queuedAt, 1) };
}

function later(value: string, milliseconds: number): string {
  return new Date(Date.parse(value) + milliseconds).toISOString();
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function schemaSql(db: DatabaseSync): unknown[] {
  return db.prepare("select type,name,tbl_name,sql from sqlite_master where name not like 'sqlite_%' order by type,name").all();
}

function seedBackfillTrace(db: DatabaseSync, jobId: string, attemptId: string, status: "completed" | "interrupted", completedAt: string): void {
  const queuedAt = "2026-07-15T00:00:00.000Z";
  const decisionId = `decision-${attemptId}`;
  db.prepare(
    `insert into jobs
      (id,project_id,operation,status,priority,attempt,lease_generation,queued_at,completed_at,created_at,updated_at,payload)
     values(?,?,'engineering_run','failed',0,1,1,?,?,?,?,?)`
  ).run(jobId, "project-backfill", queuedAt, completedAt, queuedAt, completedAt, JSON.stringify({ projectRevision: 1 }));
  db.prepare(
    `insert into tool_decisions
      (id,project_id,job_id,tool_name,purpose,expected_outcome,raw_selection,user_pinned,policy_status,created_at)
     values(?,?,?,?,?,?,?,?,?,?)`
  ).run(decisionId, "project-backfill", jobId, "EngineeringProgramTool", "Backfill", "Receipt", "{}", 1, "accepted", queuedAt);
  db.prepare(
    `insert into tool_attempts
      (id,project_id,job_id,decision_id,ordinal,status,input_hash,output_hash,trace_version,descriptor_version,
       descriptor_side_effects,side_effect_key,idempotency_key,terminal_cause,depends_on_attempt_ids,queued_at,started_at,completed_at)
     values(?,?,?,?,0,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(
    attemptId,
    "project-backfill",
    jobId,
    decisionId,
    status,
    hash("backfill-input"),
    status === "completed" ? hash(`output-${attemptId}`) : null,
    1,
    "1",
    JSON.stringify(["filesystem", "process"]),
    hash("backfill-side-effect"),
    hash("backfill-idempotency"),
    status === "interrupted" ? "lease_expired" : null,
    "[]",
    queuedAt,
    later(queuedAt, 1),
    completedAt
  );
}
