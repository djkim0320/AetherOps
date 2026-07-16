import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { StorageWorkerRuntime } from "../worker/typedRuntime.js";
import { migrateStorageV2Schema } from "./schema.js";
import type { StorageClaimStartResult, StorageJobEvent } from "./types.js";

let root: string | undefined;
let runtime: StorageWorkerRuntime | undefined;

afterEach(() => {
  runtime?.close();
  runtime = undefined;
  if (root) rmSync(root, { recursive: true, force: true });
  root = undefined;
});

describe("terminal project snapshot atomicity", () => {
  it("commits the terminal status before its project snapshot event in one transition", () => {
    const path = createRuntime();
    const claimed = enqueueAndClaim("job-snapshot-order", "project-snapshot-order");

    const result = transition(claimed, 2) as { events: StorageJobEvent[] };

    expect(result.events.map((event) => event.type)).toEqual(["run.status.changed", "project.snapshot.changed"]);
    expect(result.events[0]?.sequence).toBeLessThan(result.events[1]?.sequence ?? 0);

    const readback = new DatabaseSync(path, { readOnly: true });
    try {
      expect(readback.prepare("select status from jobs where id=?").get(claimed.job.id)).toEqual({ status: "completed" });
      expect(readback.prepare("select type from job_events where job_id=? order by sequence").all(claimed.job.id)).toEqual([
        { type: "run.status.changed" },
        { type: "run.status.changed" },
        { type: "run.status.changed" },
        { type: "project.snapshot.changed" }
      ]);
    } finally {
      readback.close();
    }
  });

  it("rolls the terminal status and event back when the project snapshot event insert fails", () => {
    const path = createRuntime();
    const claimed = enqueueAndClaim("job-snapshot-fault", "project-snapshot-fault");
    recordCompletedArtifactAttempt(claimed);
    const eventsBeforeTransition = eventCount(path, claimed.job.id);
    const setup = new DatabaseSync(path);
    setup.exec(`
      create trigger fail_project_snapshot_event before insert on job_events
      when new.type = 'project.snapshot.changed'
      begin select raise(abort, 'injected snapshot event failure'); end;
    `);
    setup.close();

    expect(() => transition(claimed, 2, artifactPromotion(claimed))).toThrow("injected snapshot event failure");

    const readback = new DatabaseSync(path, { readOnly: true });
    try {
      expect(readback.prepare("select status,result,completed_at from jobs where id=?").get(claimed.job.id)).toEqual({
        status: "running",
        result: null,
        completed_at: null
      });
      expect(readback.prepare("select count(*) count from job_events where job_id=?").get(claimed.job.id)).toEqual({ count: eventsBeforeTransition });
      expect(readback.prepare("select count(*) count from tool_output_links where job_id=?").get(claimed.job.id)).toEqual({ count: 0 });
    } finally {
      readback.close();
    }
  });

  it("returns the same terminal and snapshot events without duplicating them on retry", () => {
    const path = createRuntime();
    const claimed = enqueueAndClaim("job-snapshot-retry", "project-snapshot-retry");

    const first = transition(claimed, 2) as { events: StorageJobEvent[] };
    const retry = transition(claimed, 2) as { events: StorageJobEvent[] };

    expect(retry.events).toEqual(first.events);
    const readback = new DatabaseSync(path, { readOnly: true });
    try {
      expect(readback.prepare("select count(*) count from job_events where job_id=?").get(claimed.job.id)).toEqual({ count: 4 });
      expect(readback.prepare("select count(distinct event_id) count from job_events where job_id=?").get(claimed.job.id)).toEqual({ count: 4 });
    } finally {
      readback.close();
    }
  });
});

function createRuntime(): string {
  root = mkdtempSync(join(tmpdir(), "aetherops-terminal-snapshot-"));
  const path = join(root, "storage.sqlite");
  const db = new DatabaseSync(path);
  migrateStorageV2Schema(db);
  db.close();
  runtime = new StorageWorkerRuntime(
    { appDbPath: path, vectorDbPath: path, ontologyDbPath: path },
    { leaseClock: () => Date.parse("2026-07-16T00:00:01.000Z") }
  );
  return path;
}

