import { describe, expect, it } from "vitest";
import {
  AETHERBENCH_A0727F2_FIXTURE_SUBJECT,
  AetherBenchReportSchema,
  TraceEventTypeSchema,
  createDefaultCasePlans,
  createDefaultEvalCases,
  replayTrace,
  runDeterministicAetherBench
} from "./public.js";

describe("deterministic AetherBench", () => {
  it("runs nine non-held-out suites as deterministic evidence without claiming product success", async () => {
    const report = await runDeterministicAetherBench({ subject: AETHERBENCH_A0727F2_FIXTURE_SUBJECT });

    expect(AetherBenchReportSchema.parse(report)).toEqual(report);
    expect(report.runs).toHaveLength(9);
    expect(new Set(report.runs.map((run) => run.suite))).toEqual(new Set(createDefaultEvalCases().map((evalCase) => evalCase.suite)));
    expect(createDefaultEvalCases().some((evalCase) => evalCase.suite === "research-agent" || evalCase.classification === "held_out")).toBe(false);
    expect(createDefaultCasePlans().some((plan) => plan.caseId.includes("research-agent"))).toBe(false);
    expect(report.aggregate.verdict).toBe("passed");
    expect(report.evidenceClass).toBe("deterministic_test_runtime");
    expect(report.productionSuccessEligible).toBe(false);
    expect(report.productOutcome).toBe("not_evaluated");
    expect(report.runs.every((run) => !run.productionSuccessEligible && run.productOutcome === "not_evaluated")).toBe(true);
    expect(report.aggregate.classificationCounts).toMatchObject({ seed: 4, held_out: 0, adversarial: 3, regression: 2 });
    expect(new Set(report.traces.flatMap((trace) => trace.events.map((event) => event.type)))).toEqual(new Set(TraceEventTypeSchema.options));
    const injectionRun = report.runs.find((run) => run.suite === "tool-output-injection")!;
    const injectionTrace = report.traces.find((trace) => trace.runId === injectionRun.id)!;
    expect(injectionTrace.events.some((event) => event.type === "tool.call.rejected" && event.data.reasonCode === "injection_detected")).toBe(true);
    expect(injectionTrace.events.some((event) => event.type === "tool.selected" && event.data.toolName === "dangerous.decoy")).toBe(false);
    const freshnessRun = report.runs.find((run) => run.suite === "memory-freshness")!;
    const freshnessTrace = report.traces.find((trace) => trace.runId === freshnessRun.id)!;
    const invalidationIndex = freshnessTrace.events.findIndex((event) => event.type === "memory.revalidated" && !event.data.valid);
    expect(invalidationIndex).toBeGreaterThanOrEqual(0);
    expect(freshnessTrace.events.slice(invalidationIndex + 1).some((event) => event.type === "tool.call.proposed" && event.data.mutating)).toBe(false);
    expect(report.runs.find((run) => run.suite === "long-horizon-resume")!.metrics.restartRecovered.value).toBe(true);
    expect(report.aggregate.metrics.scriptedRestartRecoveryRate).toMatchObject({ value: 1, sampleCount: 1 });
    expect(report.aggregate.metrics.duplicateSideEffects).toMatchObject({ value: 0, sampleCount: 3 });
    expect(report.runs.find((run) => run.suite === "tool-discovery")!.metrics.duplicateSideEffects.value).toBeNull();

    const conflictRun = report.runs.find((run) => run.suite === "multi-agent-conflict")!;
    const conflictTrace = report.traces.find((trace) => trace.runId === conflictRun.id)!;
    const firstCompletion = conflictTrace.events.findIndex((event) => event.type === "work_order.completed");
    const creations = conflictTrace.events.filter((event) => event.type === "work_order.created");
    expect(creations).toHaveLength(2);
    expect(creations.every((event) => !event.data.readOnly && conflictTrace.events.indexOf(event) < firstCompletion)).toBe(true);
    const conflictReplay = await replayTrace(conflictTrace.events);
    expect(conflictReplay.canonicalState.workOrders).toContainEqual(
      expect.objectContaining({
        workOrderId: "work-overlap",
        scopeKeys: ["file-a"],
        dependencyWorkOrderIds: [],
        outcome: "blocked",
        reasonCode: "WRITE_SCOPE_CONFLICT",
        conflictingWorkOrderId: "work-write-owner"
      })
    );
  });

  it("produces identical canonical hashes for identical inputs under bounded concurrency", async () => {
    const [single, multi] = await Promise.all([
      runDeterministicAetherBench({ subject: AETHERBENCH_A0727F2_FIXTURE_SUBJECT, concurrency: 1 }),
      runDeterministicAetherBench({ subject: AETHERBENCH_A0727F2_FIXTURE_SUBJECT, concurrency: 4 })
    ]);

    expect(multi.canonicalReportHash).toBe(single.canonicalReportHash);
    expect(multi.runs.map((run) => run.trace.canonicalStateHash)).toEqual(single.runs.map((run) => run.trace.canonicalStateHash));
  });
});
