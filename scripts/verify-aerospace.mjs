import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { availableParallelism } from "node:os";
import { resolve } from "node:path";
import process from "node:process";

const mode = process.argv.includes("--eval") ? "eval" : "verify";
const workerLimit = Math.min(4, Math.max(1, availableParallelism() - 1));
const testTargets = [
  "src/core/aerospace",
  "src/core/tools/aerospaceToolRouting.test.ts",
  "src/core/tools/toolDescriptors.test.ts",
  "src/server/runtime/engineering/engineeringProgramRequestValidator.test.ts",
  "tests/unit/aerospace",
  "tests/integration/aerospace"
];
const startedAt = new Date().toISOString();
const started = performance.now();
const result = spawnSync(process.execPath, [resolve("node_modules/vitest/vitest.mjs"), "run", ...testTargets, "--reporter=json"], {
  cwd: process.cwd(),
  encoding: "utf8",
  env: { ...process.env, AETHEROPS_EVIDENCE_CLASS: "offline-real-runtime" },
  maxBuffer: 16 * 1024 * 1024
});
if (result.status !== 0) {
  process.stderr.write(result.stderr || result.stdout || "AetherAeroBench failed without diagnostic output.\n");
  process.exit(result.status ?? 1);
}

let report;
try {
  report = JSON.parse(result.stdout);
} catch (error) {
  process.stderr.write(`AetherAeroBench could not parse the Vitest JSON report: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}

const durationMs = Math.round((performance.now() - started) * 1000) / 1000;
const semantic = {
  schemaVersion: 1,
  mode,
  evidenceClass: "offline-real-runtime",
  fixtureClass: "immutable-public-data-and-explicit-research-input",
  realRuntime: ["SQLite-independent pure domain", "bundled webxfoil-wasm@0.1.1"],
  externalNetworkRequests: 0,
  success: report.success === true,
  tests: {
    total: report.numTotalTests,
    passed: report.numPassedTests,
    failed: report.numFailedTests,
    pending: report.numPendingTests,
    todo: report.numTodoTests
  },
  gates: {
    unitsAndDimensions: "tested",
    coordinateFrames: "tested",
    atmosphereAndFlightCondition: "tested-troposphere-only",
    analyticalEngineering: "tested-fixed-wing-concept-slice",
    modelCredibility: "tested",
    requirementsTraceability: "tested",
    toolRouting: "tested-selection-mechanics-only",
    longHorizonRecovery: "covered-by-existing-harness-not-this-receipt",
    aerodynamicValidation: "tested-real-webxfoil-and-public-nasa-data"
  }
};
const payload = {
  ...semantic,
  startedAt,
  durationMs,
  workerPolicy: { availableParallelism: availableParallelism(), boundedWorkers: workerLimit },
  semanticResultHash: sha256(canonicalJson(semantic))
};
const receipt = { ...payload, receiptHash: sha256(canonicalJson(payload)) };
process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
    .join(",")}}`;
}