function enqueueAndClaim(jobId: string, projectId: string): StorageClaimStartResult {
  const projectRoot = join(root as string, projectId);
  mkdirSync(projectRoot);
  runtime?.handle({
    name: "project.upsert",
    project: {
      id: projectId,
      projectRoot,
      topic: projectId,
      status: "active",
      createdAt: "2026-07-16T00:00:00.000Z",
      updatedAt: "2026-07-16T00:00:00.000Z"
    }
  });
  runtime?.handle({
    name: "job.enqueue",
    job: {
      id: jobId,
      projectId,
      operation: "research_loop",
      expectedProjectRevision: 0,
      idempotencyKey: jobId,
      createdAt: "2026-07-16T00:00:00.000Z",
      queuedAt: "2026-07-16T00:00:00.000Z",
      payload: { projectRevision: 1, currentStep: "EXECUTE_TOOLS" }
    }
  });
  return runtime?.handle({
    name: "job.claimAndStart",
    options: {
      projectId,
      leaseOwner: "worker-terminal-snapshot",
      leaseExpiresAt: "2026-07-16T00:01:00.000Z",
      now: "2026-07-16T00:00:01.000Z"
    }
  }) as StorageClaimStartResult;
}

function transition(claimed: StorageClaimStartResult, projectRevision: number, promotions?: ReturnType<typeof artifactPromotion>): unknown {
  return runtime?.handle({
    name: "job.transitionTerminal",
    input: {
      fence: claimed.fence,
      status: "completed",
      projectRevision,
      snapshotChange: { snapshotVersion: projectRevision, reason: "job_changed" },
      ...(promotions ? { promotions } : {}),
      occurredAt: "2026-07-16T00:00:02.000Z"
    }
  });
}

function recordCompletedArtifactAttempt(claimed: StorageClaimStartResult): void {
  const common = {
    id: "attempt-snapshot-artifact",
    projectId: claimed.job.projectId,
    jobId: claimed.job.id,
    decisionId: "decision-snapshot-artifact",
    ordinal: 1,
    inputHash: "a".repeat(64),
    traceVersion: 1 as const,
    traceAvailability: "vnext" as const,
    descriptorVersion: "artifact-writer-v1",
    descriptorSideEffects: [] as const,
    idempotencyKey: "snapshot-artifact-idempotency",
    dependsOnAttemptIds: [] as string[],
    queuedAt: "2026-07-16T00:00:01.000Z"
  };
  runtime?.handle({
    name: "fencedTransaction",
    fence: claimed.fence,
    now: "2026-07-16T00:00:01.500Z",
    commands: [
      {
        name: "trace.decision.record",
        decision: {
          id: common.decisionId,
          projectId: claimed.job.projectId,
          jobId: claimed.job.id,
          toolName: "ArtifactWriterTool",
          purpose: "Verify that terminal artifact promotion and snapshot publication are atomic.",
          expectedOutcome: "A snapshot insertion fault leaves no promoted output.",
          rawSelection: {},
          userPinned: false,
          policyStatus: "accepted",
          createdAt: common.queuedAt
        }
      },
      { name: "trace.attempt.save", attempt: { ...common, status: "queued" } },
      { name: "trace.attempt.save", attempt: { ...common, status: "running", startedAt: common.queuedAt } },
      {
        name: "trace.attempt.save",
        attempt: {
          ...common,
          status: "completed",
          outputHash: "b".repeat(64),
          terminalCause: "completed",
          startedAt: common.queuedAt,
          completedAt: "2026-07-16T00:00:01.500Z"
        }
      }
    ]
  });
}

function artifactPromotion(claimed: StorageClaimStartResult) {
  return [
    {
      link: {
        id: "output-link-snapshot-artifact",
        projectId: claimed.job.projectId,
        jobId: claimed.job.id,
        attemptId: "attempt-snapshot-artifact",
        outputKind: "artifact" as const,
        outputId: "artifact-snapshot-atomicity",
        promoted: true,
        createdAt: "2026-07-16T00:00:01.500Z",
        promotedAt: "2026-07-16T00:00:02.000Z"
      },
      artifact: { name: "snapshot-atomicity.json", kind: "research_report" }
    }
  ];
}

function eventCount(path: string, jobId: string): number {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    return Number((db.prepare("select count(*) count from job_events where job_id=?").get(jobId) as { count: number }).count);
  } finally {
    db.close();
  }
}
