import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { createStorageV2Repositories, type StorageV2RepositorySet } from "./repositories.js";
import { migrateStorageV2Schema } from "./schema.js";
import type { StorageCodexCliExecution, StorageToolAttempt, StorageToolOutputLink } from "./traceTypes.js";
import type { StorageCapabilityAudit } from "./types.js";

const CANARY = "SECRET_CANARY_DO_NOT_PERSIST";
const NOW = "2026-07-14T00:00:00.000Z";

describe("operational trace storage boundary", () => {
  it.each([
    {
      label: "tool decision",
      write: (repositories: StorageV2RepositorySet) =>
        repositories.trace.recordToolDecision({
          ...decision(),
          rawSelection: { inputHash: "a".repeat(64), rawProviderResponse: CANARY }
        }),
      table: "tool_decisions"
    },
    {
      label: "tool attempt",
      write: (repositories: StorageV2RepositorySet) => {
        repositories.trace.recordToolDecision(decision());
        return repositories.trace.saveToolAttempt({ ...attempt(), data: { phase: "analysis", rawOutput: CANARY } });
      },
      table: "tool_attempts"
    },
    {
      label: "Codex execution",
      write: (repositories: StorageV2RepositorySet) => {
        seedAttempt(repositories);
        return repositories.trace.saveCodexCliExecution({
          id: "codex-boundary",
          projectId: "project-boundary",
          jobId: "job-boundary",
          attemptId: "attempt-boundary",
          model: "gpt-5.6-sol",
          reasoningEffort: "high",
          sandboxProfile: "aetherops-workspace-v1",
          networkPolicy: "disabled",
          eventCount: 1,
          createdAt: NOW,
          data: { stdout: CANARY }
        });
      },
      table: "codex_cli_executions"
    },
    {
      label: "output link",
      write: (repositories: StorageV2RepositorySet) => {
        seedAttempt(repositories);
        return repositories.trace.recordOutputLink({
          id: "output-boundary",
          projectId: "project-boundary",
          jobId: "job-boundary",
          attemptId: "attempt-boundary",
          outputKind: "artifact",
          outputId: "artifact-boundary",
          promoted: false,
          createdAt: NOW,
          data: { rawOutput: CANARY }
        });
      },
      table: "tool_output_links"
    },
    {
      label: "network audit",
      write: (repositories: StorageV2RepositorySet) =>
        repositories.trace.recordNetworkAudit({
          id: "network-boundary",
          projectId: "project-boundary",
          jobId: "job-boundary",
          url: "https://example.com/?token=SECRET_CANARY_DO_NOT_PERSIST",
          redirectChain: [],
          sourcePolicy: { mode: "offline" },
          policyDecision: "denied",
          auditedAt: NOW
        }),
      table: "network_audits"
    }
  ])("rejects $label raw data without leaking it to errors or SQLite", ({ write, table }) => {
    const { db, repositories } = harness();
    let observed: unknown;
    try {
      write(repositories);
    } catch (error) {
      observed = error;
    }
    expect(observed).toBeInstanceOf(Error);
    expect(String(observed)).not.toContain(CANARY);
    expect(db.prepare(`select count(*) count from ${table}`).get()).toEqual({ count: 0 });
    expect(JSON.stringify(db.prepare(`select * from ${table}`).all())).not.toContain(CANARY);
    db.close();
  });

  it("rejects oversized otherwise-safe trace values before persistence", () => {
    const { db, repositories } = harness();
    expect(() => repositories.trace.recordToolDecision({ ...decision(), purpose: "x".repeat(1_001) })).toThrow(/invalid/i);
    expect(() =>
      repositories.trace.recordNetworkAudit({
        id: "network-oversized",
        projectId: "project-boundary",
        jobId: "job-boundary",
        url: "https://example.com/",
        redirectChain: Array.from({ length: 33 }, () => "https://example.com/"),
        sourcePolicy: { mode: "offline" },
        policyDecision: "allowed",
        auditedAt: NOW
      })
    ).toThrow(/hop bound/i);
    expect(db.prepare("select count(*) count from tool_decisions").get()).toEqual({ count: 0 });
    expect(db.prepare("select count(*) count from network_audits").get()).toEqual({ count: 0 });
    db.close();
  });

  it("enforces the queued-running-terminal vnext attempt lifecycle", () => {
    const direct = harness();
    direct.repositories.trace.recordToolDecision(decision());
    expect(() => direct.repositories.trace.saveToolAttempt(completedVnextAttempt())).toThrow(/must begin queued/i);
    expect(direct.db.prepare("select count(*) count from tool_attempts").get()).toEqual({ count: 0 });
    direct.db.close();

    const skipped = harness();
    skipped.repositories.trace.recordToolDecision(decision());
    const queued = queuedVnextAttempt();
    skipped.repositories.trace.saveToolAttempt(queued);
    expect(() => skipped.repositories.trace.saveToolAttempt(completedVnextAttempt())).toThrow(/queued tool attempt transition/i);
    expect(skipped.repositories.trace.getToolAttempt(queued.id)).toMatchObject(queued);
    skipped.db.close();

    const valid = harness();
    valid.repositories.trace.recordToolDecision(decision());
    valid.repositories.trace.saveToolAttempt(queued);
    valid.repositories.trace.saveToolAttempt(runningVnextAttempt());
    expect(valid.repositories.trace.saveToolAttempt(completedVnextAttempt())).toMatchObject({ status: "completed", outputHash: "b".repeat(64) });
    valid.db.close();
  });

  it.each([
    { label: "unsafe id", patch: { id: "Authorization: Bearer SECRET_CANARY" }, pattern: /sanitized/i },
    { label: "uppercase input hash", patch: { inputHash: "A".repeat(64) }, pattern: /lowercase SHA-256/i },
    { label: "duplicate dependency", patch: { dependsOnAttemptIds: ["attempt-parent", "attempt-parent"] }, pattern: /duplicate/i },
    { label: "unsafe staging reference", patch: { stagingRef: "../SECRET_CANARY" }, pattern: /safe workspace reference/i }
  ])("rejects vnext attempt $label before persistence", ({ patch, pattern }) => {
    const { db, repositories } = harness();
    repositories.trace.recordToolDecision(decision());
    expect(() => repositories.trace.saveToolAttempt({ ...queuedVnextAttempt(), ...patch } as StorageToolAttempt)).toThrow(pattern);
    expect(db.prepare("select count(*) count from tool_attempts").get()).toEqual({ count: 0 });
    expect(JSON.stringify(db.prepare("select * from tool_attempts").all())).not.toContain(CANARY);
    db.close();
  });

  it("keeps tool decisions and Codex execution receipts immutable", () => {
    const { db, repositories } = harness();
    const originalDecision = repositories.trace.recordToolDecision(decision());
    expect(() => repositories.trace.recordToolDecision({ ...decision(), rawSelection: { inputHash: "d".repeat(64) } })).toThrow(/immutable receipt/i);
    expect(repositories.trace.getToolDecision(originalDecision.id)).toEqual(originalDecision);

    repositories.trace.saveToolAttempt(attempt());
    const originalCodex = repositories.trace.saveCodexCliExecution(codexExecution());
    expect(() => repositories.trace.saveCodexCliExecution({ ...codexExecution(), eventCount: 2 })).toThrow(/immutable receipt/i);
    expect(repositories.trace.getCodexCliExecution(originalCodex.id)).toEqual(originalCodex);
    db.close();
  });

  it("rejects unsafe Codex, output, and compiled declaration fields without persistence", () => {
    const { db, repositories } = harness();
    repositories.trace.recordToolDecision(decision());
    repositories.trace.saveToolAttempt(attempt());
    expect(() => repositories.trace.saveCodexCliExecution({ ...codexExecution(), networkPolicy: "enabled" } as StorageCodexCliExecution)).toThrow(
      /network policy must be disabled/i
    );
    expect(() =>
      repositories.trace.recordOutputLink({
        id: "output-invalid-kind",
        projectId: "project-boundary",
        jobId: "job-boundary",
        attemptId: "attempt-boundary",
        outputKind: "raw" as StorageToolOutputLink["outputKind"],
        outputId: "artifact-boundary",
        promoted: false,
        createdAt: NOW
      })
    ).toThrow(/output kind is invalid/i);
    const unsafeDecision = {
      ...decision(),
      id: "decision-unsafe-output",
      toolName: "CodexCliTool",
      compiledAction: {
        toolName: "CodexCliTool",
        ordinal: 0,
        phase: "exclusive",
        inputHash: "a".repeat(64),
        outputDeclarations: [{ relativePath: "result.txt?token=SECRET_CANARY_DO_NOT_PERSIST", kind: "data" }]
      }
    };
    expect(() => repositories.trace.recordToolDecision(unsafeDecision)).toThrow(/output path is unsafe/i);
    expect(db.prepare("select count(*) count from codex_cli_executions").get()).toEqual({ count: 0 });
    expect(db.prepare("select count(*) count from tool_output_links").get()).toEqual({ count: 0 });
    expect(db.prepare("select count(*) count from tool_decisions").get()).toEqual({ count: 1 });
    expect(JSON.stringify(db.prepare("select * from tool_decisions").all())).not.toContain(CANARY);
    db.close();
  });
});

