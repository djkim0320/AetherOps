import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { StorageWorkerRuntime } from "../worker/typedRuntime.js";
import { createStorageV2Repositories } from "./repositories.js";
import { migrateStorageV2Schema, STORAGE_V2_SCHEMA_VERSION } from "./schema.js";
import { STORAGE_TRACE_MIGRATION_CHECKSUM } from "./traceSchema.js";

describe("storage operational trace v3", () => {
  it("upgrades an existing jobs table additively and is idempotent", () => {
    const db = new DatabaseSync(":memory:");
    createLegacyJobsTable(db);
    db.prepare(
      `insert into jobs (id, project_id, operation, status, priority, attempt, idempotency_key, requested_by,
      queued_at, created_at, updated_at, payload) values (?, ?, ?, 'queued', 0, 0, ?, ?, ?, ?, ?, ?)`
    ).run("legacy-job", "project-1", "research_loop", "legacy-key", "user", "2026-01-01", "2026-01-01", "2026-01-01", "{}");

    migrateStorageV2Schema(db);
    migrateStorageV2Schema(db);

    const columns = new Set((db.prepare("pragma table_info(jobs)").all() as Array<{ name: string }>).map((row) => row.name));
    expect([...columns]).toEqual(
      expect.arrayContaining(["request_hash", "requested_capabilities", "effective_capabilities", "tool_policy", "blocked_reason", "failure_reason"])
    );
    expect(db.prepare("select id, requested_by from jobs").get()).toEqual({ id: "legacy-job", requested_by: "user" });
    expect(db.prepare("select value from storage_v2_meta where key='schema_version'").get()).toEqual({ value: String(STORAGE_V2_SCHEMA_VERSION) });
    expect(db.prepare("select version, checksum_sha256 from schema_migrations").all()).toEqual([
      { version: 2, checksum_sha256: "99b17d1e0aebc8bb0a2c29084f2f44a263d6644a551a2116429542a20e24016c" },
      { version: 3, checksum_sha256: STORAGE_TRACE_MIGRATION_CHECKSUM }
    ]);
    db.close();
  });

  it("blocks executable legacy plans for strict replanning without rewriting their payload", () => {
    const db = migratedDatabase();
    const now = "2026-07-11T00:00:00.000Z";
    const payload = JSON.stringify({ researchPlan: { requiredTools: ["OpenCodeTool"] } });
    db.prepare(
      `insert into jobs (id, project_id, operation, status, priority, attempt, idempotency_key,
       queued_at, created_at, updated_at, payload) values (?, ?, 'research_loop', 'queued', 0, 0, ?, ?, ?, ?, ?)`
    ).run("legacy-job", "project-1", "legacy-key", now, now, now, payload);

    migrateStorageV2Schema(db);
    expect(db.prepare("select status, error, payload from jobs where id=?").get("legacy-job")).toEqual({
      status: "blocked",
      error: "replan_required_executor_removed",
      payload
    });
    migrateStorageV2Schema(db);
    expect(db.prepare("select status, error from jobs where id=?").get("legacy-job")).toEqual({
      status: "blocked",
      error: "replan_required_executor_removed"
    });
    db.close();
  });

  it("persists job policy and rejects a reused idempotency key with a different request hash", () => {
    const db = migratedDatabase();
    const jobs = createStorageV2Repositories({ appDb: db }).jobs;
    const input = {
      id: "job-1",
      projectId: "project-1",
      operation: "research_loop",
      idempotencyKey: "key-1",
      requestHash: "hash-a",
      requestedCapabilities: { agent: true, engineering: true, search: false },
      effectiveCapabilities: { agent: true, engineering: false, search: false },
      toolPolicy: { allowCodexCli: false, sourceAccess: { mode: "offline" as const } }
    };
    expect(jobs.enqueue(input)).toMatchObject(input);
    expect(jobs.enqueue({ ...input, id: "job-duplicate" }).id).toBe("job-1");
    expect(() => jobs.enqueue({ ...input, id: "job-conflict", requestHash: "hash-b" })).toThrow(/request hash does not match/);
    db.close();
  });

  it("persists explicit terminal reasons and rejects reasonless blocked or failed jobs", () => {
    const db = migratedDatabase();
    const jobs = createStorageV2Repositories({ appDb: db }).jobs;
    jobs.enqueue({ id: "job-reason", projectId: "project-1", operation: "research_loop" });
    expect(() => jobs.updateStatus("job-reason", { status: "blocked" })).toThrow("blockedReason");
    expect(jobs.updateStatus("job-reason", { status: "blocked", blockedReason: "capability_revoked" })).toMatchObject({
      status: "blocked",
      blockedReason: "capability_revoked"
    });
    db.close();
  });

  it("round-trips trace commands through the typed worker runtime", () => {
    const root = mkdtempSync(join(tmpdir(), "aetherops-trace-worker-"));
    const databasePath = join(root, "storage.sqlite");
    const db = migratedDatabase(databasePath);
    db.close();
    const runtime = new StorageWorkerRuntime({ appDbPath: databasePath, vectorDbPath: databasePath, ontologyDbPath: databasePath });
    try {
      runtime.handle({
        name: "trace.llm.save",
        invocation: {
          id: "llm-1",
          projectId: "project-1",
          jobId: "job-1",
          model: "gpt-5.6-sol",
          reasoningEffort: "high",
          promptVersion: "planner-v2",
          schemaVersion: "2",
          promptHash: "prompt-hash",
          repairCount: 0,
          status: "completed",
          startedAt: "2026-01-01T00:00:00.000Z",
          completedAt: "2026-01-01T00:00:01.000Z"
        }
      });
      runtime.handle({
        name: "trace.decision.record",
        decision: {
          id: "decision-1",
          projectId: "project-1",
          jobId: "job-1",
          invocationId: "llm-1",
          toolName: "WebFetchTool",
          purpose: "Fetch an allowlisted source.",
          expectedOutcome: "A validated source record.",
          rawSelection: { url: "https://example.com" },
          userPinned: true,
          policyStatus: "accepted",
          createdAt: "2026-01-01T00:00:01.000Z"
        }
      });
      runtime.handle({
        name: "trace.attempt.save",
        attempt: {
          id: "attempt-1",
          projectId: "project-1",
          jobId: "job-1",
          decisionId: "decision-1",
          ordinal: 0,
          status: "completed",
          inputHash: "input-hash",
          outputHash: "output-hash",
          terminalCause: "completed",
          dependsOnAttemptIds: [],
          queuedAt: "2026-01-01T00:00:01.000Z",
          startedAt: "2026-01-01T00:00:01.100Z",
          completedAt: "2026-01-01T00:00:02.000Z"
        }
      });
      runtime.handle({
        name: "trace.codex.save",
        execution: {
          id: "codex-1",
          projectId: "project-1",
          jobId: "job-1",
          attemptId: "attempt-1",
          model: "gpt-5.6-sol",
          reasoningEffort: "high",
          sandboxProfile: "aetherops-workspace-v1",
          networkPolicy: "disabled",
          durationMs: 500,
          exitCode: 0,
          eventCount: 4,
          workspaceManifestHash: "workspace-hash",
          outputManifestHash: "output-manifest-hash",
          createdAt: "2026-01-01T00:00:01.000Z",
          completedAt: "2026-01-01T00:00:01.500Z"
        }
      });
      runtime.handle({
        name: "trace.output.record",
        link: {
          id: "link-1",
          projectId: "project-1",
          jobId: "job-1",
          attemptId: "attempt-1",
          outputKind: "evidence",
          outputId: "evidence-1",
          promoted: true,
          createdAt: "2026-01-01T00:00:02.000Z",
          promotedAt: "2026-01-01T00:00:02.100Z"
        }
      });
      runtime.handle({
        name: "trace.network.record",
        audit: {
          id: "network-1",
          projectId: "project-1",
          jobId: "job-1",
          attemptId: "attempt-1",
          url: "https://example.com",
          redirectChain: [],
          sourcePolicy: { mode: "allowlist", urls: ["https://example.com"] },
          policyDecision: "allowed",
          auditedAt: "2026-01-01T00:00:01.200Z"
        }
      });
      expect(runtime.handle({ name: "trace.llm.listJob", jobId: "job-1" })).toEqual([expect.objectContaining({ id: "llm-1", model: "gpt-5.6-sol" })]);
      expect(runtime.handle({ name: "trace.decision.listJob", jobId: "job-1" })).toEqual([
        expect.objectContaining({ id: "decision-1", policyStatus: "accepted" })
      ]);
      expect(runtime.handle({ name: "trace.attempt.listJob", jobId: "job-1" })).toEqual([expect.objectContaining({ id: "attempt-1", status: "completed" })]);
      expect(runtime.handle({ name: "trace.codex.listJob", jobId: "job-1" })).toEqual([
        expect.objectContaining({ id: "codex-1", networkPolicy: "disabled", eventCount: 4 })
      ]);
      expect(runtime.handle({ name: "trace.output.listAttempt", attemptId: "attempt-1" })).toEqual([expect.objectContaining({ id: "link-1", promoted: true })]);
      expect(runtime.handle({ name: "trace.network.listJob", jobId: "job-1" })).toEqual([
        expect.objectContaining({ id: "network-1", policyDecision: "allowed" })
      ]);
    } finally {
      runtime.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});

function migratedDatabase(path = ":memory:"): DatabaseSync {
  const db = new DatabaseSync(path);
  migrateStorageV2Schema(db);
  return db;
}

function createLegacyJobsTable(db: DatabaseSync): void {
  db.exec(`
    create table jobs (
      id text primary key, project_id text not null, operation text not null, status text not null,
      priority integer not null default 0, attempt integer not null default 0, idempotency_key text,
      requested_by text, lease_owner text, lease_expires_at text, queued_at text not null, started_at text,
      completed_at text, created_at text not null, updated_at text not null, payload text not null, result text, error text
    );
  `);
}
