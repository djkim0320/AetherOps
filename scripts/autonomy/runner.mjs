import { fileURLToPath } from "node:url";
import { rmSync } from "node:fs";
import { basename, resolve } from "node:path";

import { createArtifactWriter, defaultAutonomyOutputRoot } from "./artifacts.mjs";
import { runOfflineVerification } from "./offline.mjs";
import { runLiveVerification } from "./live.mjs";
import { getAutonomyProfile } from "./profiles.mjs";
import { renderAutonomyReport } from "./report.mjs";

export const autonomyRepoRoot = fileURLToPath(new URL("../..", import.meta.url));

export async function runAutonomyVerification(args) {
  const profile = getAutonomyProfile(args.profile);
  const outputRoot = args.outputRoot ?? defaultAutonomyOutputRoot(autonomyRepoRoot, profile.name);
  const artifacts = createArtifactWriter(outputRoot);
  const result = {
    schemaVersion: 2,
    profile: profile.name,
    startedAt: new Date().toISOString(),
    finishedAt: undefined,
    verdict: "FAIL",
    runtime: undefined,
    offline: undefined,
    cases: [],
    infrastructureFailures: []
  };
  const context = {
    repoRoot: autonomyRepoRoot,
    outputRoot,
    runtimeRoot: resolve(autonomyRepoRoot, ".tmp", "autonomy-runtime", basename(outputRoot)),
    dataRoot: args.dataRoot ? resolve(args.dataRoot) : undefined,
    timeoutMs: args.timeoutMs,
    npm: process.platform === "win32" ? "npm.cmd" : "npm"
  };
  try {
    if (profile.live) {
      const live = await runLiveVerification(context, profile, artifacts);
      result.runtime = live.runtime;
      result.cases = live.cases;
      result.infrastructureFailures.push(...live.infrastructureFailures);
    } else {
      result.offline = await runOfflineVerification(context);
    }
  } catch (error) {
    result.infrastructureFailures.push(error instanceof Error ? error.message : String(error));
  }
  if (!args.keepRuntime) rmSync(context.runtimeRoot, { recursive: true, force: true });
  result.finishedAt = new Date().toISOString();
  result.verdict = verdict(result);
  artifacts.json("autonomy-report.json", result);
  artifacts.text("autonomy-report.md", renderAutonomyReport(result));
  artifacts.manifest({ profile: profile.name, verdict: result.verdict });
  return { exitCode: result.verdict === "PASS" ? 0 : 1, outputRoot, result };
}

function verdict(result) {
  if (result.infrastructureFailures.length) return "INFRASTRUCTURE_FAILURE";
  if (result.offline) return result.offline.checks.every((item) => item.passed) ? "PASS" : "FAIL";
  if (!result.cases.length || result.cases.some((item) => !item.passed)) return "FAIL";
  const recall = aggregate(result.cases, "toolRecall");
  const precision = aggregate(result.cases, "toolPrecision");
  return recall >= 0.95 && precision >= 0.9 ? "PASS" : "FAIL";
}

function aggregate(cases, key) {
  const measured = cases.map((item) => item[key]).filter((value) => Number.isFinite(value));
  return measured.reduce((sum, value) => sum + value, 0) / Math.max(1, measured.length);
}
