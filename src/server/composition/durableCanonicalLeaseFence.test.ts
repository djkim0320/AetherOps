import { describe, expect, it } from "vitest";
import type { RunStateRevision } from "../../core/orchestration/runStateCapsule.js";
import type { StorageWorkerClient } from "../runtime/storage/worker/typedRuntime.js";
import type { CanonicalRevisionPlan } from "./canonicalRunTypes.js";
import { commitDurableCanonicalCheckpoint } from "./durableCanonicalCheckpointCommit.js";
import { commitDurableCanonicalRevisionPlan } from "./durableCanonicalRevisionCommit.js";
import { transitionDurableCanonicalTerminal } from "./durableCanonicalTerminalTransition.js";
import { DurableJobExecutionContext, type DurableJobExecutionScope } from "./durableJobExecutionContext.js";

const JOB_ID = "job-canonical-lease";
const PROJECT_ID = "project-canonical-lease";
const OWNER = { projectId: PROJECT_ID, runId: "run-canonical-lease", jobId: JOB_ID };
const RECORDED_AT = "2026-07-14T00:00:00.000Z";

describe("canonical composition lease checks", () => {
  it("does not begin checkpoint planning after the local execution scope has lost its lease", async () => {
    const execution = new DurableJobExecutionContext();
    const scope = executionScope();
    scope.leaseLost = true;
    const client = new NeverCalledStorageClient();
    let prepareCount = 0;

    await expect(
      execution.run(scope, () =>
        commitDurableCanonicalCheckpoint(
          client.value,
          () => execution.require(JOB_ID),
          {
            owner: OWNER,
            step: "EXECUTE_TOOLS",
            projectRevision: 1,
            prepareRevision: async () => {
              prepareCount += 1;
              return revisionPlan();
            }
          },
          RECORDED_AT,
          { step: "EXECUTE_TOOLS" }
        )
      )
    ).rejects.toMatchObject({ name: "LeaseLostError" });
    expect(prepareCount).toBe(0);
    expect(client.requestCount).toBe(0);
  });

  it("rechecks the local lease after asynchronous checkpoint planning", async () => {
    const execution = new DurableJobExecutionContext();
    const scope = executionScope();
    const client = new NeverCalledStorageClient();

    await expect(
      execution.run(scope, () =>
        commitDurableCanonicalCheckpoint(
          client.value,
          () => execution.require(JOB_ID),
          {
            owner: OWNER,
            step: "EXECUTE_TOOLS",
            projectRevision: 1,
            prepareRevision: async () => {
              execution.markLeaseLost(JOB_ID, new Error("renewal failed"));
              return revisionPlan();
            }
          },
          RECORDED_AT,
          { step: "EXECUTE_TOOLS" }
        )
      )
    ).rejects.toMatchObject({ name: "LeaseLostError" });
    expect(client.requestCount).toBe(0);
  });

  it("rechecks the local lease after asynchronous revision planning", async () => {
    const execution = new DurableJobExecutionContext();
    const scope = executionScope();
    const client = new NeverCalledStorageClient();

    await expect(
      execution.run(scope, () =>
        commitDurableCanonicalRevisionPlan(
          client.value,
          () => execution.require(JOB_ID),
          OWNER,
          async () => {
            execution.markLeaseLost(JOB_ID, new Error("renewal failed"));
            return revisionPlan();
          }
        )
      )
    ).rejects.toMatchObject({ name: "LeaseLostError" });
    expect(client.requestCount).toBe(0);
  });

  it("rechecks the local lease after asynchronous terminal planning", async () => {
    const execution = new DurableJobExecutionContext();
    const scope = executionScope();
    const client = new NeverCalledStorageClient();

    await expect(
      execution.run(scope, () =>
        transitionDurableCanonicalTerminal(
          client.value,
          () => execution.require(JOB_ID),
          {
            owner: OWNER,
            prepareRevision: async () => {
              execution.markLeaseLost(JOB_ID, new Error("renewal failed"));
              return terminalRevisionPlan();
            }
          },
          { status: "blocked", projectRevision: 1, reason: "runtime capability unavailable" },
          RECORDED_AT
        )
      )
    ).rejects.toMatchObject({ name: "LeaseLostError" });
    expect(client.requestCount).toBe(0);
  });

  it("overrides a successful durable outcome with the explicit budget blocker from its terminal plan", async () => {
    const captured: Array<{ name: string; input: { terminal: { status: string; reason?: string } } }> = [];
    const client = {
      request: async (command: { name: string; input: { terminal: { status: string; reason?: string } } }) => {
        captured.push(command);
        return { terminal: { job: { status: command.input.terminal.status }, events: [], links: [] }, revisions: [] };
      }
    } as unknown as StorageWorkerClient;
    const active = executionScope();

    await transitionDurableCanonicalTerminal(
      client,
      () => active,
      {
        owner: OWNER,
        prepareRevision: async () => terminalRevisionPlan(["inputTokens"])
      },
      { status: "completed", projectRevision: 1 },
      RECORDED_AT
    );

    expect(captured).toHaveLength(1);
    expect(captured[0]?.input.terminal).toMatchObject({
      status: "blocked",
      reason: "Canonical resource budget exceeded: inputTokens."
    });
  });
});

class NeverCalledStorageClient {
  requestCount = 0;

  readonly value = {
    request: async (): Promise<never> => {
      this.requestCount += 1;
      throw new Error("Storage must not be called after local lease loss.");
    }
  } as unknown as StorageWorkerClient;
}

function executionScope(): DurableJobExecutionScope {
  return {
    job: {
      id: JOB_ID,
      projectId: PROJECT_ID,
      kind: "research_loop",
      status: "running",
      projectRevision: 1,
      idempotencyKey: "canonical-lease-key",
      createdAt: RECORDED_AT,
      updatedAt: RECORDED_AT
    },
    fence: { jobId: JOB_ID, attempt: 1, leaseOwner: "worker-canonical-lease", leaseGeneration: 1 },
    controller: new AbortController()
  };
}

function revisionPlan(): CanonicalRevisionPlan {
  return {
    expectedRevision: 1,
    revisions: [],
    finalState: { revision: 1, stateHash: "a".repeat(64) } as RunStateRevision,
    exactReplay: true
  };
}

function terminalRevisionPlan(budgetExceededDimensions: string[] = []) {
  const plan = revisionPlan();
  return {
    ...plan,
    budgetPrefix: {
      revisionCount: 0,
      finalState: { revision: plan.finalState.revision, stateHash: plan.finalState.stateHash },
      receiptHash: "b".repeat(64),
      targetUsage: {
        durationMs: 0,
        inputTokens: 0,
        outputTokens: 0,
        toolCalls: 0,
        retries: 0,
        estimatedCostMicrousd: 0,
        toolOutputBytes: 0
      }
    },
    ...(budgetExceededDimensions.length ? { budgetExceededDimensions } : {})
  };
}
