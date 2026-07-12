import { readFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { pathToFileURL } from "node:url";

import { scoreAutonomyFixture } from "./scorer.mjs";
import { runCommand } from "./process.mjs";
import { sha256File } from "./artifacts.mjs";

const BASELINE_SHA256 = "cdf47c6e86993064c6863ca8f2fd7531ff30ae3d15fc6ee98aede59fc876ea72";

const OFFLINE_TESTS = [
  "tests/contract/autonomyBaseline.test.ts",
  "tests/integration/autonomyStorageWorker.integration.test.ts",
  "tests/integration/engineering/engineeringProgram.integration.test.ts",
  "src/core/tools/sourceAccessPolicy.test.ts",
  "tests/integration/tools/webFetch.security.integration.test.ts",
  "src/server/composition/durableJobRuntime.test.ts",
  "src/server/composition/durableToolExecutionAdapter.test.ts",
  "src/server/runtime/engineering/engineeringProgramRequestValidator.test.ts"
];

export async function runOfflineVerification(context) {
  const fixturePath = join(context.repoRoot, "tests", "fixtures", "autonomy", "gpt-5.6-sol-high-baseline.json");
  const fixtureHash = sha256File(fixturePath);
  if (fixtureHash !== BASELINE_SHA256) throw new Error(`Immutable autonomy baseline hash mismatch: ${fixtureHash}`);
  const fixture = JSON.parse(readFileSync(fixturePath, "utf8"));
  const baseline = scoreAutonomyFixture(fixture);
  if (baseline.passedCases !== 0 || baseline.totalCases !== 2) throw new Error("Immutable baseline no longer represents the measured 0/2 failure baseline.");

  const guard = join(context.repoRoot, "scripts", "autonomy", "offline-network-guard.mjs");
  const existingNodeOptions = process.env.NODE_OPTIONS?.trim();
  const nodeOptions = [`--import=${pathToFileURL(guard).href}`, existingNodeOptions].filter(Boolean).join(" ");
  const testRun = await runCommand(
    process.execPath,
    [join(context.repoRoot, "node_modules", "vitest", "vitest.mjs"), "run", ...OFFLINE_TESTS, "--reporter=dot"],
    {
      cwd: context.repoRoot,
      timeoutMs: context.timeoutMs ?? 300_000,
      env: {
        ...process.env,
        NODE_OPTIONS: nodeOptions,
        AETHEROPS_OFFLINE_VERIFY: "1",
        CODEX_HOME: join(context.runtimeRoot, "offline-codex-home"),
        PATH: withoutCodexPath(process.env.PATH ?? "")
      }
    }
  );
  return {
    fixtureHash,
    baseline,
    checks: [{ id: "offline-real-runtime-suite", passed: testRun.exitCode === 0, result: testRun }]
  };
}

function withoutCodexPath(pathValue) {
  return pathValue
    .split(delimiter)
    .filter((entry) => !/(?:^|[\\/])codex(?:[\\/]|$)/i.test(entry))
    .join(delimiter);
}
