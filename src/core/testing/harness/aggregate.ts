import type { EvalCase, EvalRun } from "./evalSchemas.js";
import type { AetherBenchAggregate } from "./reportSchemas.js";

type NumericMetricKey = "durationMs" | "contextTokens" | "retries" | "invalidArguments" | "duplicateSideEffects" | "totalToolOutputBytes";

export function aggregateRuns(cases: EvalCase[], runs: EvalRun[]): AetherBenchAggregate {
  const matchedExpectedOutcome = runs.filter((run) => run.result === run.expectedOutcome).length;
  const classifications = { seed: 0, held_out: 0, adversarial: 0, regression: 0 };
  for (const evalCase of cases) classifications[evalCase.classification] += 1;
  const toolCriterionIds = new Set(
    cases.flatMap((evalCase) =>
      evalCase.deterministicAcceptanceCriteria
        .filter((criterion) => criterion.kind === "tool_selected" || criterion.kind === "tool_not_selected" || criterion.kind === "tool_verified")
        .map((criterion) => `${evalCase.id}:${criterion.id}`)
    )
  );
  const toolResults = runs.flatMap((run) => run.acceptanceResults.filter((result) => toolCriterionIds.has(`${run.caseId}:${result.criterionId}`)));
  const longHorizonRuns = runs.filter((run) => run.suite === "long-horizon-resume");
  return {
    evidenceClass: "deterministic_test_runtime",
    productOutcome: "not_evaluated",
    verdict: matchedExpectedOutcome === runs.length ? "passed" : "failed",
    totalCases: runs.length,
    matchedExpectedOutcome,
    classificationCounts: classifications,
    metrics: {
      deterministicSuccessRate: measured(runs.filter((run) => run.result === "passed").length / runs.length, "deterministic_ratio", runs.length),
      deterministicToolSelectionAccuracy: toolResults.length
        ? measured(toolResults.filter((result) => result.passed).length / toolResults.length, "deterministic_ratio", toolResults.length)
        : unmeasured("deterministic_ratio", "No tool-selection criteria were present."),
      invalidArguments: sumMetric(runs, "invalidArguments", "arguments"),
      retries: sumMetric(runs, "retries", "retries"),
      duplicateSideEffects: sumMetric(runs, "duplicateSideEffects", "effects"),
      contextTokens: sumMetric(runs, "contextTokens", "tokens"),
      totalToolOutputBytes: sumMetric(runs, "totalToolOutputBytes", "bytes"),
      totalLatencyMs: sumMetric(runs, "durationMs", "ms"),
      scriptedRestartRecoveryRate: longHorizonRuns.length
        ? measured(
            longHorizonRuns.filter((run) => run.metrics.restartRecovered.value === true).length / longHorizonRuns.length,
            "deterministic_ratio",
            longHorizonRuns.length
          )
        : unmeasured("deterministic_ratio", "No long-horizon deterministic case was present."),
      humanInterventions: measured(runs.filter((run) => run.metrics.humanIntervention.value === true).length, "interventions", runs.length)
    }
  };
}

function sumMetric(
  runs: EvalRun[],
  key: NumericMetricKey,
  unit: string
): { value: number | null; unit: string; sampleCount?: number; unmeasuredReason?: string } {
  const measuredValues = runs.flatMap((run) => {
    const value = run.metrics[key].value;
    return value === null ? [] : [value];
  });
  if (!measuredValues.length) return unmeasured(unit, `No applicable ${key} measurements were available.`);
  return measured(
    measuredValues.reduce((sum, value) => sum + value, 0),
    unit,
    measuredValues.length
  );
}

function measured(value: number, unit: string, sampleCount?: number): { value: number; unit: string; sampleCount?: number } {
  return { value, unit, ...(sampleCount ? { sampleCount } : {}) };
}

function unmeasured(unit: string, unmeasuredReason: string): { value: null; unit: string; unmeasuredReason: string } {
  return { value: null, unit, unmeasuredReason };
}
