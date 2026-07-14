import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { verifyHistoricalBaseline } from "../../scripts/harness/baseline.mjs";
import { verifyHeldOutFixturePair } from "../../scripts/harness/fixtures.mjs";
import * as harness from "../../src/core/testing/harness/public.js";

const repoRoot = process.cwd();

describe("AetherBench compiled CLI surface", () => {
  it("exposes verify and eval commands that build and execute the single harness wrapper", () => {
    const packageJson = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));

    expect(packageJson.scripts["harness:verify"]).toBe(
      "npm run server:build && node scripts/verify-m1-server-restart.mjs && node scripts/verify-harness.mjs verify"
    );
    expect(packageJson.scripts["harness:eval"]).toBe("npm run server:build && node scripts/verify-harness.mjs eval");
    const wrapperPath = join(repoRoot, "scripts", "verify-harness.mjs");
    expect(existsSync(wrapperPath)).toBe(true);
    expect(existsSync(join(repoRoot, "scripts", "verify-m1-server-restart.mjs"))).toBe(true);
    const wrapper = readFileSync(wrapperPath, "utf8");
    expect(wrapper).toContain("executionCases: verifiedFixtures.executionCases");
    expect(wrapper).toContain("oracles: verifiedFixtures.oracles");
    expect(wrapper).not.toContain("heldOutExecutionInputs");
    expect(wrapper).not.toContain("heldOutEvaluatorOracles");
    expect(wrapper).toContain('"INCOMPLETE_A0727F2_BASELINE"');
    expect(wrapper).toContain('"HARNESS_MECHANICS_NOT_PASSING"');
    expect(wrapper).toContain('m0ReleaseReadiness: releaseBlockers.length === 0 && harnessPassed ? "READY" : "BLOCKED"');
    expect(wrapper).toContain('tokenUsage: { value: null, unit: "tokens", unmeasuredReason }');
    expect(wrapper).not.toContain("modelUsage");
  });

  it("includes the core harness in the compiled server graph without compiling the legacy synthetic harness", () => {
    const tsconfig = JSON.parse(readFileSync(join(repoRoot, "tsconfig.server.json"), "utf8"));

    expect(tsconfig.exclude).not.toContain("src/core/testing/**");
    expect(tsconfig.exclude).toContain("src/core/testing/orchestratorTestHarness.ts");
  });

  it("keeps the a0727f2 historical failure baseline explicitly ineligible as product success", () => {
    const manifestPath = join(repoRoot, "tests", "fixtures", "harness", "baseline", "a0727f2", "manifest.json");
    expect(existsSync(manifestPath)).toBe(true);

    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    expect(manifest).toMatchObject({
      baselineAnchorCommit: "a0727f2d5846b53717847ff908c411c24ab29d80",
      baselineKind: "offline_anchor_with_historical_scorer_reproduction",
      baselineVerdict: "PARTIAL_RECORDED",
      measurementCompleteness: false,
      missingMetrics: expect.arrayContaining(["retries", "latencyMs", "restartRecovery"]),
      productVerdict: "NOT_EVALUATED",
      productionSuccessEligible: false
    });
    expect(manifest.historicalFixture).toMatchObject({ sourceCommit: null, sourceCommitReason: expect.any(String) });
    expect(manifest.historicalScorerReproduction.evaluator).toMatchObject({
      id: "autonomy-scorer",
      version: "1",
      sha256: "e50beccc1e4ea39cf43243ead209f5af241528b38c996568a7e9d98f6845d447"
    });
    for (const metric of Object.values(manifest.historicalScorerReproduction.metrics) as Array<Record<string, unknown>>) {
      if (metric.value === null) expect(metric.reason).toEqual(expect.any(String));
    }

    const verified = verifyHistoricalBaseline(repoRoot);
    expect(verified).toMatchObject({
      baselineVerdict: "COMPLETE_CAPTURED",
      measurementCompleteness: true,
      missingMetrics: [],
      evidenceClass: "deterministic_instrumented_legacy_runtime",
      productionSuccessEligible: false,
      deterministicLegacyCapture: {
        receiptCount: 22,
        productionSuccessEligible: false,
        metrics: { invalidArgumentRate: { numerator: 1, denominator: 5, unit: "validated_arguments" } }
      }
    });
    expect(verified.historicalFixture.score).toMatchObject({
      passedCases: 0,
      totalCases: 2,
      toolPrecision: 0.777778,
      toolRecall: 1,
      hardViolationCount: 7
    });
  });

  it("partitions every initial suite across non-empty seed, held-out, adversarial, and regression fixtures", () => {
    const directories = ["seed", "held-out", "adversarial", "regression"];
    const manifests = directories.map((directory) =>
      JSON.parse(readFileSync(join(repoRoot, "tests", "fixtures", "harness", directory, "manifest.json"), "utf8"))
    );
    const cases = manifests.flatMap((manifest) => manifest.cases);

    expect(manifests.every((manifest) => manifest.cases.length > 0)).toBe(true);
    expect(new Set(cases.map((entry) => entry.id)).size).toBe(10);
    expect(new Set(cases.map((entry) => entry.suite))).toEqual(
      new Set([
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
      ])
    );
    expect(manifests.find((manifest) => manifest.classification === "held_out")?.executionInputContainsAcceptanceOracle).toBe(false);
  });

  it("hash-binds a held-out execution payload that contains no evaluator oracle", () => {
    const root = join(repoRoot, "tests", "fixtures", "harness", "held-out");
    const manifest = JSON.parse(readFileSync(join(root, "manifest.json"), "utf8"));
    const executionPath = join(repoRoot, manifest.executionInput.path);
    const oraclePath = join(repoRoot, manifest.evaluatorOracle.path);
    const providerPlanPath = join(repoRoot, manifest.deterministicProviderPlan.path);
    const executionRaw = readFileSync(executionPath, "utf8");
    const oracleRaw = readFileSync(oraclePath, "utf8");
    const providerPlanRaw = readFileSync(providerPlanPath, "utf8");
    const execution = JSON.parse(executionRaw);
    const oracle = JSON.parse(oracleRaw);
    const providerPlan = JSON.parse(providerPlanRaw);

    expect(statSync(executionPath).size).toBe(manifest.executionInput.bytes);
    expect(createHash("sha256").update(executionRaw).digest("hex")).toBe(manifest.executionInput.sha256);
    expect(statSync(oraclePath).size).toBe(manifest.evaluatorOracle.bytes);
    expect(createHash("sha256").update(oracleRaw).digest("hex")).toBe(manifest.evaluatorOracle.sha256);
    expect(statSync(providerPlanPath).size).toBe(manifest.deterministicProviderPlan.bytes);
    expect(createHash("sha256").update(providerPlanRaw).digest("hex")).toBe(manifest.deterministicProviderPlan.sha256);
    expect(collectKeys(execution).filter((key) => /acceptance|expected|rubric|oracle|grader/i.test(key))).toEqual([]);
    expect(collectKeys(providerPlan).filter((key) => /acceptance|expected|rubric|oracle|grader/i.test(key))).toEqual([]);
    expect(execution.id).toBe(oracle.caseId);
    expect(execution).toMatchObject({
      classification: "held_out",
      taskContract: { id: "task.research-agent.v1", contentHash: expect.stringMatching(/^[a-f0-9]{64}$/) }
    });
    expect(execution).not.toHaveProperty("heldOutExecutionFixtureHash");
    expect(oracle).toMatchObject({ expectedOutcome: "passed", deterministicAcceptanceCriteria: expect.any(Array) });
    expect(oracle).not.toHaveProperty("heldOutOracleFixtureHash");
    expect(providerPlan).toMatchObject({ schemaVersion: 1, caseId: execution.id });
  });

  it("treats a separately hashed schema-valid oracle as authoritative instead of comparing it with seed-case oracle code", () => {
    const sourceRoot = join(repoRoot, "tests", "fixtures", "harness", "held-out");
    const execution = JSON.parse(readFileSync(join(sourceRoot, "execution-input.json"), "utf8"));
    const oracle = { ...JSON.parse(readFileSync(join(sourceRoot, "evaluator-oracle.json"), "utf8")), expectedOutcome: "failed" };
    const temporaryParent = join(repoRoot, ".tmp", "harness-contract");
    mkdirSync(temporaryParent, { recursive: true });
    const temporaryRoot = mkdtempSync(join(temporaryParent, "oracle-boundary-"));
    try {
      const executionRaw = `${JSON.stringify(execution, null, 2)}\n`;
      const oracleRaw = `${JSON.stringify(oracle, null, 2)}\n`;
      writeFileSync(join(temporaryRoot, "execution.json"), executionRaw, "utf8");
      writeFileSync(join(temporaryRoot, "oracle.json"), oracleRaw, "utf8");
      const boundary = verifyHeldOutFixturePair(
        temporaryRoot,
        {
          executionInput: descriptor("execution.json", executionRaw),
          evaluatorOracle: descriptor("oracle.json", oracleRaw)
        },
        harness
      );

      expect(boundary.evalCase.classification).toBe("held_out");
      expect(boundary.oracle.expectedOutcome).toBe("failed");
      expect(boundary.executionCase).not.toHaveProperty("expectedOutcome");
    } finally {
      rmSync(temporaryRoot, { recursive: true, force: true });
    }
  });
});

function descriptor(path: string, raw: string) {
  return { path, sha256: createHash("sha256").update(raw).digest("hex"), bytes: Buffer.byteLength(raw) };
}

function collectKeys(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(collectKeys);
  if (!value || typeof value !== "object") return [];
  return Object.entries(value).flatMap(([key, entry]) => [key, ...collectKeys(entry)]);
}
