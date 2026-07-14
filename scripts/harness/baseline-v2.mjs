import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";

export const BASELINE_V2_DIRECTORY = "tests/fixtures/harness/baseline/a0727f2-v2";
export const BASELINE_V2_BASE_COMMIT = "a0727f2d5846b53717847ff908c411c24ab29d80";
export const BASELINE_V2_BASE_TREE = "f30864f7fae5fd91bb3d0f9daf1f11d38cba35aa";
export const BASELINE_V2_LOCK_SHA256 = "560af8aebd6ae79d3e2f77cc79192553773d10a431e201908a0d553f7b17ca13";
export const BASELINE_V2_NODE_VERSION = "v22.16.0";
export const BASELINE_V2_NODE_DISTRIBUTION_SHA256 = "21c2d9735c80b8f86dab19305aa6a9f6f59bbc808f68de3eef09d5832e3bfbbd";
export const BASELINE_V2_EVIDENCE_CLASS = "deterministic_instrumented_legacy_runtime";

const HISTORICAL_FIXTURE = "tests/fixtures/autonomy/gpt-5.6-sol-high-baseline.json";
const HISTORICAL_FIXTURE_SHA256 = "cdf47c6e86993064c6863ca8f2fd7531ff30ae3d15fc6ee98aede59fc876ea72";
const RUNNER_FILES = [
  "scripts/harness/legacy-baseline/adapters.ts",
  "scripts/harness/legacy-baseline/durableProbe.ts",
  "scripts/harness/legacy-baseline/receiptRuntime.ts",
  "scripts/harness/legacy-baseline/runner.ts"
];
const REQUIRED_SCENARIOS = ["clark-y-webxfoil-remote", "official-url-bounded"];
const REQUIRED_METRICS = [
  "successRate",
  "toolSelectionAccuracy",
  "invalidArgumentRate",
  "retries",
  "duplicateSideEffects",
  "contextTokens",
  "totalToolOutputBytes",
  "latencyMs",
  "restartRecovery",
  "humanIntervention"
];

export function verifyBaselineV2(repoRoot) {
  const root = resolve(repoRoot, BASELINE_V2_DIRECTORY);
  if (!existsSync(join(root, "manifest.json"))) return undefined;
  const manifest = readSafeJson(repoRoot, join(root, "manifest.json"));
  assertSafeArtifact(manifest);
  assert(manifest.schemaVersion === 2, "Baseline v2 manifest schema mismatch.");
  assert(manifest.baselineAnchorCommit === BASELINE_V2_BASE_COMMIT, "Baseline v2 commit mismatch.");
  assert(manifest.baseTree === BASELINE_V2_BASE_TREE, "Baseline v2 tree mismatch.");
  assert(manifest.packageLockSha256 === BASELINE_V2_LOCK_SHA256, "Baseline v2 lock hash mismatch.");
  assert(manifest.evidenceClass === BASELINE_V2_EVIDENCE_CLASS, "Baseline v2 evidence class mismatch.");
  assert(manifest.productVerdict === "NOT_EVALUATED" && manifest.productionSuccessEligible === false, "Baseline v2 cannot claim product success.");
  assert(manifest.measurementCompleteness === true && manifest.missingMetrics?.length === 0, "Baseline v2 must be measurement-complete.");
  assertGitTree(repoRoot);

  const receiptsFile = resolveCaptureFile(repoRoot, root, manifest.files?.receipts, "receipts.jsonl");
  const captureRunFile = resolveCaptureFile(repoRoot, root, manifest.files?.captureRun, "capture-run.json");
  const receiptsRaw = readFileSync(receiptsFile, "utf8");
  const captureRun = JSON.parse(readFileSync(captureRunFile, "utf8"));
  assertSafeArtifact(captureRun);
  assert(captureRun.evidenceClass === BASELINE_V2_EVIDENCE_CLASS, "Capture-run evidence class mismatch.");
  assert(captureRun.productVerdict === "NOT_EVALUATED" && captureRun.productionSuccessEligible === false, "Capture run cannot claim product success.");
  const receipts = parseAndVerifyReceipts(receiptsRaw);
  const computed = computeBaselineV2Metrics(receipts);
  assert(canonicalJson(manifest.metrics) === canonicalJson(computed), "Baseline v2 metrics do not match receipt-derived metrics.");
  assert(
    REQUIRED_METRICS.every((name) => Object.hasOwn(manifest.metrics, name)),
    "Baseline v2 is missing a required metric."
  );

  const environment = one(receipts, "capture_environment");
  assert(environment.baseCommit === BASELINE_V2_BASE_COMMIT && environment.baseTree === BASELINE_V2_BASE_TREE, "Capture environment base provenance mismatch.");
  assert(environment.packageLockSha256 === BASELINE_V2_LOCK_SHA256, "Capture environment lock mismatch.");
  assert(environment.nodeVersion === BASELINE_V2_NODE_VERSION, "Capture did not use pinned Node 22.16.0.");
  assert(environment.nodeDistributionSha256 === BASELINE_V2_NODE_DISTRIBUTION_SHA256, "Portable Node distribution hash mismatch.");
  assert(environment.networkMode === "blocked" && environment.providerMode === "deterministic", "Capture environment was not provider-free.");
  assert(environment.runnerBundleSha256 === runnerBundleSha256(repoRoot), "Baseline runner bundle drifted.");
  assert(manifest.runtime?.nodeExecutableSha256 === environment.nodeExecutableSha256, "Runtime executable hash is not receipt-bound.");
  assert(manifest.runnerBundleSha256 === environment.runnerBundleSha256, "Manifest runner hash mismatch.");
  assert(manifest.historicalLiveFailure?.sha256 === HISTORICAL_FIXTURE_SHA256, "Historical live failure fixture hash mismatch.");
  assert(sha256File(resolve(repoRoot, HISTORICAL_FIXTURE)) === HISTORICAL_FIXTURE_SHA256, "Historical live failure fixture drifted.");
  assertRequiredEvidence(receipts);
  return {
    ...manifest,
    metrics: computed,
    receiptCount: receipts.length,
    captureRun
  };
}

