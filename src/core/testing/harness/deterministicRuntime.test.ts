import { describe, expect, it } from "vitest";
import { DeterministicClock, DeterministicFaultInjector, DeterministicIdGenerator, DeterministicToolProvider, type TestToolDefinition } from "./public.js";

describe("deterministic test-only runtime primitives", () => {
  it("replays clocks and UUIDs identically for the same seed", async () => {
    const first = new DeterministicIdGenerator(42);
    const second = new DeterministicIdGenerator(42);
    expect(first.nextUuid()).toBe(second.nextUuid());
    expect(first.nextStableId("receipt")).toBe(second.nextStableId("receipt"));

    const clock = new DeterministicClock("2026-01-01T00:00:00.000Z", 0);
    await clock.sleep(25);
    expect(clock.peekIso()).toBe("2026-01-01T00:00:00.025Z");
  });

  it("programs partial results and fails on unconsumed faults", async () => {
    const clock = new DeterministicClock("2026-01-01T00:00:00.000Z", 0);
    const ids = new DeterministicIdGenerator(7);
    const faults = new DeterministicFaultInjector([
      { target: "call-partial", occurrence: 1, latencyMs: 10, outcome: { kind: "partial_result", outputArtifactIds: ["partial-artifact"], outputBytes: 12 } }
    ]);
    const provider = new DeterministicToolProvider([tool("analysis.tool", false)], clock, ids, faults);
    const result = await provider.invoke({
      runId: ids.nextUuid(),
      target: "call-partial",
      toolName: "analysis.tool",
      inputHash: "a".repeat(64),
      capabilities: ["tool_execution"],
      allowedTools: ["analysis.tool"]
    });
    expect(result).toMatchObject({ outcome: "partial", outputArtifactIds: ["partial-artifact"], outputBytes: 12 });
    expect(() => provider.assertFaultsConsumed()).not.toThrow();

    const pending = new DeterministicFaultInjector([
      { target: "never-called", occurrence: 1, latencyMs: 0, outcome: { kind: "permanent_failure", code: "NOT_READY" } }
    ]);
    expect(() => pending.assertFullyConsumed()).toThrow(/not consumed/i);
  });

  it("reuses a run/tool/version/input/effect-bound side-effect receipt", async () => {
    const clock = new DeterministicClock("2026-01-01T00:00:00.000Z", 0);
    const ids = new DeterministicIdGenerator(9);
    const provider = new DeterministicToolProvider([tool("effect.tool", true)], clock, ids);
    const runId = ids.nextUuid();
    const invocation = {
      runId,
      target: "effect-call",
      toolName: "effect.tool",
      inputHash: "b".repeat(64),
      idempotencyKey: "effect-key",
      capabilities: ["tool_execution", "external_side_effect"] as const,
      allowedTools: ["effect.tool"]
    };
    const first = await provider.invoke(invocation);
    const second = await provider.invoke(invocation);
    expect(second.sideEffectReceipt?.receiptId).toBe(first.sideEffectReceipt?.receiptId);
    expect(second.sideEffectReceipt?.replayed).toBe(true);
    expect(provider.sideEffectExecutionCount()).toBe(1);
  });
});

function tool(name: string, sideEffect: boolean): TestToolDefinition {
  return {
    name,
    version: "1.0.0",
    requiredCapabilities: sideEffect ? ["tool_execution", "external_side_effect"] : ["tool_execution"],
    mutating: sideEffect,
    sideEffect,
    outputArtifactIds: sideEffect ? ["effect-artifact"] : ["analysis-artifact"],
    outputBytes: 8,
    latencyMs: 0
  };
}
