import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import type { AetherOpsOrchestrator } from "../../src/core/orchestration/orchestrator.js";
import type { ToolExecutionContext } from "../../src/core/tools/researchToolTypes.js";
import { createInputProject, createStrictTestOrchestrator } from "../../src/core/testing/orchestratorTestHarness.js";
import { CANONICAL_BUDGET_DECISION_PREFIX } from "../../src/core/orchestration/budgetAccounting.js";
import { CanonicalRunRuntime } from "../../src/server/composition/canonicalRunRuntime.js";
import { canonicalResearchStartPayload } from "../../src/server/composition/canonicalResearchEnqueue.js";
import { DurableCanonicalRunGateway } from "../../src/server/composition/durableCanonicalRunGateway.js";
import { DurableJobRuntime } from "../../src/server/composition/durableJobRuntime.js";
import { durableJobRequestHash } from "../../src/server/composition/durableJobRequestHash.js";
import { registerDurableResearchLoopHandler } from "../../src/server/composition/registerDurableResearchLoopHandler.js";
import { migrateStorageV2Schema } from "../../src/server/runtime/storage/v2/schema.js";
import { parseStoredRunStateRevision } from "../../src/server/runtime/storage/v2/runStatePayloadValidator.js";

let root: string | undefined;
let runtime: DurableJobRuntime | undefined;

afterEach(async () => {
  await runtime?.close().catch(() => undefined);
  runtime = undefined;
  if (root) rmSync(root, { recursive: true, force: true });
  root = undefined;
});

describe("canonical budget failure settlement", () => {
  it("atomically accounts a persisted failed LLM invocation before blocking canonical state", async () => {
    const databasePath = createDatabase();
    const source = createStrictTestOrchestrator();
    const snapshot = await createInputProject(source, {
      goal: "Verify failed invocation accounting.",
      topic: "Atomic terminal budget settlement",
      scope: "Local deterministic integration test",
      budget: "bounded",
      autonomyPolicy: { toolApproval: "suggested", allowExternalSearch: false, allowCodeExecution: false }
    });
    persistProject(databasePath, snapshot.project);
    const failingOrchestrator = {
      getSnapshot: async () => structuredClone(snapshot),
      startLoop: async (_projectId: string, execution: ToolExecutionContext) => {
        const startedAt = new Date().toISOString();
        const invocationId = "llm-failure-accounting";
        await execution.onLlmInvocationRunning?.({
          invocationId,
          provider: "codex-oauth",
          model: "gpt-5.6-sol",
          reasoningEffort: "high",
          schemaName: "AetherOpsResearchPlan",
          promptVersion: "failure-accounting-v1",
          schemaVersion: "failure-accounting-v1",
          promptHash: "a".repeat(64),
          startedAt,
          status: "running"
        });
        await execution.onLlmInvocation?.({
          invocationId,
          provider: "codex-oauth",
          model: "gpt-5.6-sol",
          reasoningEffort: "high",
          schemaName: "AetherOpsResearchPlan",
          promptVersion: "failure-accounting-v1",
          schemaVersion: "failure-accounting-v1",
          promptHash: "a".repeat(64),
          startedAt,
          completedAt: startedAt,
          durationMs: 0,
          repairCount: 1,
          status: "failed",
          validationErrors: ["schema rejected"],
          inputTokenEstimate: 123,
          outputTokenEstimate: 7,
          tokenEstimator: "utf8_bytes_div_4_ceil_v1",
          monetaryCostAvailability: "unavailable"
        });
        throw new Error("planner failed after its durable invocation trace");
      }
    } as unknown as AetherOpsOrchestrator;
    runtime = new DurableJobRuntime(databasePath, { concurrency: 1, dataRoot: root });
    const hasher = { sha256Canonical: durableJobRequestHash };
    const canonicalRuntime = new CanonicalRunRuntime({ gateway: new DurableCanonicalRunGateway(runtime), hasher });
    registerDurableResearchLoopHandler(
      { orchestrator: failingOrchestrator, settingsStore: {} as never, jobs: runtime, events: runtime },
      canonicalRuntime,
      hasher,
      () => async () => ({ agent: true, engineering: false, search: false })
    );
    await runtime.initialize();
    const jobId = "job-failure-accounting";
    const capabilities = { agent: true, engineering: false, search: false };
    const toolPolicy = { allowCodexCli: false, sourceAccess: { mode: "offline" as const } };
    const receipt = await runtime.enqueue({
      jobId,
      projectId: snapshot.project.id,
      kind: "research_loop",
      projectRevision: 1,
      idempotencyKey: "failure-accounting-job",
      requestedCapabilities: capabilities,
      effectiveCapabilities: capabilities,
      capabilityAudits: capabilityAudits(snapshot.project.id, jobId, capabilities),
      toolPolicy,
      payload: canonicalResearchStartPayload({
        snapshot,
        payload: { action: "start" },
        requestedCapabilities: capabilities,
        effectiveCapabilities: capabilities,
        toolPolicy
      })
    });
    const failed = await waitForStatus(receipt.jobId, "failed");
    const owner = { projectId: snapshot.project.id, runId: `run:${receipt.jobId}`, jobId: receipt.jobId };
    const stored = await runtime.latestCanonicalRunState(owner);
    expect(stored).toBeDefined();
    const state = parseStoredRunStateRevision(stored?.data);

    expect(failed.failureReason).toBeTruthy();
    expect(state.status).toBe("blocked");
    expect(state.budgetUsage).toMatchObject({ inputTokens: 123, outputTokens: 7, retries: 1 });
    expect(state.decisions.some((item) => item.decisionId.startsWith(CANONICAL_BUDGET_DECISION_PREFIX))).toBe(true);
    expect(state.blockedReasons).toEqual([expect.objectContaining({ code: "RECOVERABLE_JOB_FAILURE", sourceReceiptId: receipt.jobId })]);
    const detail = await runtime.getDetail(receipt.jobId);
    expect(detail?.trace.llmInvocations).toEqual([expect.objectContaining({ status: "failed", repairCount: 1, promptHash: "a".repeat(64) })]);
  });
});

