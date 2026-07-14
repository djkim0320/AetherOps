import { existsSync, lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";

import { sha256File } from "../autonomy/artifacts.mjs";

const PARTITIONS = ["seed", "held_out", "adversarial", "regression"];
const REQUIRED_SUITES = new Set([
  "tool-discovery",
  "tool-composition",
  "long-horizon-resume",
  "memory-scope",
  "memory-freshness",
  "tool-output-injection",
  "engineering-agent",
  "research-agent",
  "multi-agent-conflict",
  "idempotent-side-effects"
]);

export function verifyPartitionFixtures(repoRoot, defaultEvalCases, harness) {
  assertHarnessBoundary(harness);
  const indexed = [];
  let heldOutBoundary;
  for (const classification of PARTITIONS) {
    const path = join(repoRoot, "tests", "fixtures", "harness", classification.replace("_", "-"), "manifest.json");
    const manifest = JSON.parse(readFileSync(path, "utf8"));
    assert(manifest.schemaVersion === 1 && manifest.classification === classification, `Partition manifest mismatch: ${classification}`);
    assert(Array.isArray(manifest.cases) && manifest.cases.length > 0, `Partition must contain at least one case: ${classification}`);
    if (classification === "held_out") {
      assert(manifest.executionInputContainsAcceptanceOracle === false, "Held-out execution input must not contain its acceptance oracle.");
      assert(manifest.providerPlanContainsAcceptanceOracle === false, "Held-out provider plan must not contain its acceptance oracle.");
      heldOutBoundary = verifyHeldOutBoundary(repoRoot, manifest, harness);
    }
    for (const entry of manifest.cases) indexed.push({ ...entry, classification });
  }

  const indexedIds = indexed.map((entry) => entry.id);
  assert(new Set(indexedIds).size === indexedIds.length, "A harness case is indexed in more than one partition.");
  assert(heldOutBoundary, "Held-out execution/oracle boundary is missing.");
  assert(!defaultEvalCases.some((candidate) => candidate.id === heldOutBoundary.evalCase.id), "Held-out case must not be compiled into visible default cases.");
  const evalCases = [...defaultEvalCases, heldOutBoundary.evalCase];
  assert(indexed.length === evalCases.length, "Partition index and compiled-plus-held-out case counts differ.");
  assert(REQUIRED_SUITES.size === indexed.length, "Initial AetherBench suite count differs from the required ten suites.");
  for (const suite of REQUIRED_SUITES)
    assert(
      indexed.some((entry) => entry.suite === suite),
      `Required harness suite is missing: ${suite}`
    );
  for (const evalCase of evalCases) {
    const entry = indexed.find((candidate) => candidate.id === evalCase.id);
    assert(entry, `Compiled harness case is absent from the partition index: ${evalCase.id}`);
    assert(entry.suite === evalCase.suite, `Harness suite mismatch: ${evalCase.id}`);
    assert(entry.caseVersion === evalCase.caseVersion, `Harness case version mismatch: ${evalCase.id}`);
    assert(entry.classification === evalCase.classification, `Harness classification mismatch: ${evalCase.id}`);
    for (const fixture of evalCase.inputFixtures ?? []) verifyInputFixture(repoRoot, evalCase.id, fixture, evalCase.classification === "held_out");
  }
  const executionCases = [...defaultEvalCases.map((evalCase) => harness.createEvalExecutionCase(evalCase)), heldOutBoundary.executionCase];
  const oracles = [...defaultEvalCases.map((evalCase) => harness.createEvalOracle(evalCase)), heldOutBoundary.oracle];
  const defaultPlans = harness.createDefaultCasePlans();
  assert(!defaultPlans.some((plan) => plan.caseId === heldOutBoundary.evalCase.id), "Held-out provider plan must not be compiled into visible defaults.");
  const plans = [...defaultPlans, heldOutBoundary.plan];
  return {
    classifications: [...PARTITIONS],
    cases: indexed.sort((left, right) => left.id.localeCompare(right.id)),
    heldOutBoundary,
    executionCases,
    oracles,
    plans,
    heldOutSummary: {
      caseId: heldOutBoundary.executionCase.id,
      executionInputSha256: heldOutBoundary.executionInputSha256,
      evaluatorOracleSha256: heldOutBoundary.evaluatorOracleSha256,
      deterministicProviderPlanSha256: heldOutBoundary.deterministicProviderPlanSha256,
      executionInputContainsAcceptanceOracle: false,
      providerPlanContainsAcceptanceOracle: false
    }
  };
}

function verifyHeldOutBoundary(repoRoot, manifest, harness) {
  const pair = verifyHeldOutFixturePair(repoRoot, manifest, harness);
  const providerPlan = readHashedJson(repoRoot, manifest.deterministicProviderPlan, "Held-out deterministic provider plan");
  assertNoOracleKeys(providerPlan.value);
  const plan = harness.DeterministicCasePlanSchema.parse(providerPlan.value);
  assert(plan.caseId === pair.executionCase.id, "Held-out provider plan and execution input target different cases.");
  return { ...pair, plan, deterministicProviderPlanSha256: providerPlan.sha256 };
}

function verifyInputFixture(repoRoot, caseId, fixture, requireOracleFree) {
  const target = resolveRepositoryFile(repoRoot, fixture.relativePath, `Harness input fixture for ${caseId}`);
  assert(statSync(target).size === fixture.bytes, `Harness input fixture byte count mismatch: ${fixture.relativePath}`);
  assert(sha256File(target) === fixture.sha256, `Harness input fixture SHA-256 mismatch: ${fixture.relativePath}`);
  if (requireOracleFree) assertNoOracleKeys(JSON.parse(readFileSync(target, "utf8")));
}

export function verifyHeldOutFixturePair(repoRoot, manifest, harness) {
  const execution = readHashedJson(repoRoot, manifest.executionInput, "Held-out execution input");
  const oracle = readHashedJson(repoRoot, manifest.evaluatorOracle, "Held-out evaluator oracle");
  assertNoOracleKeys(execution.value);
  const executionCase = harness.assertOracleFreeExecutionPayload(
    harness.EvalExecutionCaseSchema.parse({ ...execution.value, heldOutExecutionFixtureHash: execution.sha256 })
  );
  const evaluatorOracle = harness.EvalOracleSchema.parse({ ...oracle.value, heldOutOracleFixtureHash: oracle.sha256 });
  const evalCase = harness.assembleEvalCase(executionCase, evaluatorOracle);
  return {
    executionCase,
    oracle: evaluatorOracle,
    evalCase,
    executionInputSha256: execution.sha256,
    evaluatorOracleSha256: oracle.sha256
  };
}

function assertHarnessBoundary(harness) {
  for (const name of ["createEvalExecutionCase", "createEvalOracle", "assembleEvalCase", "assertOracleFreeExecutionPayload", "createDefaultCasePlans"]) {
    assert(typeof harness?.[name] === "function", `Compiled harness boundary export is missing: ${name}`);
  }
  assert(typeof harness?.EvalExecutionCaseSchema?.parse === "function", "Compiled EvalExecutionCaseSchema export is missing.");
  assert(typeof harness?.EvalOracleSchema?.parse === "function", "Compiled EvalOracleSchema export is missing.");
  assert(typeof harness?.DeterministicCasePlanSchema?.parse === "function", "Compiled DeterministicCasePlanSchema export is missing.");
}

function readHashedJson(repoRoot, descriptor, label) {
  assert(descriptor && typeof descriptor.path === "string", `${label} descriptor is missing.`);
  const target = resolveRepositoryFile(repoRoot, descriptor.path, label);
  assert(statSync(target).size === descriptor.bytes, `${label} byte count mismatch.`);
  const sha256 = sha256File(target);
  assert(sha256 === descriptor.sha256, `${label} SHA-256 mismatch.`);
  return { value: JSON.parse(readFileSync(target, "utf8")), sha256 };
}

function assertNoOracleKeys(value, path = "$") {
  if (Array.isArray(value)) return value.forEach((entry, index) => assertNoOracleKeys(entry, `${path}[${index}]`));
  if (!value || typeof value !== "object") return;
  for (const [key, entry] of Object.entries(value)) {
    assert(!/(?:acceptance|expected|rubric|oracle|grader)/i.test(key), `Held-out execution input contains evaluator-only key: ${path}.${key}`);
    assertNoOracleKeys(entry, `${path}.${key}`);
  }
}

function resolveRepositoryFile(repoRoot, path, label) {
  assert(typeof path === "string" && !isAbsolute(path), `${label} path must be repository-relative.`);
  const target = resolve(repoRoot, path);
  const relativePath = relative(repoRoot, target).replace(/\\/g, "/");
  assert(relativePath && relativePath !== ".." && !relativePath.startsWith("../"), `${label} path escapes the repository.`);
  assert(existsSync(target), `${label} is missing: ${path}`);
  assert(!lstatSync(target).isSymbolicLink(), `${label} must not be a symbolic link or junction: ${path}`);
  const realTarget = realpathSync(target);
  assertContained(realpathSync(repoRoot), realTarget, `${label} resolves outside the repository: ${path}`);
  assert(statSync(realTarget).isFile(), `${label} is not a file: ${path}`);
  return realTarget;
}

function assertContained(root, target, message) {
  const relativePath = relative(root, target).replace(/\\/g, "/");
  assert(relativePath && relativePath !== ".." && !relativePath.startsWith("../"), message);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
