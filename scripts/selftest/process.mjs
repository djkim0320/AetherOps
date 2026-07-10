import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { parseArgs } from "./args.mjs";
import { collectEnvironment } from "./environment.mjs";
import { prepareDataRoot, validateArtifactsAndDb } from "./migration.mjs";
import { runBlockedPath, runLivePath, runServerVerify, runUiVerify, startServer, stopServer, assessLiveGate, assertPortSafe } from "./rpc.mjs";
import { runGrepChecks, runMetadataVerify, runStaticChecks } from "./static.mjs";
import { runSecurityHarness, validateUtf8 } from "./security.mjs";
import { findFreePort, repoRoot, selfTestRpcToken } from "./runtime.mjs";
import { verdict, writeReport } from "./report.mjs";

export async function runSelfTest(rawArgs) {
  const packageJson = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
  const args = parseArgs(rawArgs);
  const context = createContext(args, packageJson);

  try {
    collectEnvironment(context);
    await prepareDataRoot(context);
    runStaticChecks(context);
    runGrepChecks(context);
    runMetadataVerify(context);

    const requestedPort = context.args.port !== undefined ? Number(context.args.port) : await findFreePort();
    await assertPortSafe(context, requestedPort);
    await startServer(context, requestedPort);
    await runServerVerify(context);

    const liveGate = await assessLiveGate(context);
    if (context.mode !== "live") {
      await runBlockedPath(context);
    }
    if (context.mode !== "blocked") {
      if (liveGate.ready) {
        await runLivePath(context);
      } else {
        context.results.livePath = { status: "SKIPPED", reason: liveGate.reason, prerequisites: liveGate.prerequisites };
        if (context.mode === "live" && context.strictLive) {
          context.results.findings.high.push("selftest:live prerequisites are missing and --strict-live was set.");
        } else {
          context.results.findings.medium.push("Live-path E2E skipped because real live provider prerequisites are missing.");
        }
      }
    }

    await validateArtifactsAndDb(context);
    await runSecurityHarness(context);
    await validateUtf8(context);
    await runUiVerify(context);
  } catch (error) {
    context.results.findings.critical.push(error instanceof Error ? error.message : String(error));
  } finally {
    await stopServer(context);
    context.results.finishedAt = new Date().toISOString();
    context.results.verdict = verdict(context);
    writeReport(context);
  }

  console.log(`AetherOps self-test verdict: ${context.results.verdict}`);
  console.log(`Report: ${context.reportPath}`);
  if (context.results.findings.critical.length || context.results.findings.high.length) {
    console.log([...context.results.findings.critical, ...context.results.findings.high].join("\n"));
  }

  const exitCode = context.results.verdict === "FAIL" ? 1 : 0;
  if (context.mode === "live" && context.strictLive && context.results.livePath.status === "SKIPPED") {
    return { exitCode: 1, context };
  }
  return { exitCode, context };
}

function createContext(args, packageJson) {
  const mode = args.mode ?? "full";
  const dataRoot = resolve(args.dataRoot ?? join(repoRoot, ".tmp", "aetherops-selftest"));
  const reportPath = resolve(dataRoot, "self-test-report.md");
  return {
    repoRoot,
    packageJson,
    args,
    mode,
    strictLive: args.strictLive,
    skipStatic: args.skipStatic,
    fullStatic: args.fullStatic,
    dataRoot,
    reportPath,
    npm: process.platform === "win32" ? "npm.cmd" : "npm",
    selfTestRpcToken,
    results: createResults(dataRoot),
    serverProcess: undefined
  };
}

function createResults(dataRoot) {
  return {
    startedAt: new Date().toISOString(),
    environment: {},
    staticChecks: [],
    grepChecks: [],
    server: {},
    settings: {},
    toolDiagnostics: {},
    toolPreflight: {},
    uiVerify: { status: "SKIPPED" },
    metadataVerify: { status: "SKIPPED" },
    blockedPath: { status: "SKIPPED" },
    livePath: { status: "SKIPPED" },
    artifacts: {},
    security: {},
    utf8: {},
    findings: { critical: [], high: [], medium: [], low: [] },
    recommendations: [],
    dataRoot
  };
}