function capabilityAudits(projectId: string, jobId: string, capabilities: { agent: boolean; engineering: boolean; search: boolean }) {
  return (["agent", "engineering", "search"] as const).map((capability) => ({
    id: `capability-${jobId}-${capability}`,
    projectId,
    jobId,
    operation: capability,
    capability,
    appAllowed: true,
    projectAllowed: true,
    operationAllowed: capabilities[capability],
    allowed: capabilities[capability],
    data: {
      jobKind: "research_loop" as const,
      ...(capabilities[capability] ? {} : { blockedBy: "job" as const })
    },
    auditedAt: "2026-07-14T00:00:00.000Z"
  }));
}

function createDatabase(): string {
  root = mkdtempSync(join(tmpdir(), "aetherops-budget-failure-"));
  const databasePath = join(root, "storage.sqlite");
  const database = new DatabaseSync(databasePath);
  migrateStorageV2Schema(database, { requireFts5: true });
  database.close();
  return databasePath;
}

function persistProject(databasePath: string, project: { id: string; topic: string; status: string; createdAt: string; updatedAt: string }): void {
  const database = new DatabaseSync(databasePath);
  const projectRoot = join(root as string, "projects", project.id);
  database
    .prepare(
      `insert into projects_v2 (id,short_id,project_root,topic,status,current_step,created_at,updated_at,data)
       values (?,?,?,?,?,?,?,?,?)`
    )
    .run(
      project.id,
      `budget-${project.id.slice(-12)}`,
      projectRoot,
      project.topic,
      project.status,
      null,
      project.createdAt,
      project.updatedAt,
      JSON.stringify({ ...project, projectRoot })
    );
  database.close();
}

async function waitForStatus(jobId: string, expected: "failed") {
  for (let index = 0; index < 150; index += 1) {
    const job = await runtime?.get(jobId);
    if (job?.status === expected) return job;
    if (job && ["blocked", "completed", "aborted", "interrupted"].includes(job.status)) {
      throw new Error(`Job settled as ${job.status}, expected ${expected}.`);
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  const observed = await runtime?.get(jobId);
  throw new Error(`Job ${jobId} did not settle as ${expected}; observed ${observed?.status ?? "missing"}.`);
}
