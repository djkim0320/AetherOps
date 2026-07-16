import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { ResearchLoopStep, type AppSettings, type ResearchToolInput } from "../../core/shared/types.js";
import type { ResearchTool, ToolExecutionContext } from "../../core/tools/researchToolTypes.js";
import { ToolRunner } from "../../core/tools/toolRunner.js";
import { FileToolExecutionWorkspace } from "../runtime/tools/toolExecutionWorkspace.js";
import { migrateStorageV2Schema } from "../runtime/storage/v2/schema.js";
import type { StorageToolAttempt, StorageToolDecision, StorageToolOutputLink } from "../runtime/storage/v2/traceTypes.js";
import { DurableJobRuntime } from "./durableJobRuntime.js";
import { DurableJobRuntimeTestSupport } from "./durableJobRuntimeTestSupport.js";
import { DurableToolExecutionAdapter } from "./durableToolExecutionAdapter.js";

let root: string | undefined;
let runtime: DurableJobRuntime | undefined;
const support = new DurableJobRuntimeTestSupport(
  () => runtime,
  () => root
);

afterEach(async () => {
  await runtime?.close().catch(() => undefined);
  runtime = undefined;
  if (root) rmSync(root, { recursive: true, force: true });
  root = undefined;
});

describe("durable external side-effect execution", () => {
  it("does not invoke a non-repeatable tool twice after its first response is lost", async () => {
    const databasePath = createDatabase();
    runtime = new DurableJobRuntime(databasePath, { concurrency: 1, dataRoot: root });
    let externalExecutions = 0;
    const tool = countingEngineeringTool(() => {
      externalExecutions += 1;
    });
    runtime.registerHandler("engineering_run", async (job, _request, context) => {
      const durableRuntime = runtime as DurableJobRuntime;
      const traceRuntime = job.idempotencyKey === "response-loss-1" ? responseLossRuntime(durableRuntime) : durableRuntime;
      const trace = new DurableToolExecutionAdapter(job, traceRuntime);
      const runner = new ToolRunner([tool], new FileToolExecutionWorkspace(root as string));
      await runner.execute(engineeringInput(job.projectId), SETTINGS, {
        execution: executionContext(job.id, job.idempotencyKey, context.signal, trace.onStatus)
      });
      await durableRuntime.finish(job.id, await support.currentRevision(job.projectId), trace.completedOutputPromotions());
    });
    await runtime.initialize();

    const first = await support.enqueueCurrent({
      projectId: "project-side-effect-integration",
      kind: "engineering_run",
      idempotencyKey: "response-loss-1",
      requestHash: "request-response-loss-1",
      payload: {}
    });
    await waitForStatus(first.jobId, "failed");
    const second = await support.enqueueCurrent({
      projectId: "project-side-effect-integration",
      kind: "engineering_run",
      idempotencyKey: "response-loss-2",
      requestHash: "request-response-loss-2",
      payload: {}
    });
    await waitForStatus(second.jobId, "failed");

    expect(externalExecutions).toBe(1);
    const firstDetail = await runtime.getDetail(first.jobId);
    const secondDetail = await runtime.getDetail(second.jobId);
    expect(firstDetail?.trace.toolAttempts).toEqual([
      expect.objectContaining({ status: "completed", postconditionReceipt: undefined, sideEffectKey: expect.any(String) })
    ]);
    expect(secondDetail?.trace.toolAttempts).toEqual([
      expect.objectContaining({ status: "interrupted", terminalCause: "job_failed", sideEffectKey: firstDetail?.trace.toolAttempts[0]?.sideEffectKey })
    ]);
    expect(secondDetail?.trace.toolAttempts.some((attempt) => attempt.status === "queued" || attempt.status === "running")).toBe(false);
  });
});

function responseLossRuntime(value: DurableJobRuntime): DurableJobRuntime {
  return {
    recordToolDecision: (decision: StorageToolDecision) => value.recordToolDecision(decision),
    recordToolAttemptAndEvent: (input: { attempt: StorageToolAttempt; projectRevision: number; toolName: string }) => value.recordToolAttemptAndEvent(input),
    recordToolOutput: (output: StorageToolOutputLink) => value.recordToolOutput(output),
    verifyToolPostcondition: async () => {
      throw new Error("Injected response loss after external execution.");
    }
  } as DurableJobRuntime;
}

