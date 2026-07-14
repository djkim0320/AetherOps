import { describe, expect, it } from "vitest";
import type {
  StorageToolAttempt,
  StorageToolAttemptStatus,
  StorageToolPostconditionDisposition,
  StorageToolSideEffect
} from "../runtime/storage/v2/traceTypes.js";
import { computeToolPostconditionReceiptHash } from "../runtime/storage/v2/toolPostcondition.js";
import { CanonicalRunRuntimeError } from "./canonicalRunTypes.js";
import { assertToolAttemptResumeSafe, classifyCanonicalToolEffect } from "./durableSideEffectPolicy.js";

describe("durable side-effect policy", () => {
  it.each([
    { label: "completed without postcondition", status: "completed" as const, effects: ["filesystem" as const] },
    { label: "response loss", status: "failed" as const, effects: ["filesystem" as const] },
    { label: "process interruption", status: "interrupted" as const, effects: ["process" as const] }
  ])("fails closed for a vnext mutating attempt after $label", ({ status, effects }) => {
    const attempt = vnextAttempt(status, effects);
    expect(() => assertToolAttemptResumeSafe(attempt)).toThrow(
      expect.objectContaining<Partial<CanonicalRunRuntimeError>>({ code: "PENDING_EXTERNAL_SIDE_EFFECT" })
    );
    expect(() => classifyCanonicalToolEffect(attempt)).toThrow(/ambiguous external side effect/i);
  });

  it("keeps network-only acquisition observational without inventing a receipt", () => {
    const attempt = vnextAttempt("completed", ["network"]);
    delete attempt.sideEffectKey;
    expect(classifyCanonicalToolEffect(attempt)).toBe("committed");
    expect(() => assertToolAttemptResumeSafe(attempt)).not.toThrow();
  });

  it("treats a verified applied disposition as committed after response loss", () => {
    const attempt = withPostcondition(vnextAttempt("failed", ["filesystem"]), "applied");
    expect(classifyCanonicalToolEffect(attempt)).toBe("committed");
    expect(() => assertToolAttemptResumeSafe(attempt)).not.toThrow();
  });

  it("allows retry after an interruption verified as not applied", () => {
    const attempt = withPostcondition(vnextAttempt("interrupted", ["process"]), "not_applied");
    expect(classifyCanonicalToolEffect(attempt)).toBe("interrupted");
    expect(() => assertToolAttemptResumeSafe(attempt)).not.toThrow();
  });

  it("rejects a completed attempt whose verified disposition says not applied", () => {
    expect(() => classifyCanonicalToolEffect(withPostcondition(vnextAttempt("completed", ["filesystem"]), "not_applied"))).toThrow(
      /completed status conflicts/i
    );
  });

  it("preserves legacy terminal rows as legacy_unavailable", () => {
    const attempt: StorageToolAttempt = {
      id: "attempt-legacy",
      projectId: "project-1",
      jobId: "job-1",
      decisionId: "decision-1",
      ordinal: 0,
      status: "completed",
      inputHash: "a".repeat(64),
      traceAvailability: "legacy_unavailable",
      dependsOnAttemptIds: [],
      queuedAt: "2026-07-14T00:00:00.000Z"
    };
    expect(classifyCanonicalToolEffect(attempt)).toBe("committed");
  });
});

function vnextAttempt(status: StorageToolAttemptStatus, descriptorSideEffects: StorageToolSideEffect[]): StorageToolAttempt {
  return {
    id: `attempt-${status}-${descriptorSideEffects.join("-") || "pure"}`,
    projectId: "project-1",
    jobId: "job-1",
    decisionId: "decision-1",
    ordinal: 0,
    status,
    inputHash: "a".repeat(64),
    traceVersion: 1,
    traceAvailability: "vnext",
    descriptorVersion: "1",
    descriptorSideEffects,
    sideEffectKey: descriptorSideEffects.some((effect) => effect === "filesystem" || effect === "process") ? `effect-${status}` : undefined,
    idempotencyKey: `idempotency-${status}`,
    dependsOnAttemptIds: [],
    queuedAt: "2026-07-14T00:00:00.000Z",
    completedAt: "2026-07-14T00:00:01.000Z"
  };
}

function withPostcondition(attempt: StorageToolAttempt, disposition: StorageToolPostconditionDisposition): StorageToolAttempt {
  if (!attempt.sideEffectKey || !attempt.idempotencyKey) throw new Error("Test attempt requires deterministic side-effect identities.");
  const receiptFields = {
    receiptId: `receipt-${attempt.id}`,
    evidenceHash: "e".repeat(64),
    verifier: "deterministic-postcondition-verifier-v1",
    verifiedAt: "2026-07-14T00:00:02.000Z"
  };
  return {
    ...attempt,
    postconditionDisposition: disposition,
    postconditionReceipt: {
      ...receiptFields,
      receiptHash: computeToolPostconditionReceiptHash({
        attemptId: attempt.id,
        descriptorVersion: attempt.descriptorVersion,
        idempotencyKey: attempt.idempotencyKey,
        sideEffectKey: attempt.sideEffectKey,
        disposition,
        ...receiptFields
      })
    }
  };
}
