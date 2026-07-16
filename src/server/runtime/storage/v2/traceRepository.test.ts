import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { StorageWorkerRuntime } from "../worker/typedRuntime.js";
import { createStorageV2Repositories } from "./repositories.js";
import { IdempotencyConflictError } from "./jobErrors.js";
import { migrateStorageV2Schema, STORAGE_V2_SCHEMA_VERSION } from "./schema.js";
import { STORAGE_JOB_MIGRATION_CHECKSUM } from "./jobSchema.js";
import { STORAGE_RUN_STATE_BOOTSTRAP_MIGRATION_CHECKSUM } from "./runStateBootstrapSchema.js";
import { STORAGE_RUN_STATE_MIGRATION_CHECKSUM } from "./runStateSchema.js";
import { STORAGE_TERMINAL_RECEIPT_MIGRATION_CHECKSUM } from "./terminalReceiptSchema.js";
import { STORAGE_TERMINAL_ATTESTATION_MIGRATION_CHECKSUM } from "./terminalAttestationSchema.js";
import { STORAGE_OWNERSHIP_MIGRATION_CHECKSUM } from "./ownershipSchema.js";
import { STORAGE_TOOL_SIDE_EFFECT_MIGRATION_CHECKSUM } from "./toolSideEffectReservationSchema.js";
import { STORAGE_ENGINEERING_BASELINE_MIGRATION_CHECKSUM } from "./engineeringBaselineSchema.js";
import { STORAGE_PROJECT_REVISION_MIGRATION_CHECKSUM } from "./projectRevisionSchema.js";
import { STORAGE_PROJECT_MUTATION_MIGRATION_CHECKSUM } from "./projectMutationSchema.js";
import { storageTestProjectRevision, upsertStorageTestProject } from "./storageWorkerTestSupport.js";
import { STORAGE_TRACE_MIGRATION_CHECKSUM, STORAGE_TRACE_V3_MIGRATION_CHECKSUM } from "./traceSchema.js";

const TRACE_LEASE_NOW_MS = Date.parse("2026-01-01T00:00:00.250Z");

