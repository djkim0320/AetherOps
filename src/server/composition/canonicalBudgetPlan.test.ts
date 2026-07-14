import { describe, expect, it } from "vitest";
import type { RunStateRevision } from "../../core/orchestration/runStateCapsule.js";
import { createCanonicalRunFixture } from "../../../tests/fixtures/canonicalRunState.js";
import { storageCanonicalHasher } from "../runtime/storage/v2/runStatePayloadValidator.js";
import { prepareCanonicalBudgetPlan } from "./canonicalBudgetPlan.js";

const owner = { projectId: "project-budget-plan", runId: "run-budget-plan", jobId: "job-budget-plan" };
const fixture = createCanonicalRunFixture({
  projectId: owner.projectId,
  runId: owner.runId,
  taskId: "task-budget-plan",
  createdAt: "2026-07-14T00:00:00.000Z"
});

describe("canonical budget plan", () => {
  it("commits cumulative target as reducer delta followed by an immutable receipt", () => {
    const state = fixture.revision(1, owner.jobId).data;
    const plan = prepareCanonicalBudgetPlan(input(state, usage(5_000, 100, 20, 1, 0, 80), "a".repeat(64)), state, storageCanonicalHasher);
    expect(plan.revisions).toHaveLength(2);
    expect(plan.finalState.budgetUsage).toEqual(usage(5_000, 100, 20, 1, 0, 80));
    expect(plan.finalState.decisions.at(-1)).toMatchObject({
      decisionId: expect.stringContaining("cost-unavailable-unmetered"),
      decisionReceiptId: expect.stringContaining("token-estimate-v1")
    });
    const replay = prepareCanonicalBudgetPlan(input(plan.finalState, plan.finalState.budgetUsage, "a".repeat(64)), plan.finalState, storageCanonicalHasher);
    expect(replay).toMatchObject({ exactReplay: true, revisions: [] });
  });

  it("rejects a cumulative target that regresses below committed usage", () => {
    const state = fixture.revision(1, owner.jobId).data;
    const first = prepareCanonicalBudgetPlan(input(state, usage(5_000, 100, 20, 1, 0, 80), "a".repeat(64)), state, storageCanonicalHasher).finalState;
    expect(() => prepareCanonicalBudgetPlan(input(first, usage(4_999, 100, 20, 1, 0, 80), "b".repeat(64)), first, storageCanonicalHasher)).toThrow(/regressed/);
  });
});

function input(state: RunStateRevision, target: ReturnType<typeof usage>, hash: string) {
  return {
    owner,
    expectedState: { revision: state.revision, stateHash: state.stateHash },
    target,
    decisionId: `budget-accounting-v1:cost-unavailable-unmetered:${hash}`,
    receiptId: `budget-receipt-v1:token-estimate-v1:cost-unavailable-unmetered:${hash}`,
    receiptHash: hash,
    recordedAt: "2026-07-14T00:01:10.000Z"
  };
}

function usage(durationMs: number, inputTokens: number, outputTokens: number, toolCalls: number, retries: number, toolOutputBytes: number) {
  return { durationMs, inputTokens, outputTokens, toolCalls, retries, estimatedCostMicrousd: 0, toolOutputBytes };
}
