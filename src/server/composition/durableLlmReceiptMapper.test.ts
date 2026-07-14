import { describe, expect, it } from "vitest";
import type { LlmInvocationMetadata, LlmInvocationRunningMetadata } from "../../core/providers/llm.js";
import { assertLlmInvocationUpdate } from "../runtime/storage/v2/traceState.js";
import { toStorageLlmInvocation, toStorageRunningLlmInvocation } from "./registerDurableResearchLoopHandler.js";

describe("durable LLM receipt mapping", () => {
  it("maps a repaired success from running to completed without turning validation history into an execution error", () => {
    const job = { id: "job-repaired", projectId: "project-1" };
    const running = toStorageRunningLlmInvocation(job, runningMetadata());
    const completed = toStorageLlmInvocation(job, completedMetadata(), running.id);

    expect(() => assertLlmInvocationUpdate(running, completed)).not.toThrow();
    expect(completed).toMatchObject({ status: "completed", repairCount: 1, responseHash: "b".repeat(64) });
    expect(completed.error).toBeUndefined();
    expect(completed.data?.validationErrors).toEqual(["response: expected an object"]);
  });
});

function runningMetadata(): LlmInvocationRunningMetadata {
  return {
    invocationId: "invocation-repaired",
    provider: "codex-oauth",
    model: "gpt-5.6-sol",
    reasoningEffort: "high",
    schemaName: "AetherOpsResearchPlan",
    promptVersion: "planner-v2",
    schemaVersion: "schema-v2",
    promptHash: "a".repeat(64),
    startedAt: "2026-07-14T00:00:00.000Z",
    status: "running"
  };
}

function completedMetadata(): LlmInvocationMetadata {
  return {
    ...runningMetadata(),
    responseHash: "b".repeat(64),
    completedAt: "2026-07-14T00:00:01.000Z",
    durationMs: 1_000,
    inputTokenEstimate: 10,
    outputTokenEstimate: 4,
    tokenEstimator: "utf8_bytes_div_4_ceil_v1",
    monetaryCostAvailability: "unavailable",
    repairCount: 1,
    status: "completed",
    validationErrors: ["response: expected an object"]
  };
}
