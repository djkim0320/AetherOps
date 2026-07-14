import { describe, expect, it } from "vitest";
import { storageCanonicalHasher } from "../runtime/storage/v2/runStatePayloadValidator.js";
import type { StorageLlmInvocation, StorageToolAttempt } from "../runtime/storage/v2/traceTypes.js";
import type { StorageCheckpoint } from "../runtime/storage/v2/types.js";
import { observeCanonicalBudget, type CanonicalBudgetTracePort } from "./canonicalBudgetAccounting.js";
import type { DurableJobRecord } from "./durableJobTypes.js";

describe("canonical budget accounting", () => {
  it("derives a deterministic cumulative target from active windows and durable receipts", async () => {
    const root = job("job-root", "interrupted", "2026-07-14T00:00:00.000Z", "2026-07-14T02:00:00.000Z", "2026-07-14T00:00:05.000Z");
    const resumed = job("job-resumed", "running", "2026-07-14T03:00:00.000Z");
    const port = tracePort({
      llm: new Map([
        ["job-root", [llm("llm-root", "job-root", 120, 30, 1, "2026-07-14T00:00:01.000Z", "2026-07-14T00:00:03.000Z")]],
        ["job-resumed", [llm("llm-resumed", "job-resumed", 40, 10, 0, "2026-07-14T03:00:01.000Z", "2026-07-14T03:00:02.000Z")]]
      ]),
      attempts: new Map([
        ["job-root", [attempt("tool-root-1", "job-root", "effect-a", 80), attempt("tool-root-2", "job-root", "effect-a", 100)]],
        ["job-resumed", [attempt("tool-resumed", "job-resumed", "effect-b", 60)]]
      ])
    });
    const input = {
      port,
      jobs: [root, resumed],
      projectId: "project-budget",
      runId: "run:job-root",
      activeJobId: "job-resumed",
      observedAt: "2026-07-14T03:00:05.000Z",
      hasher: storageCanonicalHasher
    };
    const first = await observeCanonicalBudget(input);
    const second = await observeCanonicalBudget(input);
    expect(first).toEqual(second);
    expect(first.target).toEqual({
      durationMs: 10_000,
      inputTokens: 160,
      outputTokens: 40,
      toolCalls: 3,
      retries: 2,
      estimatedCostMicrousd: 0,
      toolOutputBytes: 240
    });
    expect(first.receiptId).toContain("cost-unavailable-unmetered");
  });

  it("excludes interrupted lease-expiry downtime and uses the last durable activity boundary", async () => {
    const interrupted = job("job-root", "interrupted", "2026-07-14T00:00:00.000Z", "2026-07-14T12:00:00.000Z", "2026-07-14T00:00:04.000Z");
    const observed = await observeCanonicalBudget({
      port: tracePort({
        llm: new Map([["job-root", [llm("llm-root", "job-root", 1, 1, 0, "2026-07-14T00:00:01.000Z", "2026-07-14T00:00:04.000Z")]]])
      }),
      jobs: [interrupted],
      projectId: "project-budget",
      runId: "run:job-root",
      observedAt: "2026-07-15T00:00:00.000Z",
      hasher: storageCanonicalHasher
    });
    expect(observed.target.durationMs).toBe(4_000);
  });

  it("fails closed when a persisted LLM or tool output lacks accounting metadata", async () => {
    const root = job("job-root", "interrupted", "2026-07-14T00:00:00.000Z", "2026-07-14T00:00:02.000Z");
    const missingLlm = { ...llm("llm-root", "job-root", 1, 1, 0, root.startedAt!, root.finishedAt!), data: undefined };
    await expect(
      observeCanonicalBudget({
        port: tracePort({ llm: new Map([["job-root", [missingLlm]]]) }),
        jobs: [root],
        projectId: root.projectId,
        runId: "run:job-root",
        observedAt: root.updatedAt,
        hasher: storageCanonicalHasher
      })
    ).rejects.toThrow(/accounting receipt/);
    const missingTool = { ...attempt("attempt-root", "job-root", "effect", 10), data: undefined };
    await expect(
      observeCanonicalBudget({
        port: tracePort({ attempts: new Map([["job-root", [missingTool]]]) }),
        jobs: [root],
        projectId: root.projectId,
        runId: "run:job-root",
        observedAt: root.updatedAt,
        hasher: storageCanonicalHasher
      })
    ).rejects.toThrow(/output-byte accounting/);
  });
});

function job(id: string, status: DurableJobRecord["status"], startedAt: string, finishedAt?: string, leaseExpiresAt?: string): DurableJobRecord {
  return {
    id,
    projectId: "project-budget",
    kind: "research_loop",
    status,
    projectRevision: 0,
    idempotencyKey: id,
    createdAt: startedAt,
    updatedAt: finishedAt ?? startedAt,
    startedAt,
    ...(finishedAt ? { finishedAt } : {}),
    ...(leaseExpiresAt ? { leaseExpiresAt } : {})
  };
}

function llm(
  id: string,
  jobId: string,
  inputUnits: number,
  outputUnits: number,
  repairCount: number,
  startedAt: string,
  completedAt: string
): StorageLlmInvocation {
  return {
    id,
    projectId: "project-budget",
    jobId,
    model: "gpt-test",
    reasoningEffort: "high",
    promptVersion: "v1",
    schemaVersion: "v1",
    promptHash: "a".repeat(64),
    responseHash: "b".repeat(64),
    latencyMs: Date.parse(completedAt) - Date.parse(startedAt),
    repairCount,
    status: "completed",
    startedAt,
    completedAt,
    data: {
      accounting: {
        version: 1,
        inputUnits,
        outputUnits,
        unit: "estimated_token",
        estimator: "utf8_bytes_div_4_ceil_v1",
        monetaryCost: { availability: "unavailable", policy: "unmetered_codex_oauth_v1" }
      }
    }
  };
}

function attempt(id: string, jobId: string, idempotencyKey: string, canonicalResultBytes: number): StorageToolAttempt {
  return {
    id,
    projectId: "project-budget",
    jobId,
    decisionId: `decision-${id}`,
    ordinal: 1,
    status: "completed",
    inputHash: "c".repeat(64),
    outputHash: "d".repeat(64),
    idempotencyKey,
    dependsOnAttemptIds: [],
    queuedAt: "2026-07-14T00:00:01.000Z",
    startedAt: "2026-07-14T00:00:02.000Z",
    completedAt: "2026-07-14T00:00:03.000Z",
    data: { accounting: { version: 1, canonicalResultBytes, source: "canonical_result_utf8_v1" } }
  };
}

function tracePort(input: {
  llm?: Map<string, StorageLlmInvocation[]>;
  attempts?: Map<string, StorageToolAttempt[]>;
  checkpoints?: Map<string, StorageCheckpoint>;
}): CanonicalBudgetTracePort {
  return {
    listCanonicalLlmInvocations: async (jobId) => input.llm?.get(jobId) ?? [],
    listCanonicalToolAttempts: async (jobId) => input.attempts?.get(jobId) ?? [],
    latestCommittedCheckpoint: async (jobId) => input.checkpoints?.get(jobId)
  };
}