export function buildBaselineV2Manifest(repoRoot, captureRoot, metadata) {
  const receiptsFile = resolve(captureRoot, "receipts.jsonl");
  const captureRunFile = resolve(captureRoot, "capture-run.json");
  const receipts = parseAndVerifyReceipts(readFileSync(receiptsFile, "utf8"));
  const captureRun = JSON.parse(readFileSync(captureRunFile, "utf8"));
  assertSafeArtifact(captureRun);
  assertRequiredEvidence(receipts);
  const environment = one(receipts, "capture_environment");
  assert(environment.baseCommit === BASELINE_V2_BASE_COMMIT && environment.baseTree === BASELINE_V2_BASE_TREE, "Capture environment base provenance mismatch.");
  assert(environment.packageLockSha256 === BASELINE_V2_LOCK_SHA256, "Capture environment lock mismatch.");
  assert(environment.nodeVersion === BASELINE_V2_NODE_VERSION, "Capture runner did not use pinned Node.");
  assert(environment.nodeDistributionSha256 === BASELINE_V2_NODE_DISTRIBUTION_SHA256, "Capture runner distribution hash mismatch.");
  assert(environment.networkMode === "blocked" && environment.providerMode === "deterministic", "Capture runner was not provider-free.");
  assert(environment.runnerBundleSha256 === runnerBundleSha256(repoRoot), "Capture runner bundle hash mismatch.");
  return {
    schemaVersion: 2,
    baselineAnchorCommit: BASELINE_V2_BASE_COMMIT,
    baseTree: BASELINE_V2_BASE_TREE,
    packageLockSha256: BASELINE_V2_LOCK_SHA256,
    baselineKind: "exact_base_deterministic_instrumented_legacy_runtime",
    evidenceClass: BASELINE_V2_EVIDENCE_CLASS,
    capturedAt: metadata.capturedAt,
    measurementCompleteness: true,
    missingMetrics: [],
    productVerdict: "NOT_EVALUATED",
    productionSuccessEligible: false,
    runtime: {
      nodeVersion: environment.nodeVersion,
      nodeExecutableSha256: environment.nodeExecutableSha256,
      nodeDistributionSha256: environment.nodeDistributionSha256,
      npmVersion: environment.npmVersion
    },
    runnerBundleSha256: environment.runnerBundleSha256,
    files: {
      receipts: descriptor(receiptsFile, "receipts.jsonl"),
      captureRun: descriptor(captureRunFile, "capture-run.json")
    },
    historicalLiveFailure: {
      evidenceClass: "historical_live_failure_unknown_source",
      file: HISTORICAL_FIXTURE,
      sha256: HISTORICAL_FIXTURE_SHA256,
      productionSuccessEligible: false
    },
    metrics: computeBaselineV2Metrics(receipts)
  };
}

