import { describe, expect, it } from "vitest";
import type { ContextPack } from "../../core/context/public.js";
import type { RunStateRevision } from "../../core/orchestration/runStateCapsule.js";
import { CANONICAL_BUDGET_DECISION_PREFIX, CANONICAL_BUDGET_RECEIPT_PREFIX, type CanonicalBudgetUsage } from "../../core/orchestration/budgetAccounting.js";
import type { TaskContract } from "../../core/orchestration/taskContract.js";
import { createInputProject, createStrictTestOrchestrator } from "../../core/testing/orchestratorTestHarness.js";
import { CanonicalRunRuntime } from "./canonicalRunRuntime.js";
import type { CanonicalRunGateway, CanonicalRunOwner } from "./canonicalRunTypes.js";
import { durableJobRequestHash } from "./durableJobRequestHash.js";
import { canonicalResearchTerminalTransition } from "./durableCanonicalResearchTerminal.js";
import type { DurableJobRecord } from "./durableJobTypes.js";
import type {
  StorageCanonicalTerminalVerifierReceipt,
  StorageCanonicalTerminalVerifyInput,
  StorageCanonicalTerminalVerifyResult
} from "../runtime/storage/v2/terminalReceiptTypes.js";

const recordedAt = "2026-07-14T00:00:00.000Z";
const hasher = { sha256Canonical: durableJobRequestHash };

describe("canonical research terminal transition", () => {
  it("prepares receipt-complete terminal revisions from real checkpoint and job receipts", async () => {
    const prepared = await fixture();
    const transition = canonicalResearchTerminalTransition({ ...prepared, promotions: [], hasher });
    const plan = await transition.prepareRevision({
      status: "completed",
      recordedAt,
      completedStepCheckpointId: "checkpoint-final",
      completedStep: completedStep()
    });

    expect(plan.revisions).toHaveLength(3);
    expect(plan.finalState.status).toBe("completed");
    expect(plan.finalState.terminalReceipt).toMatchObject({
      outcome: "completed",
      acceptanceReceiptIds: ["terminal-receipt:acceptance-traceability", "terminal-receipt:acceptance-policy"]
    });
  });

  it("keeps recoverable failure non-terminal and records the durable job as its blocker receipt", async () => {
    const prepared = await fixture();
    const transition = canonicalResearchTerminalTransition({ ...prepared, promotions: [], hasher });
    const plan = await transition.prepareRevision({ status: "failed", recordedAt });

    expect(plan.finalState.status).toBe("blocked");
    expect(plan.finalState.terminalReceipt).toBeUndefined();
    expect(plan.finalState.blockedReasons).toEqual([expect.objectContaining({ code: "RECOVERABLE_JOB_FAILURE", sourceReceiptId: prepared.job.id })]);
  });

  it("does not invent a canonical mutation for pause", async () => {
    const prepared = await fixture();
    const transition = canonicalResearchTerminalTransition({ ...prepared, promotions: [], hasher });
    const plan = await transition.prepareRevision({ status: "paused", recordedAt });

    expect(plan.exactReplay).toBe(false);
    expect(plan.revisions).toHaveLength(1);
    expect(plan.finalState.status).toBe("running");
  });

  it("preserves observed overage and prepares an explicit budget blocker", async () => {
    const prepared = await fixture({ inputTokens: 8_001 });
    const transition = canonicalResearchTerminalTransition({ ...prepared, promotions: [], hasher });
    const plan = await transition.prepareRevision({ status: "completed", recordedAt });

    expect(plan.budgetExceededDimensions).toEqual(["inputTokens"]);
    expect(plan.finalState.budgetUsage.inputTokens).toBe(8_001);
    expect(plan.finalState.status).toBe("blocked");
    expect(plan.finalState.blockedReasons).toEqual([expect.objectContaining({ code: "BUDGET_EXHAUSTED", sourceReceiptId: prepared.job.id })]);
  });

  it("rejects promotion of a raw source observation", async () => {
    const prepared = await fixture();
    const transition = canonicalResearchTerminalTransition({
      ...prepared,
      hasher,
      promotions: [
        {
          link: {
            id: "promotion-source",
            projectId: prepared.job.projectId,
            jobId: prepared.job.id,
            attemptId: "attempt-source",
            outputKind: "source",
            outputId: "source-one",
            promoted: true,
            createdAt: recordedAt,
            promotedAt: recordedAt
          }
        }
      ]
    });

    await expect(
      transition.prepareRevision({
        status: "completed",
        recordedAt,
        completedStepCheckpointId: "checkpoint-final",
        completedStep: completedStep()
      })
    ).rejects.toMatchObject({ code: "MISSING_ACCEPTANCE_VERIFIER" });
  });
});

