import { existsSync, lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";

import { sha256File } from "../autonomy/artifacts.mjs";
import { scoreAutonomyFixture } from "../autonomy/scorer.mjs";
import { verifyBaselineV2 } from "./baseline-v2.mjs";

const ANCHOR_COMMIT = "a0727f2d5846b53717847ff908c411c24ab29d80";

export function verifyHistoricalBaseline(repoRoot) {
  const manifestPath = join(repoRoot, "tests", "fixtures", "harness", "baseline", "a0727f2", "manifest.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  assert(manifest.baselineAnchorCommit === ANCHOR_COMMIT, "Historical baseline anchor commit mismatch.");
  assert(manifest.baselineVerdict === "PARTIAL_RECORDED", "Incomplete historical baseline must remain partial.");
  assert(manifest.measurementCompleteness === false, "Historical baseline must not be represented as measurement-complete.");
  assert(Array.isArray(manifest.missingMetrics) && manifest.missingMetrics.length > 0, "Partial historical baseline requires missing metrics.");
  assert(manifest.productVerdict === "NOT_EVALUATED", "Historical baseline must not be represented as a product verdict.");
  assert(manifest.productionSuccessEligible === false, "Historical baseline must be ineligible as product success.");
  assert(manifest.historicalFixture?.sourceCommit === null, "Unknown historical source commit must remain null.");
  assertText(manifest.historicalFixture?.sourceCommitReason, "Historical source commit requires an unknown-provenance reason.");

  const reproduction = manifest.historicalScorerReproduction;
  const evaluator = reproduction?.evaluator;
  const evaluatorPath = resolveFixturePath(repoRoot, evaluator?.path);
  assert(evaluator?.version === "1", "Historical scorer version mismatch.");
  assert(sha256File(evaluatorPath) === evaluator.sha256, "Historical scorer SHA-256 mismatch.");
  assert(statSync(evaluatorPath).size === evaluator.bytes, "Historical scorer byte count mismatch.");
  const fixture = reproduction?.sourceFixture;
  const fixturePath = resolveFixturePath(repoRoot, fixture?.path);
  assert(sha256File(fixturePath) === fixture.sha256, "Historical autonomy fixture SHA-256 mismatch.");
  assert(statSync(fixturePath).size === fixture.bytes, "Historical autonomy fixture byte count mismatch.");

  const score = scoreAutonomyFixture(JSON.parse(readFileSync(fixturePath, "utf8")));
  const totals = score.cases.reduce(
    (result, item) => ({
      selectedAllowed: result.selectedAllowed + item.selectedAllowed,
      selectedCount: result.selectedCount + item.selectedCount,
      selectedRequired: result.selectedRequired + item.selectedRequired,
      requiredCount: result.requiredCount + item.requiredCount
    }),
    { selectedAllowed: 0, selectedCount: 0, selectedRequired: 0, requiredCount: 0 }
  );
  assert(score.passedCases === 0 && score.totalCases === 2, "Historical autonomy fixture must remain the measured 0/2 failure.");
  assert(score.toolPrecision === 0.777778, "Historical tool-selection precision must remain 7/9.");
  assert(score.toolRecall === 1, "Historical tool-selection recall must remain 7/7.");
  const invalidArguments = score.cases.filter((item) => item.hardViolations.includes("UNGROUNDED_ARGUMENT")).length;
  assert(invalidArguments === 1, "Historical invalid-argument observation must remain one case.");
  assert(score.hardViolationCount === reproduction.observations.hardViolations, "Historical hard-violation count mismatch.");
  assertRatioMetric(reproduction.metrics.successRate, 0, score.passedCases, score.totalCases, "Historical success-rate metric mismatch.");
  assertRatioMetric(
    reproduction.metrics.toolSelectionPrecision,
    score.toolPrecision,
    totals.selectedAllowed,
    totals.selectedCount,
    "Historical precision metric mismatch."
  );
  assertRatioMetric(
    reproduction.metrics.toolSelectionRecall,
    score.toolRecall,
    totals.selectedRequired,
    totals.requiredCount,
    "Historical recall metric mismatch."
  );
  assertMetric(reproduction.metrics.invalidArguments, invalidArguments, "Historical invalid-argument metric mismatch.");
  assert(
    reproduction.metrics.invalidArguments.unit === "observed_cases_lower_bound",
    "Historical invalid-argument metric must remain a case-level lower bound."
  );
  assert(!Object.hasOwn(reproduction.metrics.invalidArguments, "denominator"), "Historical invalid-argument metric must not invent a denominator.");
  assertText(reproduction.metrics.invalidArguments.limitation, "Historical invalid-argument lower bound requires a limitation.");
  assertRatioMetric(reproduction.metrics.exactCaseAccuracy, 0, score.passedCases, score.totalCases, "Historical exact-case metric mismatch.");
  assertUnmeasuredReasons(reproduction.metrics);
  const historical = {
    anchorCommit: manifest.baselineAnchorCommit,
    baselineKind: manifest.baselineKind,
    evidenceClass: manifest.evidenceClass,
    baselineVerdict: manifest.baselineVerdict,
    measurementCompleteness: false,
    missingMetrics: manifest.missingMetrics,
    productVerdict: manifest.productVerdict,
    productionSuccessEligible: false,
    executedBaselineCommands: manifest.executedBaselineCommands,
    historicalFixture: {
      sourceCommit: null,
      sourceCommitReason: manifest.historicalFixture.sourceCommitReason,
      evaluator: { id: evaluator.id, version: evaluator.version, sha256: evaluator.sha256 },
      path: fixture.path,
      sha256: fixture.sha256,
      bytes: fixture.bytes,
      score,
      metrics: reproduction.metrics
    }
  };
  const deterministicLegacy = verifyBaselineV2(repoRoot);
  if (!deterministicLegacy) return historical;
  return {
    ...historical,
    baselineKind: deterministicLegacy.baselineKind,
    evidenceClass: deterministicLegacy.evidenceClass,
    baselineVerdict: "COMPLETE_CAPTURED",
    measurementCompleteness: true,
    missingMetrics: [],
    deterministicLegacyCapture: {
      evidenceClass: deterministicLegacy.evidenceClass,
      baseTree: deterministicLegacy.baseTree,
      capturedAt: deterministicLegacy.capturedAt,
      receiptCount: deterministicLegacy.receiptCount,
      metrics: deterministicLegacy.metrics,
      productionSuccessEligible: false
    }
  };
}

function resolveFixturePath(repoRoot, path) {
  assertText(path, "Historical fixture path is required.");
  assert(!isAbsolute(path), "Historical fixture path must be repository-relative.");
  const target = resolve(repoRoot, path);
  const relativePath = relative(repoRoot, target);
  assert(
    relativePath && relativePath !== ".." && !relativePath.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`),
    "Historical fixture path escapes the repository."
  );
  assert(existsSync(target), `Historical fixture path is missing: ${path}`);
  assert(!lstatSync(target).isSymbolicLink(), `Historical fixture path must not be a symbolic link or junction: ${path}`);
  const realRoot = realpathSync(repoRoot);
  const realTarget = realpathSync(target);
  const realRelative = relative(realRoot, realTarget).replace(/\\/g, "/");
  assert(realRelative && realRelative !== ".." && !realRelative.startsWith("../"), `Historical fixture path resolves outside the repository: ${path}`);
  assert(statSync(realTarget).isFile(), `Historical fixture path is not a file: ${path}`);
  return realTarget;
}

function assertUnmeasuredReasons(metrics) {
  assert(metrics && typeof metrics === "object", "Historical scorer metrics are required.");
  for (const [name, metric] of Object.entries(metrics)) {
    assert(metric && typeof metric === "object" && Object.hasOwn(metric, "value"), `Historical metric is malformed: ${name}`);
    if (metric.value === null) assertText(metric.reason, `Unmeasured metric requires a reason: ${name}`);
  }
}

function assertMetric(metric, expected, message) {
  assert(metric?.value === expected, message);
}

function assertRatioMetric(metric, value, numerator, denominator, message) {
  assert(metric?.value === value && metric.numerator === numerator && metric.denominator === denominator, message);
}

function assertText(value, message) {
  assert(typeof value === "string" && value.trim().length > 0, message);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