describe("storage operational trace v3", () => {
  it("upgrades an existing jobs table additively and is idempotent", () => {
    const db = new DatabaseSync(":memory:");
    createLegacyJobsTable(db);
    createLegacyTraceV3Table(db);
    db.prepare(
      `insert into jobs (id, project_id, operation, status, priority, attempt, idempotency_key, requested_by,
      queued_at, created_at, updated_at, payload) values (?, ?, ?, 'queued', 0, 0, ?, ?, ?, ?, ?, ?)`
    ).run("legacy-job", "project-1", "research_loop", "legacy-key", "user", "2026-01-01", "2026-01-01", "2026-01-01", "{}");
    db.prepare(
      `insert into tool_attempts (id, project_id, job_id, decision_id, ordinal, status, input_hash, output_hash,
       queued_at, completed_at) values (?, ?, ?, ?, 0, 'completed', ?, ?, ?, ?)`
    ).run("legacy-attempt", "project-1", "legacy-job", "legacy-decision", "legacy-input", "legacy-output", "2026-01-01", "2026-01-01");

    migrateStorageV2Schema(db);
    migrateStorageV2Schema(db);

    const columns = new Set((db.prepare("pragma table_info(jobs)").all() as Array<{ name: string }>).map((row) => row.name));
    expect([...columns]).toEqual(
      expect.arrayContaining(["request_hash", "requested_capabilities", "effective_capabilities", "tool_policy", "blocked_reason", "failure_reason"])
    );
    expect(db.prepare("select id, requested_by from jobs").get()).toEqual({ id: "legacy-job", requested_by: "user" });
    expect(createStorageV2Repositories({ appDb: db }).trace.getToolAttempt("legacy-attempt")).toMatchObject({
      id: "legacy-attempt",
      inputHash: "legacy-input",
      outputHash: "legacy-output",
      traceAvailability: "legacy_unavailable",
      traceVersion: undefined
    });
    expect(db.prepare("select value from storage_v2_meta where key='schema_version'").get()).toEqual({ value: String(STORAGE_V2_SCHEMA_VERSION) });
    expect(db.prepare("select version, checksum_sha256 from schema_migrations").all()).toEqual([
      { version: 2, checksum_sha256: "99b17d1e0aebc8bb0a2c29084f2f44a263d6644a551a2116429542a20e24016c" },
      { version: 3, checksum_sha256: STORAGE_TRACE_V3_MIGRATION_CHECKSUM },
      { version: 4, checksum_sha256: STORAGE_JOB_MIGRATION_CHECKSUM },
      { version: 5, checksum_sha256: STORAGE_RUN_STATE_MIGRATION_CHECKSUM },
      { version: 6, checksum_sha256: STORAGE_TRACE_MIGRATION_CHECKSUM },
      { version: 7, checksum_sha256: STORAGE_RUN_STATE_BOOTSTRAP_MIGRATION_CHECKSUM },
      { version: 8, checksum_sha256: STORAGE_TERMINAL_RECEIPT_MIGRATION_CHECKSUM },
      { version: 9, checksum_sha256: STORAGE_TERMINAL_ATTESTATION_MIGRATION_CHECKSUM },
      { version: 10, checksum_sha256: STORAGE_OWNERSHIP_MIGRATION_CHECKSUM },
      { version: 11, checksum_sha256: STORAGE_TOOL_SIDE_EFFECT_MIGRATION_CHECKSUM },
      { version: 12, checksum_sha256: STORAGE_ENGINEERING_BASELINE_MIGRATION_CHECKSUM },
      { version: 13, checksum_sha256: STORAGE_PROJECT_REVISION_MIGRATION_CHECKSUM },
      { version: 14, checksum_sha256: STORAGE_PROJECT_MUTATION_MIGRATION_CHECKSUM }
    ]);
    const attemptColumns = new Set((db.prepare("pragma table_info(tool_attempts)").all() as Array<{ name: string }>).map((row) => row.name));
    expect([...attemptColumns]).toEqual(
      expect.arrayContaining([
        "trace_version",
        "descriptor_version",
        "descriptor_side_effects",
        "side_effect_key",
        "idempotency_key",
        "postcondition_disposition",
        "postcondition_receipt"
      ])
    );
    db.close();
  });

  it("fails before applying trace changes when migration v6 has a conflicting checksum", () => {
    const db = migratedDatabase();
    db.prepare("update schema_migrations set checksum_sha256='invalid' where version=6").run();
    expect(() => migrateStorageV2Schema(db)).toThrow(/migration 6.*checksum/i);
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
    expect(() => jobs.enqueue({ ...input, id: "job-conflict", requestHash: "hash-b" })).toThrow(IdempotencyConflictError);
    db.close();
  });

  it("persists explicit terminal reasons and rejects reasonless blocked or failed jobs", () => {
    const db = migratedDatabase();
    const jobs = createStorageV2Repositories({ appDb: db }).jobs;
    jobs.enqueue({ id: "job-reason", projectId: "project-1", operation: "research_loop" });
    jobs.claimNext({ leaseOwner: "worker-reason", leaseExpiresAt: "2999-01-01T00:00:00.000Z" });
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
    const runtime = createTraceWorkerRuntime(databasePath);
    try {
      upsertStorageTestProject(runtime, root, "project-1", "2026-01-01T00:00:00.000Z");
      runtime.handle({
        name: "job.enqueue",
        job: {
          id: "job-1",
          projectId: "project-1",
          operation: "research_loop",
          expectedProjectRevision: 0,
          createdAt: "2026-01-01T00:00:00.000Z",
          queuedAt: "2026-01-01T00:00:00.000Z",
          payload: { projectRevision: 1, currentStep: "EXECUTE_TOOLS" }
        }
      });
      const claimed = runtime.handle({
        name: "job.claimAndStart",
        options: {
          projectId: "project-1",
          leaseOwner: "trace-worker",
          leaseExpiresAt: "2026-01-01T01:00:00.000Z",
          now: "2026-01-01T00:00:00.500Z"
        }
      }) as import("./types.js").StorageClaimStartResult;
      const write = (command: import("../worker/typedProtocol.js").StorageFencedWriteCommand) =>
        runtime.handle({ name: "fencedTransaction", fence: claimed.fence, now: "2026-01-01T00:00:00.500Z", commands: [command] });

      write({
        name: "trace.llm.save",
        invocation: {
          id: "llm-1",
          projectId: "project-1",
          jobId: "job-1",
          model: "gpt-5.6-sol",
          reasoningEffort: "high",
          promptVersion: "planner-v2",
          schemaVersion: "2",
          promptHash: "a".repeat(64),
          repairCount: 0,
          status: "running",
          startedAt: "2026-01-01T00:00:00.000Z",
          data: { provider: "codex-oauth", schemaName: "ProviderHarness" }
        }
      });
      write({
        name: "trace.llm.save",
        invocation: {
          id: "llm-1",
          projectId: "project-1",
          jobId: "job-1",
          model: "gpt-5.6-sol",
          reasoningEffort: "high",
          promptVersion: "planner-v2",
          schemaVersion: "2",
          promptHash: "a".repeat(64),
          responseHash: "b".repeat(64),
          latencyMs: 1_000,
          repairCount: 0,
          status: "completed",
          startedAt: "2026-01-01T00:00:00.000Z",
          completedAt: "2026-01-01T00:00:01.000Z",
          data: {
            provider: "codex-oauth",
            schemaName: "ProviderHarness",
            accounting: {
              version: 1,
              inputUnits: 10,
              outputUnits: 2,
              unit: "estimated_token",
              estimator: "utf8_bytes_div_4_ceil_v1",
              monetaryCost: { availability: "unavailable", policy: "unmetered_codex_oauth_v1" }
            }
          }
        }
      });
      write({
        name: "trace.decision.record",
        decision: {
          id: "decision-1",
          projectId: "project-1",
          jobId: "job-1",
          invocationId: "llm-1",
          toolName: "WebFetchTool",
          purpose: "Fetch an allowlisted source.",
          expectedOutcome: "A validated source record.",
          rawSelection: { inputHash: "c".repeat(64) },
          userPinned: true,
          policyStatus: "accepted",
          createdAt: "2026-01-01T00:00:01.000Z"
        }
      });
      write({
        name: "trace.attempt.save",
        attempt: {
          id: "attempt-1",
          projectId: "project-1",
          jobId: "job-1",
          decisionId: "decision-1",
          ordinal: 0,
          status: "queued",
          inputHash: "f".repeat(64),
          traceVersion: 1,
          traceAvailability: "vnext",
          descriptorVersion: "1",
          descriptorSideEffects: ["network"],
          idempotencyKey: "attempt-idempotency-key",
          dependsOnAttemptIds: [],
          queuedAt: "2026-01-01T00:00:01.000Z"
        }
      });
      write({
        name: "trace.attempt.save",
        attempt: {
          id: "attempt-1",
          projectId: "project-1",
          jobId: "job-1",
          decisionId: "decision-1",
          ordinal: 0,
          status: "running",
          inputHash: "f".repeat(64),
          traceVersion: 1,
          traceAvailability: "vnext",
          descriptorVersion: "1",
          descriptorSideEffects: ["network"],
          idempotencyKey: "attempt-idempotency-key",
          dependsOnAttemptIds: [],
          queuedAt: "2026-01-01T00:00:01.000Z",
          startedAt: "2026-01-01T00:00:01.100Z"
        }
      });
      write({
        name: "trace.attempt.save",
        attempt: {
          id: "attempt-1",
          projectId: "project-1",
          jobId: "job-1",
          decisionId: "decision-1",
          ordinal: 0,
          status: "completed",
          inputHash: "f".repeat(64),
          outputHash: "0".repeat(64),
          traceVersion: 1,
          traceAvailability: "vnext",
          descriptorVersion: "1",
          descriptorSideEffects: ["network"],
          idempotencyKey: "attempt-idempotency-key",
          terminalCause: "completed",
          dependsOnAttemptIds: [],
          queuedAt: "2026-01-01T00:00:01.000Z",
          startedAt: "2026-01-01T00:00:01.100Z",
          completedAt: "2026-01-01T00:00:02.000Z"
        }
      });
      write({
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
          workspaceManifestHash: "d".repeat(64),
          outputManifestHash: "e".repeat(64),
          createdAt: "2026-01-01T00:00:01.000Z",
          completedAt: "2026-01-01T00:00:01.500Z"
        }
      });
      write({
        name: "trace.network.record",
        audit: {
          id: "network-1",
          projectId: "project-1",
          jobId: "job-1",
          attemptId: "attempt-1",
          url: "https://example.com/",
          redirectChain: [],
          sourcePolicy: { mode: "allowlist", urls: ["https://example.com/"] },
          policyDecision: "allowed",
          auditedAt: "2026-01-01T00:00:01.200Z"
        }
      });
      runtime.handle({
        name: "job.transitionTerminal",
        input: {
          fence: claimed.fence,
          status: "completed",
          projectRevision: storageTestProjectRevision(runtime, "project-1"),
          occurredAt: "2026-01-01T00:00:02.100Z",
          promotions: [
            {
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
            }
          ]
        }
      });
      expect(runtime.handle({ name: "trace.llm.listJob", jobId: "job-1" })).toEqual([expect.objectContaining({ id: "llm-1", model: "gpt-5.6-sol" })]);
      expect(runtime.handle({ name: "trace.decision.listJob", jobId: "job-1" })).toEqual([
        expect.objectContaining({ id: "decision-1", policyStatus: "accepted" })
      ]);
      expect(runtime.handle({ name: "trace.attempt.listJob", jobId: "job-1" })).toEqual([
        expect.objectContaining({
          id: "attempt-1",
          status: "completed",
          traceVersion: 1,
          traceAvailability: "vnext",
          descriptorVersion: "1",
          descriptorSideEffects: ["network"],
          idempotencyKey: "attempt-idempotency-key"
        })
      ]);
      expect(runtime.handle({ name: "trace.codex.listJob", jobId: "job-1" })).toEqual([
        expect.objectContaining({ id: "codex-1", networkPolicy: "disabled", eventCount: 4 })
      ]);
      expect(runtime.handle({ name: "trace.output.listAttempt", attemptId: "attempt-1" })).toEqual([expect.objectContaining({ id: "link-1", promoted: true })]);
      expect(runtime.handle({ name: "trace.output.listAttempts", attemptIds: ["missing", "attempt-1"], limit: 100 })).toEqual([
        expect.objectContaining({ id: "link-1", promoted: true })
      ]);
      expect(runtime.handle({ name: "trace.network.listJob", jobId: "job-1" })).toEqual([
        expect.objectContaining({ id: "network-1", policyDecision: "allowed" })
      ]);
    } finally {
      runtime.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects cross-job trace parents and permits only exact terminal-attempt retries", () => {
    const root = mkdtempSync(join(tmpdir(), "aetherops-trace-linkage-"));
    const databasePath = join(root, "storage.sqlite");
    migratedDatabase(databasePath).close();
    const runtime = createTraceWorkerRuntime(databasePath);
    const enqueueAndClaim = (jobId: string, projectId: string) => {
      upsertStorageTestProject(runtime, root, projectId, "2026-01-01T00:00:00.000Z");
      runtime.handle({
        name: "job.enqueue",
        job: { id: jobId, projectId, operation: "research_loop", expectedProjectRevision: 0, payload: { projectRevision: 1 } }
      });
      return runtime.handle({
        name: "job.claimAndStart",
        options: { projectId, leaseOwner: `worker-${jobId}`, leaseExpiresAt: "2026-01-01T01:00:00.000Z", now: "2026-01-01T00:00:00.000Z" }
      }) as import("./types.js").StorageClaimStartResult;
    };
    const jobA = enqueueAndClaim("job-a", "project-a");
    const jobB = enqueueAndClaim("job-b", "project-b");
    const write = (claimed: typeof jobA, commands: import("../worker/typedProtocol.js").StorageFencedWriteCommand[]) =>
      runtime.handle({ name: "fencedTransaction", fence: claimed.fence, now: "2026-01-01T00:00:01.000Z", commands });
    const decision = (claimed: typeof jobA, id: string, invocationId?: string) => ({
      name: "trace.decision.record" as const,
      decision: {
        id,
        projectId: claimed.job.projectId,
        jobId: claimed.job.id,
        invocationId,
        toolName: "DataAnalysisTool",
        purpose: "Validate trace linkage.",
        expectedOutcome: "A linked trace record.",
        rawSelection: {},
        userPinned: false,
        policyStatus: "accepted" as const,
        createdAt: "2026-01-01T00:00:00.500Z"
      }
    });
    const attemptB = terminalAttempt(jobB, "attempt-b", "decision-b");
    const attemptA = terminalAttempt(jobA, "attempt-a", "decision-a");

    try {
      write(jobB, [
        {
          name: "trace.llm.save",
          invocation: {
            id: "llm-b",
            projectId: jobB.job.projectId,
            jobId: jobB.job.id,
            model: "gpt-5.6-sol",
            reasoningEffort: "high",
            promptVersion: "planner-v2",
            schemaVersion: "2",
            promptHash: "b".repeat(64),
            repairCount: 0,
            status: "running",
            startedAt: "2026-01-01T00:00:00.000Z",
            data: { provider: "codex-oauth", schemaName: "CrossScopeHarness" }
          }
        },
        decision(jobB, "decision-b", "llm-b"),
        { name: "trace.attempt.save", attempt: attemptB },
        { name: "trace.codex.save", execution: { ...codexExecution(jobB, "attempt-b"), id: "codex-b" } }
      ]);
      write(jobA, [decision(jobA, "decision-a"), { name: "trace.attempt.save", attempt: attemptA }]);

      expect(() => write(jobA, [decision(jobA, "decision-cross", "llm-b")])).toThrow(/LLM invocation linkage/i);
      expect(() =>
        write(jobA, [
          {
            name: "trace.llm.save",
            invocation: {
              id: "llm-b",
              projectId: jobA.job.projectId,
              jobId: jobA.job.id,
              model: "gpt-5.6-sol",
              reasoningEffort: "high",
              promptVersion: "planner-v2",
              schemaVersion: "2",
              promptHash: "a".repeat(64),
              repairCount: 0,
              status: "completed",
              startedAt: "2026-01-01T00:00:00.000Z"
            }
          }
        ])
      ).toThrow(/identity.*leased job/i);
      expect(() => write(jobA, [decision(jobA, "decision-b")])).toThrow(/identity.*leased job/i);
      expect(() => write(jobA, [{ name: "trace.attempt.save", attempt: { ...attemptA, id: "attempt-cross", decisionId: "decision-b" } }])).toThrow(
        /tool decision linkage/i
      );
      expect(() => write(jobA, [{ name: "trace.codex.save", execution: codexExecution(jobA, "attempt-b") }])).toThrow(/tool attempt linkage/i);
      expect(() => write(jobA, [{ name: "trace.codex.save", execution: { ...codexExecution(jobA, "attempt-a"), id: "codex-b" } }])).toThrow(
        /identity.*leased job/i
      );
      expect(() => write(jobA, [{ name: "trace.output.record", link: outputLink(jobA, "attempt-b") }])).toThrow(/tool attempt linkage/i);
      expect(() => write(jobA, [{ name: "trace.network.record", audit: networkAudit(jobA, "attempt-b") }])).toThrow(/tool attempt linkage/i);

      expect(write(jobA, [{ name: "trace.attempt.save", attempt: attemptA }])).toEqual([
        expect.objectContaining({ ...attemptA, traceAvailability: "legacy_unavailable" })
      ]);
      expect(() => write(jobA, [{ name: "trace.attempt.save", attempt: { ...attemptA, outputHash: "f".repeat(64) } }])).toThrow(/retry must be identical/i);
    } finally {
      runtime.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});

function terminalAttempt(claimed: import("./types.js").StorageClaimStartResult, id: string, decisionId: string) {
  return {
    id,
    projectId: claimed.job.projectId,
    jobId: claimed.job.id,
    decisionId,
    ordinal: 0,
    status: "completed" as const,
    inputHash: "a".repeat(64),
    outputHash: "b".repeat(64),
    terminalCause: "completed",
    dependsOnAttemptIds: [],
    queuedAt: "2026-01-01T00:00:00.500Z",
    startedAt: "2026-01-01T00:00:00.600Z",
    completedAt: "2026-01-01T00:00:00.700Z"
  };
}

function codexExecution(claimed: import("./types.js").StorageClaimStartResult, attemptId: string) {
  return {
    id: "codex-cross",
    projectId: claimed.job.projectId,
    jobId: claimed.job.id,
    attemptId,
    model: "gpt-5.6-sol",
    reasoningEffort: "high",
    sandboxProfile: "workspace-v1",
    networkPolicy: "disabled" as const,
    eventCount: 0,
    createdAt: "2026-01-01T00:00:00.800Z"
  };
}

function outputLink(claimed: import("./types.js").StorageClaimStartResult, attemptId: string) {
  return {
    id: "output-cross",
    projectId: claimed.job.projectId,
    jobId: claimed.job.id,
    attemptId,
    outputKind: "artifact" as const,
    outputId: "artifact-cross",
    promoted: false,
    createdAt: "2026-01-01T00:00:00.800Z"
  };
}

function networkAudit(claimed: import("./types.js").StorageClaimStartResult, attemptId: string) {
  return {
    id: "network-cross",
    projectId: claimed.job.projectId,
    jobId: claimed.job.id,
    attemptId,
    url: "https://example.com/",
    redirectChain: [],
    sourcePolicy: { mode: "offline" },
    policyDecision: "allowed" as const,
    auditedAt: "2026-01-01T00:00:00.800Z"
  };
}

function createTraceWorkerRuntime(databasePath: string): StorageWorkerRuntime {
  return new StorageWorkerRuntime(
    { appDbPath: databasePath, vectorDbPath: databasePath, ontologyDbPath: databasePath },
    { leaseClock: () => TRACE_LEASE_NOW_MS }
  );
}

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

function createLegacyTraceV3Table(db: DatabaseSync): void {
  db.exec(`
    create table tool_attempts (
      id text primary key, project_id text not null, job_id text not null, decision_id text not null,
      checkpoint_id text, ordinal integer not null, status text not null, input_hash text not null,
      output_hash text, terminal_cause text, depends_on_attempt_ids text not null default '[]', staging_ref text,
      quarantine_ref text, error text, queued_at text not null, started_at text, completed_at text, data text
    );
  `);
}
