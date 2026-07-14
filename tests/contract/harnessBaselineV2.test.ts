import { createHash } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  BASELINE_V2_BASE_COMMIT,
  BASELINE_V2_BASE_TREE,
  BASELINE_V2_DIRECTORY,
  BASELINE_V2_EVIDENCE_CLASS,
  BASELINE_V2_LOCK_SHA256,
  BASELINE_V2_NODE_DISTRIBUTION_SHA256,
  BASELINE_V2_NODE_VERSION,
  buildBaselineV2Manifest,
  runnerBundleSha256,
  verifyBaselineV2
} from "../../scripts/harness/baseline-v2.mjs";

const repositoryRoot = process.cwd();
const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("AetherBench exact-base baseline v2 receipts", () => {
  it("derives a measurement-complete result while remaining ineligible as product evidence", () => {
    const fixture = createVerifierFixture();

    const verified = verifyBaselineV2(fixture.root);

    expect(verified).toMatchObject({
      baselineAnchorCommit: BASELINE_V2_BASE_COMMIT,
      evidenceClass: BASELINE_V2_EVIDENCE_CLASS,
      measurementCompleteness: true,
      productVerdict: "NOT_EVALUATED",
      productionSuccessEligible: false,
      receiptCount: fixture.receipts.length
    });
    expect(verified?.metrics.invalidArgumentRate).toMatchObject({ numerator: 1, denominator: 4, value: 0.25 });
    expect(verified?.metrics.restartRecovery.value).toBe(true);
  });

  it("rejects an operator-edited metric scalar", () => {
    const fixture = createVerifierFixture();
    const manifest = readJson(fixture.manifestFile);
    const metrics = manifest.metrics as Record<string, Record<string, unknown>>;
    metrics.successRate!.value = 1;
    writeJson(fixture.manifestFile, manifest);

    expect(() => verifyBaselineV2(fixture.root)).toThrow(/metrics do not match receipt-derived metrics/i);
  });

  it("rejects a receipt whose measured value changed without a matching receipt hash", () => {
    const fixture = createVerifierFixture();
    const rows = fixture.receipts.map((row) => ({ ...row }));
    const attempt = rows.find((row) => row.type === "tool_attempt");
    if (!attempt) throw new Error("Test fixture is missing a tool attempt.");
    attempt.canonicalOutputBytes = Number(attempt.canonicalOutputBytes) + 1;
    const receiptsFile = join(dirname(fixture.manifestFile), "receipts.jsonl");
    writeReceipts(receiptsFile, rows);
    rewriteDescriptor(fixture.manifestFile, "receipts", receiptsFile);

    expect(() => verifyBaselineV2(fixture.root)).toThrow(/receipt hash mismatch/i);
  });

  it("rejects absolute local paths before accepting the manifest", () => {
    const fixture = createVerifierFixture();
    const manifest = readJson(fixture.manifestFile);
    manifest.operatorPath = "C:\\Users\\operator\\capture.json";
    writeJson(fixture.manifestFile, manifest);

    expect(() => verifyBaselineV2(fixture.root)).toThrow(/absolute path/i);
  });
});

function createVerifierFixture() {
  const parent = join(repositoryRoot, ".tmp", "harness-contract");
  mkdirSync(parent, { recursive: true });
  const root = mkdtempSync(join(parent, "baseline-v2-verifier-"));
  temporaryRoots.push(root);
  copyRunnerBundle(root);
  copyHistoricalFixture(root);
  const captureRoot = join(root, "capture");
  mkdirSync(captureRoot, { recursive: true });
  const receipts = baselineReceipts(root);
  writeReceipts(join(captureRoot, "receipts.jsonl"), receipts);
  writeJson(join(captureRoot, "capture-run.json"), {
    schemaVersion: 2,
    evidenceClass: BASELINE_V2_EVIDENCE_CLASS,
    productVerdict: "NOT_EVALUATED",
    productionSuccessEligible: false,
    scenarioCount: 2,
    receiptCount: receipts.length,
    captureStatus: "completed"
  });
  const manifest = buildBaselineV2Manifest(root, captureRoot, { capturedAt: "2026-07-14T00:00:00.000Z" });
  const fixtureRoot = join(root, BASELINE_V2_DIRECTORY);
  mkdirSync(fixtureRoot, { recursive: true });
  cpSync(join(captureRoot, "receipts.jsonl"), join(fixtureRoot, "receipts.jsonl"));
  cpSync(join(captureRoot, "capture-run.json"), join(fixtureRoot, "capture-run.json"));
  const manifestFile = join(fixtureRoot, "manifest.json");
  writeJson(manifestFile, manifest);
  return { root, manifestFile, receipts };
}

