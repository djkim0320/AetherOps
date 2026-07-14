import { existsSync } from "node:fs";
import { availableParallelism } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { createArtifactWriter } from "./autonomy/artifacts.mjs";
import { parseHarnessArgs } from "./harness/args.mjs";
import { verifyHistoricalBaseline } from "./harness/baseline.mjs";
import { verifyPartitionFixtures } from "./harness/fixtures.mjs";
import { writeHarnessArtifacts } from "./harness/output.mjs";
import { readHarnessSubject } from "./harness/subject.mjs";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const args = parseHarnessArgs(process.argv.slice(2), repoRoot);
const artifacts = createArtifactWriter(args.outputRoot);
const startedAt = new Date().toISOString();
let baseline;
let execution;
let partitions;
let harness;
const failures = [];

try {
  baseline = verifyHistoricalBaseline(repoRoot);
  harness = await loadCompiledHarness();
  const defaultCases = harness.createDefaultEvalCases();
  const verifiedFixtures = verifyPartitionFixtures(repoRoot, defaultCases, harness);
  partitions = {
    classifications: verifiedFixtures.classifications,
    cases: verifiedFixtures.cases,
    heldOut: verifiedFixtures.heldOutSummary
  };
  execution = harness.AetherBenchReportSchema.parse(
    await harness.runDeterministicAetherBench({
      executionCases: verifiedFixtures.executionCases,
      oracles: verifiedFixtures.oracles,
      plans: verifiedFixtures.plans,
      capabilities: [...new Set(verifiedFixtures.executionCases.flatMap((candidate) => candidate.environmentCapabilities))],
      subject: await readHarnessSubject(repoRoot),
      concurrency: args.command === "eval" ? boundedConcurrency(verifiedFixtures.executionCases) : 1
    })
  );
} catch (error) {
  failures.push({ code: errorCode(error), message: error instanceof Error ? error.message : String(error) });
}

const finishedAt = new Date().toISOString();
const harnessPassed = execution?.aggregate?.verdict === "passed" && failures.length === 0;
const harnessMechanicsVerdict = harnessPassed ? "PASS" : failures.some((failure) => failure.code === "NOT_READY") ? "NOT_READY" : "FAIL";
const releaseBlockers = [];
if (baseline?.measurementCompleteness !== true) releaseBlockers.push("INCOMPLETE_A0727F2_BASELINE");
if (!harnessPassed) releaseBlockers.push("HARNESS_MECHANICS_NOT_PASSING");
const result = {
  schemaVersion: 1,
  command: args.command,
  startedAt,
  finishedAt,
  evidenceClass: "deterministic_test_runtime",
  harnessVerdict: harnessMechanicsVerdict,
  harnessMechanicsVerdict,
  m0ReleaseReadiness: releaseBlockers.length === 0 && harnessPassed ? "READY" : "BLOCKED",
  releaseBlockers,
  productVerdict: "NOT_EVALUATED",
  productionSuccessEligible: false,
  baseline: baseline ?? unavailableBaseline(),
  partitions: partitions ?? { classifications: [], cases: [] },
  aggregate: execution?.aggregate,
  canonicalReportHash: execution?.canonicalReportHash,
  runs: decorateRuns(execution?.runs ?? [], partitions?.cases ?? []),
  unmeasuredMetrics: productionMetricsNotMeasured(),
  failures
};
const events = exportEvents(execution?.traces ?? [], partitions?.cases ?? [], result.runs);
try {
  await writeHarnessArtifacts(artifacts, result, events, harness);
  console.log(`AetherBench ${args.command}: ${result.harnessVerdict} (product ${result.productVerdict})`);
  console.log(`Artifacts: ${args.outputRoot}`);
  process.exitCode = harnessPassed ? 0 : 1;
} catch (error) {
  console.error(`AetherBench ${args.command}: FAIL (artifact verification: ${error instanceof Error ? error.message : String(error)})`);
  process.exitCode = 1;
}

async function loadCompiledHarness() {
  const path = join(repoRoot, "dist-server", "core", "testing", "harness", "public.js");
  if (!existsSync(path))
    throw codedError("NOT_READY", "Compiled AetherBench public module is missing. Run the server build without excluding core/testing/harness.");
  const harness = await import(pathToFileURL(path).href);
  for (const name of [
    "createDefaultEvalCases",
    "createDefaultCasePlans",
    "runDeterministicAetherBench",
    "createEvalExecutionCase",
    "createEvalOracle",
    "assembleEvalCase",
    "assertOracleFreeExecutionPayload"
  ]) {
    if (typeof harness[name] !== "function") throw codedError("NOT_READY", `Compiled AetherBench public export is missing: ${name}`);
  }
  if (typeof harness.AetherBenchReportSchema?.parse !== "function") throw codedError("NOT_READY", "Compiled AetherBench report schema export is missing.");
  if (typeof harness.DeterministicCasePlanSchema?.parse !== "function")
    throw codedError("NOT_READY", "Compiled deterministic case-plan schema export is missing.");
  return harness;
}

function exportEvents(traces, indexedCases, runs) {
  const runById = new Map(runs.map((run) => [run.id, run]));
  return traces.flatMap((trace) => {
    const run = runById.get(trace.runId);
    const indexed = indexedCases.find((entry) => entry.id === trace.caseId);
    return trace.events.map((event) => ({ schemaVersion: 1, classification: indexed?.classification, caseId: trace.caseId, seed: run?.seed, event }));
  });
}

function decorateRuns(runs, indexedCases) {
  return runs.map((run) => ({ ...run, classification: indexedCases.find((entry) => entry.id === run.caseId)?.classification ?? "unknown" }));
}

function boundedConcurrency(cases) {
  const caseBudget = Math.min(...cases.map((candidate) => candidate.budget.maxConcurrency));
  return Math.min(8, Math.max(1, availableParallelism() - 1), cases.length, caseBudget);
}

function errorCode(error) {
  return typeof error?.code === "string" ? error.code : "HARNESS_FAILURE";
}

function codedError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function productionMetricsNotMeasured() {
  const unmeasuredReason = "The default harness uses a deterministic test runtime; live-provider and production-runtime behavior were not evaluated.";
  return {
    successRate: { value: null, unit: "ratio", unmeasuredReason },
    toolSelectionPrecision: { value: null, unit: "ratio", unmeasuredReason },
    latencyMs: { value: null, unit: "ms", unmeasuredReason },
    tokenUsage: { value: null, unit: "tokens", unmeasuredReason },
    estimatedCostUsd: { value: null, unit: "usd", unmeasuredReason },
    humanIntervention: { value: null, unit: "boolean", unmeasuredReason }
  };
}

function unavailableBaseline() {
  return {
    anchorCommit: "a0727f2d5846b53717847ff908c411c24ab29d80",
    historicalFixture: {
      sourceCommit: null,
      sourceCommitReason: "Baseline verification failed before provenance could be read.",
      path: "tests/fixtures/autonomy/gpt-5.6-sol-high-baseline.json",
      score: { passedCases: null, totalCases: null }
    },
    baselineVerdict: "PARTIAL_RECORDED",
    measurementCompleteness: false,
    missingMetrics: ["baselineVerification"],
    productVerdict: "NOT_EVALUATED",
    productionSuccessEligible: false
  };
}
