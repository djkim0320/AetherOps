import { describe, expect, it } from "vitest";
import { durableToolAttemptIdentity } from "./durableToolAttemptIdentity.js";

describe("durable tool-attempt identity", () => {
  it("deduplicates non-repeatable mutations across jobs but scopes repeatable mutations to one job", () => {
    const base = {
      projectId: "project-1",
      toolName: "EngineeringProgramTool",
      descriptorVersion: "1",
      mutatesExternalState: true,
      inputHash: "a".repeat(64)
    };
    const nonrepeatableA = durableToolAttemptIdentity({ ...base, jobId: "job-a", repeatable: false });
    const nonrepeatableB = durableToolAttemptIdentity({ ...base, jobId: "job-b", repeatable: false });
    expect(nonrepeatableB).toEqual(nonrepeatableA);

    const repeatableA = durableToolAttemptIdentity({ ...base, toolName: "PdfIngestionTool", jobId: "job-a", repeatable: true });
    const repeatableB = durableToolAttemptIdentity({ ...base, toolName: "PdfIngestionTool", jobId: "job-b", repeatable: true });
    expect(repeatableB.idempotencyKey).not.toBe(repeatableA.idempotencyKey);
    expect(repeatableB.sideEffectKey).not.toBe(repeatableA.sideEffectKey);
  });

  it("does not create a side-effect reservation identity for read-only tools", () => {
    const identity = durableToolAttemptIdentity({
      projectId: "project-1",
      jobId: "job-a",
      toolName: "DataAnalysisTool",
      descriptorVersion: "1",
      repeatable: false,
      mutatesExternalState: false,
      inputHash: "b".repeat(64)
    });
    expect(identity.idempotencyKey).toMatch(/^[a-f0-9]{64}$/);
    expect("sideEffectKey" in identity).toBe(false);
  });
});