function baselineReceipts(root: string): Array<Record<string, unknown>> {
  let sequence = 0;
  const add = (type: string, fields: Record<string, unknown>) => {
    sequence += 1;
    const body = { schemaVersion: 2, id: `receipt-${String(sequence).padStart(4, "0")}`, type, ...fields };
    return { ...body, receiptHash: sha256(canonicalJson(body)) };
  };
  const rows = [
    add("capture_environment", {
      baseCommit: BASELINE_V2_BASE_COMMIT,
      baseTree: BASELINE_V2_BASE_TREE,
      packageLockSha256: BASELINE_V2_LOCK_SHA256,
      nodeVersion: BASELINE_V2_NODE_VERSION,
      nodeExecutableSha256: "a".repeat(64),
      nodeDistributionSha256: BASELINE_V2_NODE_DISTRIBUTION_SHA256,
      npmVersion: "10.9.2",
      runnerBundleSha256: runnerBundleSha256(root),
      networkMode: "blocked",
      providerMode: "deterministic"
    }),
    add("adapter_descriptor", { adapterKind: "model", adapterVersion: "verifier-test-v1", liveProviderCalled: false }),
    add("adapter_descriptor", { adapterKind: "tool", adapterVersion: "verifier-test-v1", liveProviderCalled: false }),
    add("fault_injection", {
      scenarioId: "clark-y-webxfoil-remote",
      faultId: "verifier-test-fault",
      targetTool: "EngineeringProgramTool",
      expectedTerminalStatus: "failed"
    }),
    add("fake_clock", { clockVersion: "verifier-test-clock-v1", epoch: "2026-07-14T00:00:00.000Z", monotonic: true })
  ];
  for (const [index, scenarioId] of ["official-url-bounded", "clark-y-webxfoil-remote"].entries()) {
    rows.push(
      add("llm_invocation", {
        scenarioId,
        logicalCallId: `${scenarioId}:llm:1`,
        schemaName: "AetherOpsResearchPlan",
        inputHash: String(index + 1).repeat(64),
        inputBytes: 100 + index,
        benchmarkContextTokens: 20 + index,
        tokenizerVersion: "unicode-segments-v1",
        candidateOutputHash: String(index + 7).repeat(64),
        candidateOutputBytes: 80 + index,
        retryOf: null
      }),
      add("planning_validation", {
        scenarioId,
        logicalCallId: `${scenarioId}:plan-validation:1`,
        schemaName: "AetherOpsResearchPlan",
        candidateOutputHash: String(index + 7).repeat(64),
        candidateOutputBytes: 80 + index,
        argumentValid: index === 0,
        accepted: index === 0,
        rejectionClass: index === 0 ? null : "STRICT_PLAN_REJECTED",
        rejectionHash: index === 0 ? null : "e".repeat(64)
      }),
      add("tool_attempt", {
        scenarioId,
        logicalCallId: `${scenarioId}:tool:1`,
        attemptNumber: 1,
        retryOf: null,
        toolName: "WebFetchTool",
        ordinal: 1,
        status: index === 0 ? "completed" : "failed",
        inputHash: String(index + 3).repeat(64),
        outputHash: String(index + 5).repeat(64),
        canonicalOutputBytes: 256 + index,
        argumentValid: true
      }),
      add("scenario_result", {
        scenarioId,
        expectedTools: ["WebFetchTool"],
        selectedTools: ["WebFetchTool"],
        terminalStatus: index === 0 ? "completed" : "failed",
        passed: index === 0,
        deterministicLatencyMs: 25 + index
      }),
      add("human_intervention", { scenarioId, eventCount: 0 }),
      add("restart_readback", { scenarioId, storageKind: "legacy-sqlite", exactReadbackMatched: true, semanticProjectionHash: "f".repeat(64) })
    );
  }
  rows.push(
    add("side_effect", {
      scenarioId: "durable-restart-probe",
      logicalCallId: "durable-restart-probe:effect:1",
      effectKey: "durable-idempotency-effect-v1",
      committed: true
    }),
    add("durable_restart_readback", {
      scenarioId: "durable-restart-probe",
      storageKind: "sqlite-worker",
      beforeStatus: "completed",
      afterStatus: "completed",
      projectRevision: 1,
      exactTerminalReadbackMatched: true,
      idempotencyReused: true,
      handlerExecutions: 1
    }),
    add("network_observation", { observedRequestCount: 0, guardMode: "verifier-test" })
  );
  return rows;
}

function copyRunnerBundle(root: string): void {
  for (const name of ["adapters.ts", "durableProbe.ts", "receiptRuntime.ts", "runner.ts"]) {
    const relative = join("scripts", "harness", "legacy-baseline", name);
    mkdirSync(dirname(join(root, relative)), { recursive: true });
    cpSync(join(repositoryRoot, relative), join(root, relative));
  }
}

function copyHistoricalFixture(root: string): void {
  const relative = join("tests", "fixtures", "autonomy", "gpt-5.6-sol-high-baseline.json");
  mkdirSync(dirname(join(root, relative)), { recursive: true });
  cpSync(join(repositoryRoot, relative), join(root, relative));
}

function rewriteDescriptor(manifestFile: string, key: string, file: string): void {
  const manifest = readJson(manifestFile);
  const files = manifest.files as Record<string, unknown>;
  files[key] = { file: file.split(/[\\/]/).at(-1), sha256: sha256(readFileSync(file)), bytes: statSync(file).size };
  writeJson(manifestFile, manifest);
}

function writeReceipts(file: string, rows: Array<Record<string, unknown>>): void {
  writeFileSync(file, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`, "utf8");
}

function readJson(file: string): Record<string, unknown> {
  return JSON.parse(readFileSync(file, "utf8"));
}

function writeJson(file: string, value: unknown): void {
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, sortValue(entry)])
  );
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}