export function computeBaselineV2Metrics(receipts) {
  const scenarios = receiptsOf(receipts, "scenario_result");
  const attempts = receiptsOf(receipts, "tool_attempt");
  const planningValidations = receiptsOf(receipts, "planning_validation");
  const invocations = receiptsOf(receipts, "llm_invocation");
  const effects = receiptsOf(receipts, "side_effect").filter((row) => row.committed === true);
  const restart = [...receiptsOf(receipts, "restart_readback"), ...receiptsOf(receipts, "durable_restart_readback")];
  const interventions = receiptsOf(receipts, "human_intervention");
  const passed = scenarios.filter((row) => row.passed === true).length;
  let selectedCorrect = 0;
  let selectedUnion = 0;
  for (const row of scenarios) {
    const expected = new Set(row.expectedTools);
    const selected = new Set(row.selectedTools);
    selectedCorrect += [...expected].filter((tool) => selected.has(tool)).length;
    selectedUnion += new Set([...expected, ...selected]).size;
  }
  const argumentObservations = [...planningValidations, ...attempts];
  const invalid = argumentObservations.filter((row) => row.argumentValid === false).length;
  const retries = [...attempts, ...invocations].filter((row) => row.retryOf !== null).length;
  const effectCounts = new Map();
  for (const row of effects) effectCounts.set(row.effectKey, (effectCounts.get(row.effectKey) ?? 0) + 1);
  const duplicates = [...effectCounts.values()].reduce((total, count) => total + Math.max(0, count - 1), 0);
  return {
    successRate: ratioMetric(passed, scenarios.length, "ratio", ids(scenarios)),
    toolSelectionAccuracy: ratioMetric(selectedCorrect, selectedUnion, "jaccard_ratio", ids(scenarios)),
    invalidArgumentRate: ratioMetric(invalid, argumentObservations.length, "validated_arguments", ids(argumentObservations)),
    retries: countMetric(retries, "retries", ids([...attempts, ...invocations])),
    duplicateSideEffects: countMetric(duplicates, "effects", ids(effects)),
    contextTokens: countMetric(sum(invocations, "benchmarkContextTokens"), "benchmark_tokens", ids(invocations)),
    totalToolOutputBytes: countMetric(sum(attempts, "canonicalOutputBytes"), "bytes", ids(attempts)),
    latencyMs: countMetric(sum(scenarios, "deterministicLatencyMs"), "logical_ms", ids(scenarios)),
    restartRecovery: booleanMetric(restart.every(restartPassed), ids(restart)),
    humanIntervention: countMetric(sum(interventions, "eventCount"), "events", ids(interventions))
  };
}

export function runnerBundleSha256(repoRoot) {
  const files = RUNNER_FILES.map((file) => ({ file, sha256: sha256File(resolve(repoRoot, file)) }));
  return sha256(canonicalJson(files));
}

function parseAndVerifyReceipts(raw) {
  assert(Buffer.byteLength(raw, "utf8") <= 2_097_152, "Baseline receipts exceed the 2 MiB limit.");
  const receipts = raw
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  assert(receipts.length > 0 && receipts.length <= 1_000, "Baseline receipt count is invalid.");
  const seen = new Set();
  for (const receipt of receipts) {
    assertSafeArtifact(receipt);
    assert(receipt.schemaVersion === 2 && typeof receipt.id === "string" && typeof receipt.type === "string", "Malformed baseline receipt.");
    assert(!seen.has(receipt.id), `Duplicate baseline receipt: ${receipt.id}`);
    seen.add(receipt.id);
    const { receiptHash, ...body } = receipt;
    assert(receiptHash === sha256(canonicalJson(body)), `Baseline receipt hash mismatch: ${receipt.id}`);
  }
  return receipts;
}

