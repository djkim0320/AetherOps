import { describe, expect, it } from "vitest";
import { IdempotencyConflictError } from "../v2/jobErrors.js";
import { SideEffectReservationConflictError } from "../v2/toolSideEffectReservationTypes.js";
import { serializeWorkerError, workerError } from "./workerMessageSupport.js";

describe("storage Worker error boundary", () => {
  it("removes parser details, paths, secrets, and remote stacks from untyped failures", () => {
    const malformed = new SyntaxError('Unexpected token s in JSON at position 19: {"secret":"value"}');
    malformed.stack = "remote stack C:\\private\\workspace\\worker.ts:1";
    expect(serializeWorkerError(malformed)).toEqual({
      name: "SyntaxError",
      message: "Storage worker rejected malformed persisted JSON."
    });

    const pathFailure = serializeWorkerError(new Error("Failed C:\\private\\project\\secret.txt token=super-secret-value"));
    expect(pathFailure.stack).toBeUndefined();
    expect(pathFailure.message).toContain("[redacted-path]");
    expect(pathFailure.message).toContain("[redacted-secret]");
    expect(pathFailure.message).not.toContain("private");

    const reconstructed = workerError({ name: "Error", message: "safe message", stack: "REMOTE_SECRET_STACK" });
    expect(reconstructed.message).toBe("safe message");
    expect(reconstructed.stack).not.toContain("REMOTE_SECRET_STACK");
    expect(serializeWorkerError({ token: "must-not-leak" })).toEqual({
      name: "StorageWorkerError",
      message: "Storage worker command failed."
    });
  });

  it("preserves only explicit typed conflict codes across the Worker boundary", () => {
    const payload = serializeWorkerError(new IdempotencyConflictError());
    expect(payload).toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    expect(workerError(payload)).toBeInstanceOf(IdempotencyConflictError);

    const sideEffect = serializeWorkerError(new SideEffectReservationConflictError());
    expect(sideEffect).toMatchObject({ code: "SIDE_EFFECT_RESERVATION_CONFLICT" });
    expect(workerError(sideEffect)).toBeInstanceOf(SideEffectReservationConflictError);
  });
});
