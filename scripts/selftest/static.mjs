import { join } from "node:path";

import { PRODUCTION_ADAPTER_PATHS, PRODUCTION_ADAPTER_PATTERN, hasForbiddenProductionAdapterLine, scanTextForPattern } from "../lib/checks.mjs";
import { runTimed, sampleOutput } from "./runtime.mjs";

export function describeStaticMode(context) {
  if (context.skipStatic) return "skipped (--skip-static)";
  if (context.mode === "live" && !context.fullStatic) return "build only (live default)";
  return "typecheck + test + build";
}

export function runStaticChecks(context) {
  if (context.skipStatic) {
    context.results.staticChecks.push({ label: "static checks", exitCode: 0, seconds: 0, skipped: true, reason: "--skip-static" });
    return;
  }
  if (context.mode !== "live" || context.fullStatic) {
    context.results.staticChecks.push(runTimed(context.npm, ["run", "typecheck"], "npm run typecheck"));
    context.results.staticChecks.push(runTimed(context.npm, ["test"], "npm test"));
  }
  context.results.staticChecks.push(runTimed(context.npm, ["run", "build"], "npm run build"));
  for (const check of context.results.staticChecks) {
    if (check.exitCode !== 0) {
      context.results.findings.critical.push(`${check.label} failed with exit code ${check.exitCode}.`);
    }
  }
}