function assertRequiredEvidence(receipts) {
  const scenarios = receiptsOf(receipts, "scenario_result");
  const planningValidations = receiptsOf(receipts, "planning_validation");
  const planInvocations = receiptsOf(receipts, "llm_invocation").filter((row) => row.schemaName === "AetherOpsResearchPlan");
  assert(
    canonicalJson(scenarios.map((row) => row.scenarioId).sort()) === canonicalJson(REQUIRED_SCENARIOS),
    "Baseline scenarios do not match the historical pair."
  );
  assert(receiptsOf(receipts, "llm_invocation").every(validInvocation), "Invalid LLM measurement receipt.");
  assert(
    canonicalJson(planningValidations.map((row) => row.scenarioId).sort()) === canonicalJson(REQUIRED_SCENARIOS) &&
      planningValidations.every(validPlanningValidation),
    "Invalid planning-validation receipt."
  );
  for (const validation of planningValidations) {
    const origins = planInvocations.filter((row) => row.scenarioId === validation.scenarioId);
    assert(
      origins.length === 1 &&
        origins[0].candidateOutputHash === validation.candidateOutputHash &&
        origins[0].candidateOutputBytes === validation.candidateOutputBytes,
      "Planning validation is not linked to exactly one hash-bound plan candidate."
    );
  }
  assert(
    planningValidations.find((row) => row.scenarioId === "official-url-bounded")?.accepted === true &&
      planningValidations.find((row) => row.scenarioId === "clark-y-webxfoil-remote")?.accepted === false,
    "Baseline planning outcomes do not match the observed exact-base scenarios."
  );
  assert(receiptsOf(receipts, "tool_attempt").length > 0 && receiptsOf(receipts, "tool_attempt").every(validAttempt), "Invalid tool attempt receipt.");
  assert(receiptsOf(receipts, "restart_readback").length === 2, "Each scenario requires a SQLite restart receipt.");
  const durable = one(receipts, "durable_restart_readback");
  assert(restartPassed(durable) && durable.idempotencyReused === true && durable.handlerExecutions === 1, "Durable restart/idempotency receipt failed.");
  assert(receiptsOf(receipts, "human_intervention").length === 2, "Each scenario requires a human-intervention receipt.");
  assert(one(receipts, "network_observation").observedRequestCount === 0, "Baseline capture observed network activity.");
  assert(
    receiptsOf(receipts, "adapter_descriptor").every((row) => row.liveProviderCalled === false),
    "Baseline adapter called a live provider."
  );
  assert(
    receiptsOf(receipts, "fake_clock").length === 1 && receiptsOf(receipts, "fault_injection").length >= 1,
    "Baseline fake-clock/fault evidence is missing."
  );
}

