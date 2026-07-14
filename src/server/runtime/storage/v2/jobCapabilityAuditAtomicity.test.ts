import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { StorageWorkerRuntime } from "../worker/typedRuntime.js";
import { IdempotencyConflictError } from "./jobErrors.js";
import { migrateStorageV2Schema } from "./schema.js";
import type { StorageCapabilityAudit, StorageJobInput } from "./types.js";

let root: string | undefined;
let runtime: StorageWorkerRuntime | undefined;

afterEach(() => {
  runtime?.close();
  if (root) rmSync(root, { recursive: true, force: true });
  root = undefined;
  runtime = undefined;
});

describe("atomic job authorization receipt", () => {
  it("atomically projects a project with one complete jobless capability snapshot", () => {
    const path = createRuntime();
    const projectRoot = join(root!, "first-denial-project");
    mkdirSync(projectRoot);
    const project = projectProjection(projectRoot, "First denied request", "2026-07-14T00:00:00.000Z");
    const persisted = runtime!.handle({ name: "capability.recordSet", project, audits: audits(undefined, "audit-first-denial") }) as
      StorageCapabilityAudit[] | undefined;
    expect(persisted).toHaveLength(3);
    expect(runtime!.handle({ name: "project.get", projectId: project.id })).toEqual(project);

    const db = new DatabaseSync(path, { readOnly: true });
    try {
      expect(db.prepare("select count(*) count from capability_audits where project_id=? and job_id is null").get(project.id)).toEqual({ count: 3 });
    } finally {
      db.close();
    }
  });

  it("rolls back the project projection when a jobless capability set is incomplete or collides", () => {
    const path = createRuntime();
    const projectRoot = join(root!, "jobless-audit-rollback");
    mkdirSync(projectRoot);
    const project = projectProjection(projectRoot, "Original projection", "2026-07-14T00:00:00.000Z");
    expect(() => runtime!.handle({ name: "capability.recordSet", project, audits: audits(undefined, "audit-incomplete").slice(0, 2) })).toThrow();
    expect(runtime!.handle({ name: "project.get", projectId: project.id })).toBeUndefined();

    runtime!.handle({ name: "project.upsert", project });
    runtime!.handle({ name: "capability.record", audit: audits(undefined, "audit-collision")[0]! });
    expect(() =>
      runtime!.handle({
        name: "capability.recordSet",
        project: projectProjection(projectRoot, "Must roll back", "2026-07-14T00:01:00.000Z"),
        audits: audits(undefined, "audit-collision")
      })
    ).toThrow();
    expect(runtime!.handle({ name: "project.get", projectId: project.id })).toEqual(project);
    const db = new DatabaseSync(path, { readOnly: true });
    try {
      expect(db.prepare("select count(*) count from capability_audits").get()).toEqual({ count: 1 });
    } finally {
      db.close();
    }
  });

  it("commits job, queued event, and audits once and returns the same receipt on idempotent retry", () => {
    const path = createRuntime();
    const first = runtime!.handle({ name: "job.enqueue", job: job("job-first"), capabilityAudits: audits("job-first", "audit-first") }) as {
      job: { id: string };
      event: { sequence: number };
      capabilityAudits: StorageCapabilityAudit[];
    };
    const replayAudits = audits("job-retry", "audit-retry", "2026-07-14T00:01:00.000Z");
    replayAudits[0] = { ...replayAudits[0]!, appAllowed: false, allowed: false };
    const replay = runtime!.handle({
      name: "job.enqueue",
      job: job("job-retry"),
      capabilityAudits: replayAudits
    }) as typeof first;
    expect(replay.job.id).toBe(first.job.id);
    expect(replay.event.sequence).toBe(first.event.sequence);
    expect(replay.capabilityAudits).toEqual(first.capabilityAudits);
    expect(() =>
      runtime!.handle({
        name: "job.enqueue",
        job: { ...job("job-conflicting-hash"), requestHash: "different-request-hash" },
        capabilityAudits: []
      })
    ).toThrow(IdempotencyConflictError);
    const db = new DatabaseSync(path, { readOnly: true });
    try {
      expect(db.prepare("select count(*) count from jobs").get()).toEqual({ count: 1 });
      expect(db.prepare("select count(*) count from job_events").get()).toEqual({ count: 1 });
      expect(db.prepare("select count(*) count from capability_audits where job_id=?").get("job-first")).toEqual({ count: 3 });
    } finally {
      db.close();
    }
  });

  it("rolls the job and event back when any audit cannot be committed", () => {
    const path = createRuntime();
    const projectRoot = join(root!, "audit-project");
    mkdirSync(projectRoot);
    runtime!.handle({ name: "project.upsert", project: projectProjection(projectRoot, "Audit project", "2026-07-14T00:00:00.000Z") });
    runtime!.handle({ name: "capability.record", audit: audits(undefined, "audit-collision")[0]! });
    expect(() => runtime!.handle({ name: "job.enqueue", job: job("job-rollback"), capabilityAudits: audits("job-rollback", "audit-collision") })).toThrow();
    const db = new DatabaseSync(path, { readOnly: true });
    try {
      expect(db.prepare("select count(*) count from jobs where id='job-rollback'").get()).toEqual({ count: 0 });
      expect(db.prepare("select count(*) count from job_events where job_id='job-rollback'").get()).toEqual({ count: 0 });
      expect(db.prepare("select count(*) count from capability_audits").get()).toEqual({ count: 1 });
    } finally {
      db.close();
    }
  });

  it("rejects missing, incomplete, or capability-inconsistent audit snapshots before committing a job", () => {
    const path = createRuntime();
    expect(() => runtime!.handle({ name: "job.enqueue", job: job("job-missing-audits") })).toThrow();
    expect(() =>
      runtime!.handle({
        name: "job.enqueue",
        job: job("job-incomplete-audits"),
        capabilityAudits: audits("job-incomplete-audits", "audit-incomplete").slice(0, 2)
      })
    ).toThrow();
    const inconsistent = audits("job-inconsistent-audits", "audit-inconsistent");
    inconsistent[0] = { ...inconsistent[0]!, allowed: false };
    expect(() => runtime!.handle({ name: "job.enqueue", job: job("job-inconsistent-audits"), capabilityAudits: inconsistent })).toThrow();
    const db = new DatabaseSync(path, { readOnly: true });
    try {
      expect(db.prepare("select count(*) count from jobs").get()).toEqual({ count: 0 });
      expect(db.prepare("select count(*) count from job_events").get()).toEqual({ count: 0 });
      expect(db.prepare("select count(*) count from capability_audits").get()).toEqual({ count: 0 });
    } finally {
      db.close();
    }
  });

  it("returns an idempotent receipt before a replay can mutate the project projection", () => {
    createRuntime();
    const projectRoot = join(root!, "project-root");
    mkdirSync(projectRoot);
    const original = projectProjection(projectRoot, "Original topic", "2026-07-14T00:00:00.000Z");
    runtime!.handle({
      name: "job.enqueue",
      job: job("job-project-first"),
      project: original,
      capabilityAudits: audits("job-project-first", "audit-project-first")
    });
    runtime!.handle({
      name: "job.enqueue",
      job: job("job-project-replay"),
      project: projectProjection(projectRoot, "Replay mutation", "2026-07-14T00:05:00.000Z"),
      capabilityAudits: audits("job-project-replay", "audit-project-replay")
    });
    expect(runtime!.handle({ name: "project.get", projectId: "project-job-audit" })).toEqual(original);
  });
});