describe("capability audit storage boundary", () => {
  it("rejects a project-orphan standalone audit", () => {
    const db = migratedDatabase();
    expect(() => createStorageV2Repositories({ appDb: db }).capabilities.record(capabilityAudit())).toThrow(/project ownership is unavailable/i);
    expect(db.prepare("select count(*) count from capability_audits").get()).toEqual({ count: 0 });
    db.close();
  });

  it("rejects unsupported and oversized metadata without persisting a canary", () => {
    const db = migratedDatabase();
    seedProject(db);
    const capabilities = createStorageV2Repositories({ appDb: db }).capabilities;
    const unsafe = { ...capabilityAudit(), data: { jobKind: "research_loop", blockedBy: undefined, rawPrompt: CANARY } };
    let observed: unknown;
    try {
      capabilities.record(unsafe as unknown as StorageCapabilityAudit);
    } catch (error) {
      observed = error;
    }
    expect(observed).toBeInstanceOf(Error);
    expect(String(observed)).not.toContain(CANARY);
    expect(() => capabilities.record({ ...capabilityAudit(), reason: "x".repeat(1_001) })).toThrow(/bounded and sanitized/i);
    expect(db.prepare("select count(*) count from capability_audits").get()).toEqual({ count: 0 });
    expect(JSON.stringify(db.prepare("select * from capability_audits").all())).not.toContain(CANARY);
    db.close();
  });
});