async function fixture(usage: Partial<CanonicalBudgetUsage> = {}) {
  const orchestrator = createStrictTestOrchestrator();
  const snapshot = await createInputProject(orchestrator, {
    goal: "Produce a receipt-backed research result.",
    topic: "Canonical completion",
    scope: "Local deterministic research",
    budget: "bounded",
    autonomyPolicy: { toolApproval: "suggested", allowExternalSearch: false, allowCodeExecution: false }
  });
  const owner = { projectId: snapshot.project.id, runId: "run:job-terminal", jobId: "job-terminal" };
  const gateway = new TerminalTestGateway();
  const runtime = new CanonicalRunRuntime({ gateway, hasher });
  await runtime.prepareInitialRun({
    owner,
    rootJobId: owner.jobId,
    rootJobCreatedAt: recordedAt,
    snapshot,
    policy: {
      requestedCapabilities: { agent: true, engineering: false, search: false },
      effectiveCapabilities: { agent: true, engineering: false, search: false },
      toolPolicy: { allowCodexCli: false, sourceAccess: { mode: "offline" } },
      externalSideEffects: []
    },
    taskLimits: {
      maxDurationMs: 60_000,
      maxInputTokens: 8_000,
      maxOutputTokens: 2_000,
      maxToolCalls: 8,
      maxRetries: 1,
      maxEstimatedCostMicrousd: 0,
      maxToolOutputBytes: 1_000_000,
      maxConcurrency: 2
    },
    preparedAt: recordedAt
  });
  const target: CanonicalBudgetUsage = {
    durationMs: 0,
    inputTokens: 0,
    outputTokens: 0,
    toolCalls: 0,
    retries: 0,
    estimatedCostMicrousd: 0,
    toolOutputBytes: 0,
    ...usage
  };
  const receiptHash = hasher.sha256Canonical({ target, policy: "test-budget-accounting-v1" });
  const precedingPlan = await runtime.prepareBudgetRevision({
    owner,
    expectedState: { revision: 1, stateHash: (await runtime.readCurrentRun(owner)).state.stateHash },
    target,
    decisionId: `${CANONICAL_BUDGET_DECISION_PREFIX}${receiptHash}`,
    receiptId: `${CANONICAL_BUDGET_RECEIPT_PREFIX}${receiptHash}`,
    receiptHash,
    recordedAt
  });
  const job: DurableJobRecord = {
    id: owner.jobId,
    projectId: owner.projectId,
    kind: "research_loop",
    status: "running",
    projectRevision: 1,
    idempotencyKey: "terminal-key",
    requestedCapabilities: { agent: true, engineering: false, search: false },
    effectiveCapabilities: { agent: true, engineering: false, search: false },
    toolPolicy: { allowCodexCli: false, sourceAccess: { mode: "offline" } },
    createdAt: recordedAt,
    updatedAt: recordedAt
  };
  return { runtime, owner, job, snapshot, precedingPlan, verifyTerminal: terminalVerification };
}

function completedStep() {
  return { step: "FINALIZE", checkpointData: { phase: "execute_tools_completed", attempts: [] } };
}

async function terminalVerification(input: Omit<StorageCanonicalTerminalVerifyInput, "fence">): Promise<StorageCanonicalTerminalVerifyResult> {
  expect(input.completedStep).toEqual(completedStep());
  expect(input.resources).toEqual([]);
  const trace = input.criteria.find((criterion) => criterion.verificationKind === "traceability")!;
  const policy = input.criteria.find((criterion) => criterion.verificationKind === "policy")!;
  const receipts = [
    terminalReceipt("checkpoint", trace.criterionId, "checkpoint-final", "checkpoint"),
    terminalReceipt("policy", policy.criterionId, input.owner.jobId, "policy"),
    terminalReceipt("acceptance", policy.criterionId, input.owner.jobId, "acceptance-policy"),
    terminalReceipt("acceptance", trace.criterionId, "checkpoint-final", "acceptance-traceability")
  ];
  return { requestHash: "a".repeat(64), receipts, exactReplay: false };
}

function terminalReceipt(
  receiptKind: StorageCanonicalTerminalVerifierReceipt["receiptKind"],
  criterionId: string,
  subjectId: string,
  suffix: string
): StorageCanonicalTerminalVerifierReceipt {
  return {
    id: `terminal-receipt:${suffix}`,
    projectId: "test-project",
    runId: "test-run",
    jobId: "test-job",
    requestHash: "a".repeat(64),
    receiptKind,
    criterionId,
    subjectKind: receiptKind,
    subjectId,
    subjectHash: "b".repeat(64),
    outputHash: "c".repeat(64),
    sourceReceiptIds: [],
    verifierVersion: "storage-worker-terminal-verifier-v1",
    verifiedAt: recordedAt,
    receiptHash: "d".repeat(64)
  };
}

class TerminalTestGateway implements CanonicalRunGateway {
  private readonly contracts = new Map<string, TaskContract>();
  private readonly revisions = new Map<string, RunStateRevision[]>();

  async saveTaskContract(_owner: CanonicalRunOwner, contract: TaskContract): Promise<unknown> {
    this.contracts.set(contract.id, this.contracts.get(contract.id) ?? contract);
    return this.contracts.get(contract.id);
  }
  async getTaskContract(projectId: string, taskContractId: string): Promise<unknown | undefined> {
    const contract = this.contracts.get(taskContractId);
    return contract?.projectId === projectId ? contract : undefined;
  }
  async latestRunState(owner: CanonicalRunOwner): Promise<unknown | undefined> {
    return this.revisions.get(owner.runId)?.at(-1);
  }
  async commitRunState(owner: CanonicalRunOwner, expectedRevision: number | null, revision: RunStateRevision): Promise<unknown> {
    const revisions = this.revisions.get(owner.runId) ?? [];
    expect(revisions.at(-1)?.revision ?? null).toBe(expectedRevision);
    revisions.push(revision);
    this.revisions.set(owner.runId, revisions);
    return revision;
  }
  async saveContextPack(_owner: CanonicalRunOwner, _expectedRevision: number, pack: ContextPack): Promise<unknown> {
    return pack;
  }
}