function countingEngineeringTool(onRun: () => void): ResearchTool {
  return {
    name: "EngineeringProgramTool",
    run: async (input) => {
      onRun();
      const now = new Date().toISOString();
      return {
        toolRun: {
          id: `tool-run-${input.project.id}`,
          projectId: input.project.id,
          iteration: input.iteration,
          toolName: "EngineeringProgramTool",
          input: { case: "NACA0012" },
          output: { solverStatus: "completed" },
          status: "completed",
          startedAt: now,
          completedAt: now
        },
        sources: [],
        evidence: [],
        artifacts: []
      };
    }
  };
}

function executionContext(
  jobId: string,
  idempotencyKey: string,
  signal: AbortSignal,
  onStatus: NonNullable<ToolExecutionContext["onStatus"]>
): ToolExecutionContext {
  return {
    jobId,
    executionId: `side-effect-execution-${jobId}`,
    idempotencyKey,
    effectiveCapabilities: { agent: true, engineering: true, search: false },
    toolPolicy: { allowCodexCli: false, sourceAccess: { mode: "offline" } },
    signal,
    onStatus
  };
}

function engineeringInput(projectId: string): ResearchToolInput {
  const createdAt = "2026-07-15T00:00:00.000Z";
  const inputs = {
    programRequests: [{ kind: "xfoil-wasm-polar", target: "xfoil-wasm", naca: "0012", reynolds: 500_000, mach: 0.05 }]
  };
  return {
    project: {
      id: projectId,
      goal: "Verify response-loss deduplication.",
      topic: "NACA 0012 deterministic polar",
      scope: "One local solver case",
      budget: "One minute",
      autonomyPolicy: { toolApproval: "suggested", allowExternalSearch: false, allowCodeExecution: true },
      createdAt,
      updatedAt: createdAt,
      currentStep: ResearchLoopStep.ExecuteTools,
      status: "running",
      projectRoot: ".aetherops/test-side-effect"
    },
    questions: [],
    hypotheses: [],
    evidence: [],
    sources: [],
    artifacts: [],
    iteration: 1,
    researchPlan: {
      id: "side-effect-plan",
      projectId,
      iteration: 1,
      objective: "Run one deterministic engineering action.",
      targetQuestions: [],
      targetHypotheses: [],
      requiredTools: ["EngineeringProgramTool"],
      toolRequests: [
        {
          intentId: "same-engineering-action",
          toolName: "EngineeringProgramTool",
          purpose: "Run the selected local solver once.",
          expectedOutcome: "One terminal solver receipt.",
          inputs
        }
      ],
      expectedSources: [],
      expectedArtifacts: [],
      executionSteps: ["Execute the solver."],
      stopCriteria: ["The solver action is terminal."],
      createdAt
    }
  };
}

const SETTINGS: AppSettings = {
  codex: { model: "gpt-5.6", reasoningEffort: "xhigh", timeoutMs: 180_000, taskTimeoutMs: 600_000 },
  webSearch: { provider: "disabled" },
  embedding: { provider: "local", model: "none", dimensions: 0 },
  browserUse: { enabled: false, mode: "background", maxPages: 1, timeoutMs: 1_000, captureScreenshots: false },
  researchMetadata: { enabled: false, provider: "openalex", maxResults: 1, timeoutMs: 1_000 },
  engineeringTools: {
    enabled: true,
    xfoil: { enabled: false, command: "", timeoutMs: 1_000 },
    modeling: { enabled: false, artifactRoot: "", maxMeshBytes: 1_024 },
    su2: { enabled: false, command: "", caseRoot: "", configFile: "", workingDirectory: "", probeArgs: [], runArgsTemplate: [], timeoutMs: 1_000 },
    openVsp: { enabled: false, command: "", scriptPath: "", workingDirectory: "", probeArgs: [], runArgsTemplate: [], timeoutMs: 1_000 },
    xflr5: { enabled: false, command: "", scriptPath: "", workingDirectory: "", probeArgs: [], runArgsTemplate: [], timeoutMs: 1_000 }
  },
  allowAgent: true,
  allowExternalSearch: false,
  allowCodeExecution: true,
  updatedAt: "2026-07-15T00:00:00.000Z"
};

function createDatabase(): string {
  root = mkdtempSync(join(tmpdir(), "aetherops-side-effect-integration-"));
  const path = join(root, "storage.sqlite");
  const db = new DatabaseSync(path);
  migrateStorageV2Schema(db);
  db.close();
  return path;
}

async function waitForStatus(jobId: string, status: string): Promise<void> {
  for (let index = 0; index < 100; index += 1) {
    if ((await runtime?.get(jobId))?.status === status) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Durable job did not reach ${status}.`);
}