export function runGrepChecks(context) {
  const checks = [
    {
      label: "production synthetic-substitute adapters",
      pattern: PRODUCTION_ADAPTER_PATTERN,
      paths: PRODUCTION_ADAPTER_PATHS,
      passWhen: (result) =>
        result.exitCode !== 0 || !hasForbiddenProductionAdapterLine(result.stdout, /README\.md:.*(policy|synthetic|substitute|adapter|none)/i)
    },
    {
      label: "legacy RPC dispatch removed",
      pattern: /AETHEROPS_ENABLE_LEGACY_RPC|\bopencode\.run\b|\brag\.buildContext\b|\bresults\.derive\b|\breports\.finalize\b/,
      paths: ["src/server"],
      passWhen: (result) => result.exitCode !== 0
    },
    {
      label: "legacy RPC endpoint is hard 404",
      requirements: [
        { pattern: /url\.pathname\.startsWith\(["']\/api\/["']\)/, paths: ["src/server/webServer.ts"] },
        { pattern: /sendJson\(response, 404, \{ ok: false, error: ["']Not found\.["'] \}\)/, paths: ["src/server/webServer.ts"] }
      ]
    },
    {
      label: "canonical API v2 endpoint",
      pattern: /["'`]\/api\/v2\/rpc["'`]/,
      paths: ["src/server"],
      passWhen: (result) => result.exitCode === 0
    },
    {
      label: "API LLM input removed",
      pattern: /openCodeLlm[^\n]*(?:apiKey|source\s*===\s*["']api)|encryptedApiKey/,
      paths: ["src/core", "src/server"],
      passWhen: (result) => result.exitCode !== 0
    },
    {
      label: "WebSearchTool no evidence policy",
      requirements: [
        { pattern: /class WebSearchTool/, paths: ["src/server/runtime/tools/webSearchTool.ts"] },
        { pattern: /evidence:\s*\[\]/, paths: ["src/server/runtime/tools/webSearchTool.ts"] }
      ]
    },
    {
      label: "ProjectContextSnapshot enforcement",
      pattern: /ProjectContextSnapshot|buildContextFromProjectContext/,
      paths: ["src/core/orchestration/orchestrator.ts", "src/core/retrieval/hybridRetrievalEngine.ts", "src/core/retrieval/projectContextBuilder.ts"],
      passWhen: (result) => result.exitCode === 0
    },
    {
      label: "DataAnalysis tool input availability",
      requirements: [
        { pattern: /input\.normalizedRecords/, paths: ["src/core/tools/dataAnalysisTool.ts"] },
        { pattern: /input\.validationResults/, paths: ["src/core/tools/dataAnalysisTool.ts"] },
        { pattern: /input\.projectContextSnapshots/, paths: ["src/core/tools/dataAnalysisTool.ts"] },
        {
          pattern: /normalizedRecords:\s*snapshot\.normalizedRecords/,
          paths: ["src/core/orchestration/executionOrchestrator.ts"]
        },
        {
          pattern: /validationResults:\s*snapshot\.validationResults/,
          paths: ["src/core/orchestration/executionOrchestrator.ts"]
        },
        {
          pattern: /projectContextSnapshots:\s*snapshot\.projectContextSnapshots/,
          paths: ["src/core/orchestration/executionOrchestrator.ts"]
        }
      ]
    },
    {
      label: "WebFetch hardening markers",
      requirements: [
        { pattern: /class PublicUrlPolicy/, paths: ["src/server/runtime/tools/publicUrlPolicy.ts"] },
        { pattern: /assertPublicHttpUrl/, paths: ["src/server/runtime/tools/boundedHttpClient.ts"] },
        { pattern: /AbortController/, paths: ["src/server/runtime/tools/boundedHttpClient.ts"] },
        { pattern: /content-length/, paths: ["src/server/runtime/tools/boundedHttpClient.ts"] },
        { pattern: /body read timeout/, paths: ["src/server/runtime/tools/boundedHttpClient.ts"] },
        { pattern: /::ffff/, paths: ["src/server/runtime/tools/publicUrlPolicy.ts"] },
        { pattern: /0xfc00|0xfe80|0xff00/, paths: ["src/server/runtime/tools/publicUrlPolicy.ts"] }
      ]
    },
    { label: "rawText sanitization markers", pattern: /rawText/, paths: ["scripts", "src/server", "src/core"], passWhen: (result) => result.exitCode === 0 },
    {
      label: "old previous-evidence WebFetch message removed",
      pattern: /requires at least one external source URL from previous evidence/,
      paths: ["src"],
      passWhen: (result) => result.exitCode !== 0
    }
  ];
  for (const check of checks) {
    const { result, passed } = evaluateGrepCheck(check);
    context.results.grepChecks.push({ label: check.label, exitCode: result.exitCode, passed, sample: sampleOutput(result.stdout || result.stderr) });
    if (!passed) context.results.findings.high.push(`Grep invariant failed: ${check.label}.`);
  }
}

function evaluateGrepCheck(check) {
  if (check.requirements) {
    const outputs = [];
    let passed = true;
    for (const requirement of check.requirements) {
      const matches = scanTextForPattern(requirement.pattern, requirement.paths);
      if (matches.length === 0) passed = false;
      outputs.push(...matches);
    }
    return {
      passed,
      result: { exitCode: passed ? 0 : 1, stdout: outputs.join("\n"), stderr: "" }
    };
  }
  const matches = scanTextForPattern(check.pattern, check.paths);
  const result = { exitCode: matches.length ? 0 : 1, stdout: matches.join("\n"), stderr: "" };
  return { result, passed: check.passWhen(result) };
}

export function runMetadataVerify(context) {
  if (context.mode !== "live") {
    context.results.metadataVerify = { status: "SKIPPED", reason: "manual/nightly live mode only" };
    return;
  }
  const check = runTimed(
    process.execPath,
    [join(context.repoRoot, "scripts", "research-metadata-verify.mjs"), "--query", "Clark Y airfoil", "--max-results", "5", "--timeout-ms", "30000"],
    "npm run metadata:verify",
    90_000
  );
  context.results.metadataVerify = {
    status: check.exitCode === 0 ? "PASS" : "FAIL",
    exitCode: check.exitCode,
    signal: check.signal,
    timedOut: check.timedOut,
    seconds: check.seconds,
    stdout: check.stdout,
    stderr: check.stderr
  };
  if (check.exitCode !== 0) {
    context.results.findings.high.push("Live OpenAlex metadata verification failed.");
  }
}
