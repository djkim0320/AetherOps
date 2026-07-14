import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createStorageV2Repositories } from "./repositories.js";
import { migrateStorageV2Schema } from "./schema.js";
import type { StorageLlmInvocation } from "./traceTypes.js";

describe("durable LLM invocation receipts", () => {
  it.each(["completed", "failed"] as const)("rejects a direct %s insert without a running receipt", (status) => {
    const db = migratedDatabase();
    const trace = ownedTrace(db);
    const terminal = { ...completedReceipt(runningReceipt()), status, ...(status === "failed" ? { error: "provider failed" } : {}) };

    expect(() => trace.saveLlmInvocation(terminal)).toThrow(/must begin with a running receipt/i);
    expect(trace.getLlmInvocation(terminal.id)).toBeUndefined();
    db.close();
  });

  it("rejects orphan and cross-project invocation ownership", () => {
    const orphanDb = migratedDatabase();
    expect(() => createStorageV2Repositories({ appDb: orphanDb }).trace.saveLlmInvocation(runningReceipt())).toThrow(/job ownership is unavailable/i);
    orphanDb.close();

    const crossProjectDb = migratedDatabase();
    const trace = ownedTrace(crossProjectDb, "project-other");
    expect(() => trace.saveLlmInvocation(runningReceipt())).toThrow(/job ownership is unavailable or inconsistent/i);
    crossProjectDb.close();
  });

  it.each([
    { label: "extra raw prompt field", data: { provider: "codex-oauth", schemaName: "AetherOpsResearchPlan", rawPrompt: "SECRET_CANARY" } },
    { label: "secret in an allowed field", data: { provider: "Authorization: Bearer SECRET_CANARY", schemaName: "AetherOpsResearchPlan" } }
  ])("rejects $label without persisting its canary", ({ data }) => {
    const db = migratedDatabase();
    const trace = ownedTrace(db);
    let observed: unknown;
    try {
      trace.saveLlmInvocation({ ...runningReceipt(), data: data as unknown as StorageLlmInvocation["data"] });
    } catch (error) {
      observed = error;
    }

    expect(observed).toBeInstanceOf(Error);
    expect(String(observed)).not.toContain("SECRET_CANARY");
    expect(db.prepare("select count(*) as count from llm_invocations").get()).toEqual({ count: 0 });
    expect(JSON.stringify(db.prepare("select * from llm_invocations").all())).not.toContain("SECRET_CANARY");
    db.close();
  });

  it("rejects incomplete or unsafe terminal receipts and retains running state", () => {
    const db = migratedDatabase();
    const trace = ownedTrace(db);
    const running = runningReceipt();
    trace.saveLlmInvocation(running);

    const completedWithoutHash = completedReceipt(running);
    delete completedWithoutHash.responseHash;
    expect(() => trace.saveLlmInvocation(completedWithoutHash)).toThrow(/requires a lowercase SHA-256 response hash/i);
    expect(() => trace.saveLlmInvocation(failedReceipt(running, undefined))).toThrow(/requires a bounded sanitized error reason/i);
    expect(() => trace.saveLlmInvocation(failedReceipt(running, "Authorization: Bearer raw-provider-secret"))).toThrow(/not bounded and sanitized/i);
    expect(trace.getLlmInvocation(running.id)).toMatchObject(running);
    db.close();
  });

  it("rejects malformed immutable prompt and optional response hashes", () => {
    const db = migratedDatabase();
    const trace = ownedTrace(db);
    expect(() => trace.saveLlmInvocation({ ...runningReceipt(), promptHash: "not-a-hash" })).toThrow(/prompt hash.*lowercase SHA-256/i);

    const running = runningReceipt();
    trace.saveLlmInvocation(running);
    expect(() => trace.saveLlmInvocation(failedReceipt(running, "provider_invocation_failed", "not-a-hash"))).toThrow(/response hash.*lowercase SHA-256/i);
    db.close();
  });

  it.each([
    { label: "uppercase prompt hash", patch: { promptHash: "A".repeat(64) }, pattern: /lowercase SHA-256/i },
    { label: "unsafe identifier", patch: { id: "Authorization: Bearer SECRET_CANARY" }, pattern: /sanitized/i },
    { label: "oversized identifier", patch: { id: "x".repeat(257) }, pattern: /invalid/i },
    { label: "oversized model", patch: { model: "x".repeat(129) }, pattern: /invalid/i },
    { label: "negative repair count", patch: { repairCount: -1 }, pattern: /repair count/i },
    { label: "excessive repair count", patch: { repairCount: 2 }, pattern: /repair count/i },
    { label: "invalid timestamp", patch: { startedAt: "not-a-timestamp" }, pattern: /ISO timestamp/i }
  ])("rejects $label before inserting an LLM receipt", ({ patch, pattern }) => {
    const db = migratedDatabase();
    const trace = ownedTrace(db);
    expect(() => trace.saveLlmInvocation({ ...runningReceipt(), ...patch } as StorageLlmInvocation)).toThrow(pattern);
    expect(db.prepare("select count(*) as count from llm_invocations").get()).toEqual({ count: 0 });
    db.close();
  });

  it.each([
    { label: "uppercase response hash", patch: { responseHash: "B".repeat(64) }, pattern: /lowercase SHA-256/i },
    { label: "completion before start", patch: { completedAt: "2026-07-13T23:59:59.999Z" }, pattern: /precedes its start/i },
    { label: "completed error", patch: { error: "unexpected_failure" }, pattern: /cannot contain an error/i }
  ])("rejects terminal $label and leaves the running receipt intact", ({ patch, pattern }) => {
    const db = migratedDatabase();
    const trace = ownedTrace(db);
    const running = runningReceipt();
    trace.saveLlmInvocation(running);
    expect(() => trace.saveLlmInvocation({ ...completedReceipt(running), ...patch })).toThrow(pattern);
    expect(trace.getLlmInvocation(running.id)).toMatchObject(running);
    db.close();
  });

  it("rejects a terminal error canary without leaking or persisting it", () => {
    const db = migratedDatabase();
    const trace = ownedTrace(db);
    const running = runningReceipt();
    trace.saveLlmInvocation(running);
    let observed: unknown;
    try {
      trace.saveLlmInvocation(failedReceipt(running, "Authorization: Bearer SECRET_CANARY"));
    } catch (error) {
      observed = error;
    }
    expect(observed).toBeInstanceOf(Error);
    expect(String(observed)).not.toContain("SECRET_CANARY");
    expect(trace.getLlmInvocation(running.id)).toMatchObject(running);
    expect(JSON.stringify(db.prepare("select * from llm_invocations").all())).not.toContain("SECRET_CANARY");
    db.close();
  });

  it("updates one running row to a terminal receipt with immutable identity", () => {
    const db = migratedDatabase();
    const trace = ownedTrace(db);
    const running = runningReceipt();
    expect(trace.saveLlmInvocation(running)).toMatchObject(running);
    expect(trace.saveLlmInvocation(running)).toMatchObject(running);

    const completed = completedReceipt(running);
    expect(trace.saveLlmInvocation(completed)).toMatchObject(completed);
    expect(trace.listLlmInvocations(running.jobId)).toEqual([expect.objectContaining(completed)]);
    db.close();
  });

  it("commits a repaired completion with bounded validation history but no execution error", () => {
    const db = migratedDatabase();
    const trace = ownedTrace(db);
    const running = runningReceipt();
    trace.saveLlmInvocation(running);
    const repaired = {
      ...completedReceipt(running),
      repairCount: 1,
      data: {
        ...completedReceipt(running).data,
        validationErrors: ["response:invalid_json"]
      }
    };

    expect(trace.saveLlmInvocation(repaired)).toMatchObject({
      status: "completed",
      repairCount: 1,
      error: undefined,
      data: { validationErrors: ["response:invalid_json"] }
    });
    db.close();
  });

  it("accepts a safe running to failed lifecycle", () => {
    const db = migratedDatabase();
    const trace = ownedTrace(db);
    const running = runningReceipt();
    trace.saveLlmInvocation(running);

    const failed = failedReceipt(running, "provider_invocation_failed");
    expect(trace.saveLlmInvocation(failed)).toMatchObject(failed);
    db.close();
  });

  it("rejects identity mutation, regression, and terminal mutation", () => {
    const db = migratedDatabase();
    const trace = ownedTrace(db);
    const running = runningReceipt();
    trace.saveLlmInvocation(running);
    expect(() => trace.saveLlmInvocation({ ...running, promptHash: "d".repeat(64) })).toThrow(/identity conflict/i);

    const completed = completedReceipt(running);
    trace.saveLlmInvocation(completed);
    expect(() => trace.saveLlmInvocation(running)).toThrow(/terminal.*immutable/i);
    expect(() => trace.saveLlmInvocation({ ...completed, responseHash: "e".repeat(64) })).toThrow(/terminal.*immutable/i);
    db.close();
  });

  it("leaves the running ambiguity durable when a terminal update is rejected", () => {
    const root = mkdtempSync(join(tmpdir(), "aetherops-llm-receipt-"));
    const databasePath = join(root, "operational.sqlite");
    try {
      const db = migratedDatabase(databasePath);
      const trace = ownedTrace(db);
      const running = runningReceipt();
      trace.saveLlmInvocation(running);
      expect(() => trace.saveLlmInvocation({ ...completedReceipt(running), startedAt: "2026-07-14T00:00:00.001Z" })).toThrow(/identity conflict/i);
      db.close();

      const reopened = new DatabaseSync(databasePath);
      expect(createStorageV2Repositories({ appDb: reopened }).trace.getLlmInvocation(running.id)).toMatchObject(running);
      reopened.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

function migratedDatabase(path = ":memory:"): DatabaseSync {
  const db = new DatabaseSync(path);
  migrateStorageV2Schema(db);
  return db;
}

function ownedTrace(db: DatabaseSync, projectId = "project-receipt") {
  const repositories = createStorageV2Repositories({ appDb: db });
  repositories.jobs.enqueue({ id: "job-receipt", projectId, operation: "research_loop" });
  return repositories.trace;
}

function runningReceipt(): StorageLlmInvocation {
  return {
    id: "llm-receipt",
    projectId: "project-receipt",
    jobId: "job-receipt",
    model: "gpt-5.6-sol",
    reasoningEffort: "high",
    promptVersion: "planner-v1",
    schemaVersion: "schema-v1",
    promptHash: "a".repeat(64),
    repairCount: 0,
    status: "running",
    startedAt: "2026-07-14T00:00:00.000Z",
    data: { provider: "codex-oauth", schemaName: "AetherOpsResearchPlan" }
  };
}

function completedReceipt(running: StorageLlmInvocation): StorageLlmInvocation {
  return {
    ...running,
    responseHash: "b".repeat(64),
    latencyMs: 1_000,
    status: "completed",
    completedAt: "2026-07-14T00:00:01.000Z",
    data: {
      provider: "codex-oauth",
      schemaName: "AetherOpsResearchPlan",
      accounting: {
        version: 1,
        inputUnits: 10,
        outputUnits: 2,
        unit: "estimated_token",
        estimator: "utf8_bytes_div_4_ceil_v1",
        monetaryCost: { availability: "unavailable", policy: "unmetered_codex_oauth_v1" }
      }
    }
  };
}

function failedReceipt(running: StorageLlmInvocation, error: string | undefined, responseHash?: string): StorageLlmInvocation {
  return {
    ...running,
    latencyMs: 1_000,
    status: "failed",
    ...(error ? { error } : {}),
    ...(responseHash ? { responseHash } : {}),
    completedAt: "2026-07-14T00:00:01.000Z",
    data: completedReceipt(running).data
  };
}
