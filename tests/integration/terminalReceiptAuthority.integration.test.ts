import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { storageStepCheckpointId } from "../../src/server/runtime/storage/v2/jobAtomicOperations.js";
import {
  STORAGE_TERMINAL_RECEIPT_MIGRATION_CHECKSUM,
  STORAGE_TERMINAL_RECEIPT_MIGRATION_NAME,
  STORAGE_TERMINAL_RECEIPT_SCHEMA_VERSION
} from "../../src/server/runtime/storage/v2/terminalReceiptSchema.js";
import type { StorageCanonicalTerminalVerifyResult } from "../../src/server/runtime/storage/v2/terminalReceiptTypes.js";
import {
  PROJECT_ID,
  RUN_ID,
  claim,
  cleanupRunStateStorageWorkerFixture,
  createDatabasePath,
  fencedWrite,
  jobInput,
  saveTaskContract,
  stateRevision,
  worker
} from "./runStateStorageWorker.fixture.js";

afterEach(cleanupRunStateStorageWorkerFixture);

describe("storage-worker canonical terminal receipt authority", () => {
  it("issues opaque immutable receipts from persisted readback and returns the same batch on exact replay", async () => {
    const path = createDatabasePath("terminal-receipt-authority");
    const client = worker(path);
    const jobId = "job-terminal-receipt-authority";
    await client.request({ name: "job.enqueue", job: jobInput(jobId) });
    const claimed = await claim(client, jobId, "worker-terminal-receipt-authority", "2026-07-14T00:00:01.000Z");
    await saveTaskContract(client, claimed.fence);
    await fencedWrite(client, claimed.fence, { name: "runState.commit", input: { expectedRevision: null, revision: stateRevision(0, jobId) } });
    await fencedWrite(client, claimed.fence, { name: "runState.commit", input: { expectedRevision: 0, revision: stateRevision(1, jobId) } });
    const owner = { projectId: PROJECT_ID, runId: RUN_ID, jobId };
    const completedStep = { step: "FINALIZE", checkpointData: { phase: "execute_tools_completed", attempts: [] } };
    const input = {
      fence: claimed.fence,
      owner,
      checkpointId: storageStepCheckpointId(claimed.fence, completedStep.step),
      completedStep,
      resources: [],
      criteria: [
        { criterionId: "criterion-traceability", verificationKind: "traceability" as const },
        { criterionId: "criterion-policy", verificationKind: "policy" as const }
      ],
      verifiedAt: "2026-07-14T00:03:00.000Z"
    };

    const issued = await client.request<StorageCanonicalTerminalVerifyResult>({ name: "canonical.verifyTerminal", input });
    const replay = await client.request<StorageCanonicalTerminalVerifyResult>({ name: "canonical.verifyTerminal", input });

    expect(issued).toMatchObject({ exactReplay: false, requestHash: expect.stringMatching(/^[a-f0-9]{64}$/), receipts: { length: 4 } });
    expect(replay).toEqual({ ...issued, exactReplay: true });
    expect(issued.receipts.every((receipt) => receipt.id.startsWith("terminal-receipt:") && ![jobId, input.checkpointId].includes(receipt.id))).toBe(true);
    expect(new Set(issued.receipts.map((receipt) => receipt.receiptHash)).size).toBe(issued.receipts.length);

    const db = new DatabaseSync(path);
    try {
      expect(db.prepare("select name,checksum_sha256 from schema_migrations where version=?").get(STORAGE_TERMINAL_RECEIPT_SCHEMA_VERSION)).toEqual({
        name: STORAGE_TERMINAL_RECEIPT_MIGRATION_NAME,
        checksum_sha256: STORAGE_TERMINAL_RECEIPT_MIGRATION_CHECKSUM
      });
      expect(db.prepare("select count(*) count from canonical_terminal_verifier_receipts").get()).toEqual({ count: 4 });
      const columns = (db.prepare("pragma table_info(canonical_terminal_verifier_receipts)").all() as Array<{ name: string }>).map((row) => row.name);
      expect(columns).not.toEqual(expect.arrayContaining(["prompt", "response", "secret", "content"]));
      expect(() => db.prepare("update canonical_terminal_verifier_receipts set subject_id='tampered'").run()).toThrow(/immutable/i);
      expect(() => db.prepare("delete from canonical_terminal_verifier_receipts").run()).toThrow(/immutable/i);
    } finally {
      db.close();
    }
  });

  it("rejects caller-selected checkpoint, fabricated attempt readback, and incomplete criteria without issuing receipts", async () => {
    const path = createDatabasePath("terminal-receipt-rejections");
    const client = worker(path);
    const jobId = "job-terminal-receipt-rejections";
    await client.request({ name: "job.enqueue", job: jobInput(jobId) });
    const claimed = await claim(client, jobId, "worker-terminal-receipt-rejections", "2026-07-14T00:00:01.000Z");
    await saveTaskContract(client, claimed.fence);
    await fencedWrite(client, claimed.fence, { name: "runState.commit", input: { expectedRevision: null, revision: stateRevision(0, jobId) } });
    await fencedWrite(client, claimed.fence, { name: "runState.commit", input: { expectedRevision: 0, revision: stateRevision(1, jobId) } });
    const owner = { projectId: PROJECT_ID, runId: RUN_ID, jobId };
    const completedStep = { step: "FINALIZE", checkpointData: { phase: "execute_tools_completed", attempts: [] } };
    const base = {
      fence: claimed.fence,
      owner,
      completedStep,
      resources: [],
      criteria: [
        { criterionId: "criterion-traceability", verificationKind: "traceability" as const },
        { criterionId: "criterion-policy", verificationKind: "policy" as const }
      ],
      verifiedAt: "2026-07-14T00:03:00.000Z"
    };
    const checkpointId = storageStepCheckpointId(claimed.fence, completedStep.step);

    await expect(client.request({ name: "canonical.verifyTerminal", input: { ...base, checkpointId: "caller-checkpoint" } })).rejects.toThrow(
      /checkpoint identity is not worker-derived/i
    );
    await expect(
      client.request({
        name: "canonical.verifyTerminal",
        input: {
          ...base,
          checkpointId,
          completedStep: {
            ...completedStep,
            checkpointData: { phase: "execute_tools_completed", attempts: [{ id: "fabricated", inputHash: "a".repeat(64) }] }
          }
        }
      })
    ).rejects.toThrow(/does not match persisted tool-attempt readback/i);
    await expect(client.request({ name: "canonical.verifyTerminal", input: { ...base, checkpointId, criteria: base.criteria.slice(0, 1) } })).rejects.toThrow(
      /do not cover the immutable task contract/i
    );
    await client.request({
      name: "fencedTransaction",
      fence: claimed.fence,
      commands: [
        {
          name: "trace.decision.record",
          decision: {
            id: "decision-dangling",
            projectId: PROJECT_ID,
            jobId,
            toolName: "DataAnalysisTool",
            purpose: "Verify dangling-attempt rejection.",
            expectedOutcome: "A terminal attempt.",
            rawSelection: { inputHash: "a".repeat(64) },
            userPinned: false,
            policyStatus: "accepted",
            createdAt: base.verifiedAt
          }
        },
        {
          name: "trace.attempt.save",
          attempt: {
            id: "attempt-dangling",
            projectId: PROJECT_ID,
            jobId,
            decisionId: "decision-dangling",
            ordinal: 0,
            status: "queued",
            inputHash: "a".repeat(64),
            traceVersion: 1,
            traceAvailability: "vnext",
            descriptorVersion: "1",
            descriptorSideEffects: [],
            idempotencyKey: "dangling-idempotency",
            dependsOnAttemptIds: [],
            queuedAt: base.verifiedAt
          }
        }
      ]
    });
    await expect(client.request({ name: "canonical.verifyTerminal", input: { ...base, checkpointId } })).rejects.toThrow(/dangling non-terminal/i);

    const db = new DatabaseSync(path, { readOnly: true });
    try {
      expect(db.prepare("select count(*) count from canonical_terminal_verifier_receipts").get()).toEqual({ count: 0 });
    } finally {
      db.close();
    }
  });

  it("rejects terminal verification while a persisted LLM invocation is still running", async () => {
    const path = createDatabasePath("terminal-receipt-running-llm");
    const client = worker(path);
    const jobId = "job-terminal-receipt-running-llm";
    await client.request({ name: "job.enqueue", job: jobInput(jobId) });
    const claimed = await claim(client, jobId, "worker-terminal-receipt-running-llm", "2026-07-14T00:00:01.000Z");
    await saveTaskContract(client, claimed.fence);
    await fencedWrite(client, claimed.fence, { name: "runState.commit", input: { expectedRevision: null, revision: stateRevision(0, jobId) } });
    await fencedWrite(client, claimed.fence, { name: "runState.commit", input: { expectedRevision: 0, revision: stateRevision(1, jobId) } });
    await fencedWrite(client, claimed.fence, {
      name: "trace.llm.save",
      invocation: {
        id: "llm-running-at-terminal",
        projectId: PROJECT_ID,
        jobId,
        model: "gpt-5.6-sol",
        reasoningEffort: "high",
        promptVersion: "planner-v1",
        schemaVersion: "research-plan-v1",
        promptHash: "a".repeat(64),
        repairCount: 0,
        status: "running",
        startedAt: "2026-07-14T00:02:00.000Z",
        data: { provider: "codex_oauth", schemaName: "ResearchPlan" }
      }
    });
    const completedStep = { step: "FINALIZE", checkpointData: { phase: "execute_tools_completed", attempts: [] } };
    await expect(
      client.request({
        name: "canonical.verifyTerminal",
        input: {
          fence: claimed.fence,
          owner: { projectId: PROJECT_ID, runId: RUN_ID, jobId },
          checkpointId: storageStepCheckpointId(claimed.fence, completedStep.step),
          completedStep,
          resources: [],
          criteria: [
            { criterionId: "criterion-traceability", verificationKind: "traceability" },
            { criterionId: "criterion-policy", verificationKind: "policy" }
          ],
          verifiedAt: "2026-07-14T00:03:00.000Z"
        }
      })
    ).rejects.toThrow(/dangling running LLM invocation/i);
  });
});
