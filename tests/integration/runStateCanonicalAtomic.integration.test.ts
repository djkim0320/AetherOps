import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { storageStepCheckpointId } from "../../src/server/runtime/storage/v2/jobAtomicOperations.js";
import { parseStoredRunStateRevision, storageCanonicalHasher } from "../../src/server/runtime/storage/v2/runStatePayloadValidator.js";
import { prepareCanonicalBudgetPlan } from "../../src/server/composition/canonicalBudgetPlan.js";
import { storageCanonicalRevisionPlan } from "../../src/server/composition/durableCanonicalRunGateway.js";
import { CANONICAL_BUDGET_DECISION_PREFIX, CANONICAL_BUDGET_RECEIPT_PREFIX } from "../../src/core/orchestration/budgetAccounting.js";
import {
  PROJECT_ID,
  RUN_ID,
  canonical,
  claim,
  cleanupRunStateStorageWorkerFixture,
  countRows,
  createDatabasePath,
  currentProjectRevision,
  enqueueJob,
  fencedWrite,
  interruptJob,
  jobInput,
  removeClient,
  saveTaskContract,
  stateRevision,
  worker
} from "./runStateStorageWorker.fixture.js";

afterEach(cleanupRunStateStorageWorkerFixture);

describe("canonical run-state atomic storage worker operations", () => {
  it("commits cumulative budget accounting atomically and replays it after worker restart", async () => {
    const path = createDatabasePath("canonical-budget");
    const initial = worker(path);
    const jobId = "job-worker-canonical-budget";
    await initial.request({ name: "job.enqueue", job: jobInput(jobId) });
    const claimed = await claim(initial, jobId, "worker-canonical-budget", "2026-07-14T00:00:01.000Z");
    await saveTaskContract(initial, claimed.fence);
    const revision0 = stateRevision(0, jobId);
    const revision1 = stateRevision(1, jobId);
    await fencedWrite(initial, claimed.fence, { name: "runState.commit", input: { expectedRevision: null, revision: revision0 } });
    await fencedWrite(initial, claimed.fence, { name: "runState.commit", input: { expectedRevision: 0, revision: revision1 } });
    const owner = { projectId: PROJECT_ID, runId: RUN_ID, jobId };
    const receiptHash = "2".repeat(64);
    const targetUsage = {
      durationMs: 500,
      inputTokens: 100,
      outputTokens: 20,
      toolCalls: 1,
      retries: 0,
      estimatedCostMicrousd: 0,
      toolOutputBytes: 256
    };
    const budgetInput = {
      owner,
      expectedState: { revision: 1, stateHash: revision1.stateHash },
      target: targetUsage,
      decisionId: `${CANONICAL_BUDGET_DECISION_PREFIX}${receiptHash}`,
      receiptId: `${CANONICAL_BUDGET_RECEIPT_PREFIX}${receiptHash}`,
      receiptHash,
      recordedAt: "2026-07-14T00:01:30.000Z"
    };
    const plan = prepareCanonicalBudgetPlan(budgetInput, parseStoredRunStateRevision(revision1.data), storageCanonicalHasher);

    await expect(
      initial.request({
        name: "canonical.commitBudget",
        input: {
          fence: claimed.fence,
          owner,
          finalState: { revision: plan.finalState.revision, stateHash: "f".repeat(64) },
          exactReplay: false,
          revisions: storageCanonicalRevisionPlan(owner, plan),
          receiptHash,
          targetUsage
        }
      })
    ).rejects.toThrow(/declared final revision and hash/i);
    expect(countRows(path, "run_state_revisions")).toBe(2);

    await initial.request({
      name: "canonical.commitBudget",
      input: {
        fence: claimed.fence,
        owner,
        finalState: { revision: plan.finalState.revision, stateHash: plan.finalState.stateHash },
        exactReplay: false,
        revisions: storageCanonicalRevisionPlan(owner, plan),
        receiptHash,
        targetUsage
      }
    });
    await initial.close();
    removeClient(initial);

    const resumed = worker(path);
    const stored = await resumed.request<{ data: unknown; revision: number; stateHash: string }>({ name: "runState.latest", owner });
    const replay = prepareCanonicalBudgetPlan(
      { ...budgetInput, expectedState: { revision: stored.revision, stateHash: stored.stateHash } },
      parseStoredRunStateRevision(stored.data),
      storageCanonicalHasher
    );
    expect(replay.exactReplay).toBe(true);
    await expect(
      resumed.request({
        name: "canonical.commitBudget",
        input: {
          fence: claimed.fence,
          owner,
          finalState: { revision: replay.finalState.revision, stateHash: replay.finalState.stateHash },
          exactReplay: true,
          revisions: [],
          receiptHash,
          targetUsage
        }
      })
    ).resolves.toMatchObject({ revisions: [], finalRevision: { data: { budgetUsage: targetUsage } } });
  });

  it("commits checkpoint and canonical revision atomically and rejects a mismatched declared final state", async () => {
    const path = createDatabasePath("canonical-step");
    const client = worker(path);
    const jobId = "job-worker-canonical-step";
    await client.request({ name: "job.enqueue", job: jobInput(jobId) });
    const claimed = await claim(client, jobId, "worker-canonical-step", "2026-07-14T00:00:01.000Z");
    await saveTaskContract(client, claimed.fence);
    const revision0 = stateRevision(0, jobId);
    const revision1 = stateRevision(1, jobId);
    await fencedWrite(client, claimed.fence, { name: "runState.commit", input: { expectedRevision: null, revision: revision0 } });
    await fencedWrite(client, claimed.fence, { name: "runState.commit", input: { expectedRevision: 0, revision: revision1 } });
    const checkpointId = storageStepCheckpointId(claimed.fence, "EXECUTE_TOOLS");
    const revision2 = canonical.decisionRevision(revision1, jobId, "checkpoint:execute-tools", "2026-07-14T00:02:00.000Z", checkpointId);
    const owner = { projectId: PROJECT_ID, runId: RUN_ID, jobId };
    const step = {
      fence: claimed.fence,
      step: "EXECUTE_TOOLS",
      projectRevision: await currentProjectRevision(client),
      occurredAt: "2026-07-14T00:02:00.000Z",
      checkpointData: {
        phase: "execute_tools_completed",
        attempts: [{ id: "attempt-1", inputHash: "a".repeat(64), outputHash: "b".repeat(64) }]
      }
    };

    await expect(
      client.request({
        name: "canonical.commitStep",
        input: {
          step,
          owner,
          finalState: { revision: 2, stateHash: "f".repeat(64) },
          exactReplay: false,
          revisions: [{ expectedRevision: 1, revision: revision2 }]
        }
      })
    ).rejects.toThrow(/declared final revision and hash/i);
    expect(countRows(path, "run_state_revisions")).toBe(2);
    expect(countRows(path, "checkpoints")).toBe(0);

    const committed = await client.request<{
      step: { checkpoint: { id: string; data: unknown }; event: { type: string } };
      revisions: Array<{ stateHash: string }>;
    }>({
      name: "canonical.commitStep",
      input: {
        step,
        owner,
        finalState: { revision: 2, stateHash: revision2.stateHash },
        exactReplay: false,
        revisions: [{ expectedRevision: 1, revision: revision2 }]
      }
    });
    expect(committed.revisions.map((revision) => revision.stateHash)).toEqual([revision2.stateHash]);
    expect(committed.step.event.type).toBe("run.step.changed");
    expect(committed.step.checkpoint.data).toEqual(step.checkpointData);
    expect(countRows(path, "checkpoints")).toBe(1);

    await expect(
      client.request({
        name: "canonical.commitStep",
        input: { step, owner, finalState: { revision: 2, stateHash: revision2.stateHash }, exactReplay: true, revisions: [] }
      })
    ).resolves.toMatchObject({ revisions: [] });
  });

  it("atomically preserves an observed budget overage and settles the durable job as blocked", async () => {
    const path = createDatabasePath("canonical-budget-overage");
    const client = worker(path);
    const jobId = "job-worker-canonical-budget-overage";
    await client.request({ name: "job.enqueue", job: jobInput(jobId) });
    const claimed = await claim(client, jobId, "worker-canonical-budget-overage", "2026-07-14T00:00:01.000Z");
    await saveTaskContract(client, claimed.fence);
    const revision0 = stateRevision(0, jobId);
    const revision1 = stateRevision(1, jobId);
    await fencedWrite(client, claimed.fence, { name: "runState.commit", input: { expectedRevision: null, revision: revision0 } });
    await fencedWrite(client, claimed.fence, { name: "runState.commit", input: { expectedRevision: 0, revision: revision1 } });
    const owner = { projectId: PROJECT_ID, runId: RUN_ID, jobId };
    const receiptHash = "3".repeat(64);
    const targetUsage = {
      durationMs: 1_000,
      inputTokens: 10_001,
      outputTokens: 1,
      toolCalls: 1,
      retries: 0,
      estimatedCostMicrousd: 0,
      toolOutputBytes: 1
    };
    const budgetPlan = prepareCanonicalBudgetPlan(
      {
        owner,
        expectedState: { revision: 1, stateHash: revision1.stateHash },
        target: targetUsage,
        decisionId: `${CANONICAL_BUDGET_DECISION_PREFIX}${receiptHash}`,
        receiptId: `${CANONICAL_BUDGET_RECEIPT_PREFIX}${receiptHash}`,
        receiptHash,
        recordedAt: "2026-07-14T00:01:30.000Z"
      },
      parseStoredRunStateRevision(revision1.data),
      storageCanonicalHasher
    );
    const budgetRevisions = storageCanonicalRevisionPlan(owner, budgetPlan);
    const blocker = canonical.blockerRevision(budgetRevisions.at(-1)!.revision, jobId, jobId, "2026-07-14T00:01:31.000Z", "BUDGET_EXHAUSTED");

    const result = await client.request<{
      terminal: { job: { status: string; blockedReason?: string } };
      revisions: Array<{ data: { budgetUsage: typeof targetUsage; blockedReasons: Array<{ code: string }> } }>;
    }>({
      name: "canonical.transitionTerminal",
      input: {
        terminal: {
          fence: claimed.fence,
          status: "blocked",
          projectRevision: await currentProjectRevision(client),
          reason: "Canonical resource budget exceeded: inputTokens.",
          occurredAt: "2026-07-14T00:01:31.000Z"
        },
        owner,
        finalState: { revision: blocker.revision, stateHash: blocker.stateHash },
        exactReplay: false,
        revisions: [...budgetRevisions, { expectedRevision: budgetPlan.finalState.revision, revision: blocker }],
        budgetPrefix: {
          revisionCount: budgetRevisions.length,
          finalState: { revision: budgetPlan.finalState.revision, stateHash: budgetPlan.finalState.stateHash },
          receiptHash,
          targetUsage
        }
      }
    });
    expect(result.terminal.job).toMatchObject({ status: "blocked", blockedReason: expect.any(String) });
    expect(result.revisions.at(-1)?.data).toMatchObject({
      budgetUsage: targetUsage,
      blockedReasons: [expect.objectContaining({ code: "BUDGET_EXHAUSTED" })]
    });
  });

  it("commits a bounded multi-revision canonical plan atomically for blocker-clear resume", async () => {
    const path = createDatabasePath("canonical-plan");
    const initial = worker(path);
    const predecessorJobId = "job-worker-canonical-plan-root";
    await initial.request({ name: "job.enqueue", job: jobInput(predecessorJobId) });
    const initialClaim = await claim(initial, predecessorJobId, "worker-canonical-plan-root", "2026-07-14T00:00:01.000Z");
    await saveTaskContract(initial, initialClaim.fence);
    const revision0 = stateRevision(0, predecessorJobId);
    const revision1 = stateRevision(1, predecessorJobId);
    await fencedWrite(initial, initialClaim.fence, { name: "runState.commit", input: { expectedRevision: null, revision: revision0 } });
    await fencedWrite(initial, initialClaim.fence, { name: "runState.commit", input: { expectedRevision: 0, revision: revision1 } });
    const checkpointStep = "RESUME_CHECKPOINT";
    const checkpointId = storageStepCheckpointId(initialClaim.fence, checkpointStep);
    const checkpointRevision = canonical.decisionRevision(revision1, predecessorJobId, "checkpoint:resume", "2026-07-14T00:01:30.000Z", checkpointId);
    await initial.request({
      name: "canonical.commitStep",
      input: {
        step: {
          fence: initialClaim.fence,
          step: checkpointStep,
          projectRevision: await currentProjectRevision(initial),
          occurredAt: "2026-07-14T00:01:30.000Z"
        },
        owner: { projectId: PROJECT_ID, runId: RUN_ID, jobId: predecessorJobId },
        finalState: { revision: 2, stateHash: checkpointRevision.stateHash },
        exactReplay: false,
        revisions: [{ expectedRevision: 1, revision: checkpointRevision }]
      }
    });
    const blockerReceiptId = predecessorJobId;
    const blockedRevision = canonical.blockerRevision(checkpointRevision, predecessorJobId, blockerReceiptId, "2026-07-14T00:01:45.000Z");
    await fencedWrite(initial, initialClaim.fence, { name: "runState.commit", input: { expectedRevision: 2, revision: blockedRevision } });
    await initial.close();
    removeClient(initial);
    interruptJob(path, predecessorJobId);

    const client = worker(path);
    const jobId = "job-worker-canonical-plan-resume";
    await enqueueJob(client, jobInput(jobId, predecessorJobId, checkpointId));
    const claimed = await claim(client, jobId, "worker-canonical-plan-resume", "2026-07-14T00:02:00.000Z");
    const revision2 = canonical.decisionRevision(blockedRevision, jobId, "resume:plan-authorization", "2026-07-14T00:02:01.000Z", jobId);
    const clearanceDecisionId = `clearance:${storageCanonicalHasher
      .sha256Canonical({ runId: RUN_ID, sourceReceiptId: blockerReceiptId, dispositionReceiptId: jobId })
      .slice(0, 48)}`;
    const revision3 = canonical.decisionRevision(revision2, jobId, clearanceDecisionId, "2026-07-14T00:02:02.000Z", jobId);
    const revision4 = canonical.clearBlockerRevision(revision3, jobId, blockerReceiptId, jobId, "2026-07-14T00:02:03.000Z");
    const owner = { projectId: PROJECT_ID, runId: RUN_ID, jobId };
    const revisions = [
      { expectedRevision: 3, revision: revision2 },
      { expectedRevision: 4, revision: revision3 },
      { expectedRevision: 5, revision: revision4 }
    ];

    await expect(
      client.request({
        name: "canonical.commitPlan",
        input: {
          fence: claimed.fence,
          occurredAt: "2026-07-14T00:02:02.000Z",
          owner,
          finalState: { revision: 6, stateHash: "d".repeat(64) },
          exactReplay: false,
          revisions
        }
      })
    ).rejects.toThrow(/declared final revision and hash/i);
    expect(countRows(path, "run_state_revisions")).toBe(4);

    await expect(
      client.request({
        name: "canonical.commitPlan",
        input: {
          fence: claimed.fence,
          occurredAt: "2026-07-14T00:02:03.000Z",
          owner,
          finalState: { revision: 6, stateHash: revision4.stateHash },
          exactReplay: false,
          revisions
        }
      })
    ).resolves.toMatchObject({
      revisions: [{ revision: 4 }, { revision: 5 }, { revision: 6 }],
      finalRevision: { revision: 6, stateHash: revision4.stateHash }
    });

    await expect(
      client.request({
        name: "canonical.commitPlan",
        input: {
          fence: claimed.fence,
          owner,
          finalState: { revision: 6, stateHash: revision4.stateHash },
          exactReplay: true,
          revisions: []
        }
      })
    ).resolves.toMatchObject({ revisions: [], finalRevision: { revision: 6 } });
  });

  it("commits node completion, run termination, job terminal state, checkpoint, and SSE in one transaction", async () => {
    const path = createDatabasePath("canonical-terminal");
    const client = worker(path);
    const jobId = "job-worker-canonical-terminal";
    await client.request({ name: "job.enqueue", job: jobInput(jobId) });
    const claimed = await claim(client, jobId, "worker-canonical-terminal", "2026-07-14T00:00:01.000Z");
    await saveTaskContract(client, claimed.fence);
    const revision0 = stateRevision(0, jobId);
    const revision1 = stateRevision(1, jobId);
    await fencedWrite(client, claimed.fence, { name: "runState.commit", input: { expectedRevision: null, revision: revision0 } });
    await fencedWrite(client, claimed.fence, { name: "runState.commit", input: { expectedRevision: 0, revision: revision1 } });
    const owner = { projectId: PROJECT_ID, runId: RUN_ID, jobId };
    const terminal = {
      fence: claimed.fence,
      status: "completed" as const,
      projectRevision: await currentProjectRevision(client),
      occurredAt: "2026-07-14T00:03:00.000Z",
      completedStep: {
        step: "FINALIZE",
        checkpointData: { phase: "execute_tools_completed", attempts: [] }
      }
    };
    const completedCheckpointId = storageStepCheckpointId(claimed.fence, terminal.completedStep.step);
    const verification = await client.request<{
      receipts: Array<{ id: string; receiptKind: string }>;
    }>({
      name: "canonical.verifyTerminal",
      input: {
        fence: claimed.fence,
        owner,
        checkpointId: completedCheckpointId,
        completedStep: terminal.completedStep,
        resources: [],
        criteria: [
          { criterionId: "criterion-traceability", verificationKind: "traceability" },
          { criterionId: "criterion-policy", verificationKind: "policy" }
        ],
        verifiedAt: terminal.occurredAt
      }
    });
    const verifierReceiptIds = verification.receipts.map((receipt) => receipt.id);
    const acceptanceReceiptIds = verification.receipts.filter((receipt) => receipt.receiptKind === "acceptance").map((receipt) => receipt.id);
    const budgetReceiptHash = "1".repeat(64);
    const budgetUsage = {
      durationMs: 0,
      inputTokens: 0,
      outputTokens: 0,
      toolCalls: 0,
      retries: 0,
      estimatedCostMicrousd: 0,
      toolOutputBytes: 0
    };
    const budgetRevision = canonical.decisionRevision(
      revision1,
      jobId,
      `${CANONICAL_BUDGET_DECISION_PREFIX}${budgetReceiptHash}`,
      "2026-07-14T00:01:30.000Z",
      `${CANONICAL_BUDGET_RECEIPT_PREFIX}${budgetReceiptHash}`
    );
    const [revision2, revision3] = canonical.completionRevisionsFrom(budgetRevision, jobId, verifierReceiptIds, acceptanceReceiptIds);
    const budgetPrefix = {
      revisionCount: 1,
      finalState: { revision: budgetRevision.revision, stateHash: budgetRevision.stateHash },
      receiptHash: budgetReceiptHash,
      targetUsage: budgetUsage
    };

    await expect(
      client.request({
        name: "canonical.transitionTerminal",
        input: {
          terminal,
          owner,
          finalState: { revision: revision3.revision, stateHash: "e".repeat(64) },
          exactReplay: false,
          revisions: [
            { expectedRevision: 1, revision: budgetRevision },
            { expectedRevision: budgetRevision.revision, revision: revision2 },
            { expectedRevision: revision2.revision, revision: revision3 }
          ],
          budgetPrefix
        }
      })
    ).rejects.toThrow(/declared final revision and hash/i);
    expect(countRows(path, "run_state_revisions")).toBe(2);
    expect(countRows(path, "checkpoints")).toBe(0);
    await expect(client.request({ name: "job.get", jobId })).resolves.toMatchObject({ status: "running" });

    const completed = await client.request<{
      terminal: { job: { status: string }; events: Array<{ type: string }>; stepDisposition?: { checkpoint: { data: unknown } } };
      revisions: Array<{ revision: number }>;
    }>({
      name: "canonical.transitionTerminal",
      input: {
        terminal,
        owner,
        finalState: { revision: revision3.revision, stateHash: revision3.stateHash },
        exactReplay: false,
        revisions: [
          { expectedRevision: 1, revision: budgetRevision },
          { expectedRevision: budgetRevision.revision, revision: revision2 },
          { expectedRevision: revision2.revision, revision: revision3 }
        ],
        budgetPrefix
      }
    });
    expect(completed.revisions.map((revision) => revision.revision)).toEqual([2, 3, 4]);
    expect(completed.terminal.job.status).toBe("completed");
    expect(completed.terminal.events.map((event) => event.type)).toEqual(expect.arrayContaining(["run.step.changed", "run.status.changed"]));
    expect(completed.terminal.stepDisposition?.checkpoint.data).toEqual(terminal.completedStep.checkpointData);
    expect(countRows(path, "run_state_revisions")).toBe(5);
    expect(countRows(path, "checkpoints")).toBe(1);
    const receiptReadback = new DatabaseSync(path, { readOnly: true });
    try {
      expect(receiptReadback.prepare("select count(*) count from canonical_terminal_verifier_receipts").get()).toEqual({ count: 4 });
    } finally {
      receiptReadback.close();
    }

    await expect(
      client.request({
        name: "canonical.transitionTerminal",
        input: {
          terminal,
          owner,
          finalState: { revision: revision3.revision, stateHash: revision3.stateHash },
          exactReplay: true,
          revisions: [],
          budgetPrefix: {
            revisionCount: 0,
            finalState: { revision: revision3.revision, stateHash: revision3.stateHash },
            receiptHash: budgetReceiptHash,
            targetUsage: budgetUsage
          }
        }
      })
    ).resolves.toMatchObject({ revisions: [], terminal: { job: { status: "completed" } } });
  });

  it("atomically commits the first successor checkpoint revision on a real resume lineage", async () => {
    const path = createDatabasePath("canonical-resume-step");
    const initial = worker(path);
    const initialJobId = "job-worker-canonical-predecessor";
    await initial.request({ name: "job.enqueue", job: jobInput(initialJobId) });
    const initialClaim = await claim(initial, initialJobId, "worker-canonical-predecessor", "2026-07-14T00:00:01.000Z");
    await saveTaskContract(initial, initialClaim.fence);
    const revision0 = stateRevision(0, initialJobId);
    const revision1 = stateRevision(1, initialJobId);
    await fencedWrite(initial, initialClaim.fence, { name: "runState.commit", input: { expectedRevision: null, revision: revision0 } });
    await fencedWrite(initial, initialClaim.fence, { name: "runState.commit", input: { expectedRevision: 0, revision: revision1 } });
    const predecessorStep = "PREDECESSOR_CHECKPOINT";
    const predecessorCheckpointId = storageStepCheckpointId(initialClaim.fence, predecessorStep);
    const revision2 = canonical.decisionRevision(revision1, initialJobId, "checkpoint:predecessor", "2026-07-14T00:02:00.000Z", predecessorCheckpointId);
    await initial.request({
      name: "canonical.commitStep",
      input: {
        step: {
          fence: initialClaim.fence,
          step: predecessorStep,
          projectRevision: await currentProjectRevision(initial),
          occurredAt: "2026-07-14T00:02:00.000Z"
        },
        owner: { projectId: PROJECT_ID, runId: RUN_ID, jobId: initialJobId },
        finalState: { revision: 2, stateHash: revision2.stateHash },
        exactReplay: false,
        revisions: [{ expectedRevision: 1, revision: revision2 }]
      }
    });
    await initial.close();
    removeClient(initial);
    interruptJob(path, initialJobId);

    const resumed = worker(path);
    const resumedJobId = "job-worker-canonical-successor";
    await enqueueJob(resumed, jobInput(resumedJobId, initialJobId, predecessorCheckpointId));
    const resumedClaim = await claim(resumed, resumedJobId, "worker-canonical-successor", "2026-07-14T00:02:01.000Z");
    const resumeRevision = canonical.decisionRevision(revision2, resumedJobId, "resume:successor-authorization", "2026-07-14T00:02:30.000Z", resumedJobId);
    await resumed.request({
      name: "canonical.commitPlan",
      input: {
        fence: resumedClaim.fence,
        owner: { projectId: PROJECT_ID, runId: RUN_ID, jobId: resumedJobId },
        finalState: { revision: 3, stateHash: resumeRevision.stateHash },
        exactReplay: false,
        revisions: [{ expectedRevision: 2, revision: resumeRevision }]
      }
    });
    const successorStep = "SUCCESSOR_CHECKPOINT";
    const successorCheckpointId = storageStepCheckpointId(resumedClaim.fence, successorStep);
    const revision3 = canonical.decisionRevision(resumeRevision, resumedJobId, "checkpoint:successor", "2026-07-14T00:03:00.000Z", successorCheckpointId);
    await expect(
      resumed.request({
        name: "canonical.commitStep",
        input: {
          step: {
            fence: resumedClaim.fence,
            step: successorStep,
            projectRevision: await currentProjectRevision(resumed),
            occurredAt: "2026-07-14T00:03:00.000Z"
          },
          owner: { projectId: PROJECT_ID, runId: RUN_ID, jobId: resumedJobId },
          finalState: { revision: 4, stateHash: revision3.stateHash },
          exactReplay: false,
          revisions: [{ expectedRevision: 3, revision: revision3 }]
        }
      })
    ).resolves.toMatchObject({
      step: { checkpoint: { id: successorCheckpointId } },
      revisions: [{ revision: 4, jobId: resumedJobId }]
    });

    const readback = new DatabaseSync(path, { readOnly: true });
    try {
      expect(readback.prepare("select job_id,predecessor_job_id,lineage_sequence from run_job_links order by lineage_sequence").all()).toEqual([
        { job_id: initialJobId, predecessor_job_id: null, lineage_sequence: 1 },
        { job_id: resumedJobId, predecessor_job_id: initialJobId, lineage_sequence: 2 }
      ]);
      expect(countRows(path, "checkpoints")).toBe(2);
    } finally {
      readback.close();
    }
  });
});