function validInvocation(row) {
  return (
    row.tokenizerVersion === "unicode-segments-v1" &&
    integer(row.benchmarkContextTokens) &&
    integer(row.inputBytes) &&
    integer(row.candidateOutputBytes) &&
    hash(row.inputHash) &&
    hash(row.candidateOutputHash)
  );
}
function validPlanningValidation(row) {
  return (
    typeof row.argumentValid === "boolean" &&
    row.accepted === row.argumentValid &&
    integer(row.candidateOutputBytes) &&
    hash(row.candidateOutputHash) &&
    (row.accepted === true || (row.rejectionClass === "STRICT_PLAN_REJECTED" && hash(row.rejectionHash)))
  );
}
function validAttempt(row) {
  return integer(row.attemptNumber) && integer(row.canonicalOutputBytes) && hash(row.inputHash) && typeof row.argumentValid === "boolean";
}
function restartPassed(row) {
  return row.type === "restart_readback" ? row.exactReadbackMatched === true : row.exactTerminalReadbackMatched === true;
}
function assertSafeArtifact(value, trail = []) {
  if (typeof value === "string") {
    assert(!/(?:bearer\s+[a-z0-9._~+/=-]+|sk-[a-z0-9_-]{8,}|gh[oprsu]_[a-z0-9_]{12,})/i.test(value), "Credential-like text in baseline artifact.");
    assert(!/^[a-z]:[\\/]|^\\\\|^\/(?:users|home|tmp|var|etc)\//i.test(value), "Absolute path in baseline artifact.");
    return;
  }
  if (Array.isArray(value)) return value.forEach((entry, index) => assertSafeArtifact(entry, [...trail, index]));
  if (!value || typeof value !== "object") return;
  for (const [key, entry] of Object.entries(value)) {
    assert(
      !/^(?:prompt|response|content|raw|authorization|cookie|secret|apiKey|accessToken|refreshToken|absolutePath|dataRoot|userFile)$/i.test(key),
      `Forbidden baseline artifact field: ${[...trail, key].join(".")}`
    );
    assertSafeArtifact(entry, [...trail, key]);
  }
}

function resolveCaptureFile(repoRoot, root, file, expected) {
  assert(file?.file === expected, `Baseline capture descriptor must reference ${expected}.`);
  const target = resolve(root, file.file);
  const safe = relative(root, target).replace(/\\/g, "/");
  assert(safe === expected && !isAbsolute(file.file), "Baseline capture file escaped its fixture root.");
  const realRoot = realpathSync(root);
  assert(!lstatSync(target).isSymbolicLink(), "Baseline capture files cannot be symlinks.");
  const realTarget = realpathSync(target);
  assert(relative(realRoot, realTarget).replace(/\\/g, "/") === expected, "Baseline capture file resolved outside its fixture root.");
  assert(statSync(target).size === file.bytes && sha256File(target) === file.sha256, `Baseline capture descriptor mismatch: ${expected}`);
  return target;
}
function readSafeJson(repoRoot, file) {
  const relativeFile = relative(repoRoot, file);
  assert(relativeFile && !relativeFile.startsWith(".."), "Baseline manifest escaped repository.");
  assert(!lstatSync(file).isSymbolicLink(), "Baseline manifest cannot be a symlink.");
  return JSON.parse(readFileSync(file, "utf8"));
}
function assertGitTree(repoRoot) {
  const result = spawnSync("git", ["show", "-s", "--format=%T", BASELINE_V2_BASE_COMMIT], { cwd: repoRoot, encoding: "utf8", windowsHide: true });
  assert(result.status === 0 && result.stdout.trim() === BASELINE_V2_BASE_TREE, "Baseline Git tree is unavailable or mismatched.");
}
function descriptor(file, name) {
  return { file: name, sha256: sha256File(file), bytes: statSync(file).size };
}
function receiptsOf(receipts, type) {
  return receipts.filter((row) => row.type === type);
}
function one(receipts, type) {
  const rows = receiptsOf(receipts, type);
  assert(rows.length === 1, `Baseline requires exactly one ${type} receipt.`);
  return rows[0];
}
function ratioMetric(numerator, denominator, unit, originReceiptIds) {
  assert(denominator > 0, `Cannot derive ${unit} metric without samples.`);
  return { value: Number((numerator / denominator).toFixed(6)), unit, numerator, denominator, originReceiptIds };
}
function countMetric(value, unit, originReceiptIds) {
  return { value, unit, originReceiptIds };
}
function booleanMetric(value, originReceiptIds) {
  return { value, unit: "boolean", originReceiptIds };
}
function ids(rows) {
  return rows.map((row) => row.id).sort();
}
function sum(rows, field) {
  return rows.reduce((total, row) => total + Number(row[field]), 0);
}
function integer(value) {
  return Number.isSafeInteger(value) && value >= 0;
}
function hash(value) {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}
function canonicalJson(value) {
  return JSON.stringify(sortValue(value));
}
function sortValue(value) {
  if (Array.isArray(value)) return value.map(sortValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, entry]) => [key, sortValue(entry)])
  );
}
function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}
function sha256File(file) {
  return sha256(readFileSync(file));
}
function assert(condition, message) {
  if (!condition) throw new Error(message);
}