function harness(): { db: DatabaseSync; repositories: StorageV2RepositorySet } {
  const db = migratedDatabase();
  const repositories = createStorageV2Repositories({ appDb: db });
  repositories.jobs.enqueue({ id: "job-boundary", projectId: "project-boundary", operation: "research_loop" });
  return { db, repositories };
}

function seedAttempt(repositories: StorageV2RepositorySet): void {
  repositories.trace.recordToolDecision(decision());
  repositories.trace.saveToolAttempt(attempt());
}

function decision() {
  return {
    id: "decision-boundary",
    projectId: "project-boundary",
    jobId: "job-boundary",
    toolName: "DataAnalysisTool",
    purpose: "Validate bounded durable trace storage.",
    expectedOutcome: "A hash-bound trace receipt.",
    rawSelection: { inputHash: "a".repeat(64) },
    userPinned: false,
    policyStatus: "accepted" as const,
    createdAt: NOW
  };
}

function attempt() {
  return {
    id: "attempt-boundary",
    projectId: "project-boundary",
    jobId: "job-boundary",
    decisionId: "decision-boundary",
    ordinal: 0,
    status: "completed" as const,
    inputHash: "a".repeat(64),
    outputHash: "b".repeat(64),
    dependsOnAttemptIds: [],
    queuedAt: NOW,
    completedAt: NOW,
    data: { phase: "analysis", accounting: { version: 1, canonicalResultBytes: 32, source: "canonical_result_utf8_v1" } }
  };
}

function queuedVnextAttempt(): StorageToolAttempt {
  return {
    id: "attempt-vnext",
    projectId: "project-boundary",
    jobId: "job-boundary",
    decisionId: "decision-boundary",
    ordinal: 0,
    status: "queued",
    inputHash: "a".repeat(64),
    traceVersion: 1,
    traceAvailability: "vnext",
    descriptorVersion: "1",
    descriptorSideEffects: [],
    idempotencyKey: "attempt-vnext-idempotency",
    dependsOnAttemptIds: [],
    queuedAt: NOW,
    data: { phase: "analysis" }
  };
}

function runningVnextAttempt(): StorageToolAttempt {
  return { ...queuedVnextAttempt(), status: "running", startedAt: NOW };
}

function completedVnextAttempt(): StorageToolAttempt {
  return { ...runningVnextAttempt(), status: "completed", outputHash: "b".repeat(64), completedAt: NOW };
}

function codexExecution(): StorageCodexCliExecution {
  return {
    id: "codex-boundary",
    projectId: "project-boundary",
    jobId: "job-boundary",
    attemptId: "attempt-boundary",
    model: "gpt-5.6-sol",
    reasoningEffort: "high",
    sandboxProfile: "aetherops-workspace-v1",
    networkPolicy: "disabled",
    eventCount: 1,
    createdAt: NOW
  };
}

function capabilityAudit(): StorageCapabilityAudit {
  return {
    id: "capability-boundary",
    projectId: "project-boundary",
    operation: "agent",
    capability: "agent",
    appAllowed: true,
    projectAllowed: true,
    operationAllowed: true,
    allowed: true,
    data: { jobKind: "research_loop" },
    auditedAt: NOW
  };
}

function seedProject(db: DatabaseSync): void {
  db.prepare(
    `insert into projects_v2
    (id,short_id,project_root,topic,status,created_at,updated_at,data)
    values (?,?,?,?,?,?,?,?)`
  ).run("project-boundary", "project-bound", "project-boundary", "Boundary", "active", NOW, NOW, "{}");
}

function migratedDatabase(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  migrateStorageV2Schema(db);
  return db;
}