function createRuntime(): string {
  root = mkdtempSync(join(tmpdir(), "aetherops-job-audit-atomicity-"));
  const path = join(root, "storage.sqlite");
  const db = new DatabaseSync(path);
  migrateStorageV2Schema(db);
  db.close();
  runtime = new StorageWorkerRuntime({ appDbPath: path, vectorDbPath: path, ontologyDbPath: path, dataRoot: root });
  return path;
}

function job(id: string): StorageJobInput {
  return {
    id,
    projectId: "project-job-audit",
    operation: "research_loop",
    idempotencyKey: "atomic-audit-key",
    requestHash: "atomic-audit-request-hash",
    requestedCapabilities: { agent: true, engineering: false, search: false },
    effectiveCapabilities: { agent: true, engineering: false, search: false },
    payload: { projectRevision: 1, currentStep: "PLAN_RESEARCH" },
    createdAt: "2026-07-14T00:00:00.000Z",
    queuedAt: "2026-07-14T00:00:00.000Z"
  };
}

function audits(jobId: string | undefined, prefix: string, auditedAt = "2026-07-14T00:00:00.000Z"): StorageCapabilityAudit[] {
  return (["agent", "engineering", "search"] as const).map((capability) => ({
    id: `${prefix}-${capability}`,
    projectId: "project-job-audit",
    ...(jobId ? { jobId } : {}),
    operation: capability,
    capability,
    appAllowed: true,
    projectAllowed: true,
    operationAllowed: capability === "agent",
    allowed: capability === "agent",
    data: { jobKind: "research_loop", ...(capability === "agent" ? {} : { blockedBy: "job" as const }) },
    auditedAt
  }));
}

function projectProjection(projectRoot: string, topic: string, updatedAt: string) {
  return {
    id: "project-job-audit",
    projectRoot,
    topic,
    status: "active",
    createdAt: "2026-07-14T00:00:00.000Z",
    updatedAt
  };
}
