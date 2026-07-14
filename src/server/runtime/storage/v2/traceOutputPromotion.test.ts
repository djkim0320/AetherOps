import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { createStorageV2Repositories } from "./repositories.js";
import { migrateStorageV2Schema } from "./schema.js";
import { computeToolPostconditionReceiptHash } from "./toolPostcondition.js";

describe("trace output promotion", () => {
  it("requires a verified postcondition before a vnext filesystem attempt may promote output", () => {
    const db = new DatabaseSync(":memory:");
    migrateStorageV2Schema(db);
    const repositories = createStorageV2Repositories({ appDb: db });
    const trace = repositories.trace;
    repositories.jobs.enqueue({ id: "job-1", projectId: "project-1", operation: "research_loop" });
    trace.recordToolDecision({
      id: "decision-1",
      projectId: "project-1",
      jobId: "job-1",
      toolName: "ArtifactWriterTool",
      purpose: "Verify the output promotion boundary.",
      expectedOutcome: "A postcondition-bound artifact handle.",
      rawSelection: { inputHash: "a".repeat(64) },
      userPinned: false,
      policyStatus: "accepted",
      createdAt: "2026-07-14T00:00:00.000Z"
    });
    const base = {
      id: "attempt-filesystem-ambiguous",
      projectId: "project-1",
      jobId: "job-1",
      decisionId: "decision-1",
      ordinal: 0,
      status: "completed" as const,
      inputHash: "a".repeat(64),
      outputHash: "b".repeat(64),
      traceVersion: 1 as const,
      traceAvailability: "vnext" as const,
      descriptorVersion: "1",
      descriptorSideEffects: ["filesystem" as const],
      sideEffectKey: "filesystem-effect-1",
      idempotencyKey: "filesystem-idempotency-1",
      dependsOnAttemptIds: [],
      queuedAt: "2026-07-14T00:00:00.000Z",
      startedAt: "2026-07-14T00:00:00.500Z",
      completedAt: "2026-07-14T00:00:01.000Z"
    };
    trace.saveToolAttempt({
      ...base,
      status: "queued",
      outputHash: undefined,
      terminalCause: undefined,
      startedAt: undefined,
      completedAt: undefined
    });
    trace.saveToolAttempt({ ...base, status: "running", outputHash: undefined, terminalCause: undefined, completedAt: undefined });
    expect(trace.saveToolAttempt(base)).toMatchObject({ traceAvailability: "vnext", postconditionReceipt: undefined });
    expect(() => trace.recordOutputLink(output(base, "ambiguous"))).toThrow(/postcondition receipt/i);

    const receiptFields = {
      receiptId: "receipt-filesystem-1",
      evidenceHash: "c".repeat(64),
      verifier: "artifact-manifest-verifier-v1",
      verifiedAt: "2026-07-14T00:00:01.000Z"
    };
    const postconditionReceipt = {
      ...receiptFields,
      receiptHash: computeToolPostconditionReceiptHash({
        attemptId: base.id,
        descriptorVersion: base.descriptorVersion,
        idempotencyKey: base.idempotencyKey,
        sideEffectKey: base.sideEffectKey,
        disposition: "applied",
        ...receiptFields
      })
    };
    expect(trace.saveToolAttempt({ ...base, postconditionDisposition: "applied", postconditionReceipt })).toMatchObject({
      postconditionDisposition: "applied",
      postconditionReceipt
    });
    expect(trace.recordOutputLink(output(base, "verified"))).toMatchObject({ promoted: true });
    db.close();
  });
});

function output(base: { id: string; projectId: string; jobId: string; completedAt: string }, suffix: string) {
  return {
    id: `output-${suffix}`,
    projectId: base.projectId,
    jobId: base.jobId,
    attemptId: base.id,
    outputKind: "artifact" as const,
    outputId: `artifact-${suffix}`,
    promoted: true,
    createdAt: base.completedAt,
    promotedAt: base.completedAt
  };
}
