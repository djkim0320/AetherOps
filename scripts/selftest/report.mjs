import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import {
  dbSummariesJson,
  evidencePolicyTableRows,
  list,
  requiredPathSummary,
  staticCheckRows,
  grepCheckList,
  table,
  withOptionalMarkdownBom
} from "./report-utils.mjs";
import { sampleOutput } from "./runtime.mjs";

export function verdict(context) {
  if (context.results.findings.critical.length || context.results.findings.high.length) return "FAIL";
  if (context.results.findings.medium.length || (context.mode !== "blocked" && context.results.livePath.status === "SKIPPED")) return "PASS_WITH_WARNINGS";
  return "PASS";
}

export function writeReport(context) {
  mkdirSync(dirname(context.reportPath), { recursive: true });
  const report = renderReport(context);
  const body = withOptionalMarkdownBom(report);
  writeFileSync(context.reportPath, body, "utf8");
}

export function renderReport(context) {
  const data = context.results;
  return `# AetherOps Self-Test Report

Generated: ${new Date().toISOString()}
Data root: \`${context.dataRoot}\`

## 1. Environment

- Node.js: \`${data.environment.nodeVersion}\`
- npm: \`${data.environment.npmVersion}\`
- OS: \`${data.environment.os}\`
- Package engine: \`${data.environment.engine}\`
- Engine check: ${data.environment.engineSatisfied ? "PASS" : "FAIL"}
- Static mode: ${data.environment.staticMode}

## 2. Static Checks

${table(["Check", "Result", "Seconds"], staticCheckRows(data.staticChecks))}

### Grep Invariants

${grepCheckList(data.grepChecks)}

## 3. Server Verification

- Health status: ${data.server.health?.status ?? "not run"}
- Health content type: \`${data.server.health?.contentType ?? "unknown"}\`
- Health body: \`${JSON.stringify(data.server.health?.body ?? {})}\`
- settings.get summary:
  - Codex: \`${data.settings.codex?.model ?? "unknown"}\` / \`${data.settings.codex?.reasoningEffort ?? "unknown"}\`
  - Embedding: provider=\`${data.settings.embedding?.provider ?? "unknown"}\`, apiKeyConfigured=\`${Boolean(data.settings.embedding?.apiKeyConfigured)}\`
  - Web Search: provider=\`${data.settings.search?.provider ?? "unknown"}\`, apiKeyConfigured=\`${Boolean(data.settings.search?.apiKeyConfigured)}\`
  - Agent capability: \`${Boolean(data.settings.capabilities?.agent)}\`
  - Engineering capability: \`${Boolean(data.settings.capabilities?.engineering)}\`
  - Search capability: \`${Boolean(data.settings.capabilities?.search)}\`
  - Engineering Preflight: status=\`${data.toolPreflight.status ?? "unknown"}\`, error=\`${data.toolPreflight.error ?? ""}\`
- Legacy RPC default gate: ${data.server.legacyRpcBlocked ? "PASS" : "FAIL"}

## 4. UI Layout Verification

- Status: \`${data.uiVerify.status}\`
- Exit code: \`${data.uiVerify.exitCode ?? "n/a"}\`
- Seconds: \`${data.uiVerify.seconds ?? "n/a"}\`
- Stdout sample: \`${sampleOutput(data.uiVerify.stdout ?? "", 700)}\`
- Stderr sample: \`${sampleOutput(data.uiVerify.stderr ?? "", 700)}\`

## 5. Research Metadata Verification

- Status: \`${data.metadataVerify.status}\`
- Exit code: \`${data.metadataVerify.exitCode ?? "n/a"}\`
- Signal: \`${data.metadataVerify.signal ?? "n/a"}\`
- Timed out: \`${Boolean(data.metadataVerify.timedOut)}\`
- Seconds: \`${data.metadataVerify.seconds ?? "n/a"}\`
- Stdout sample: \`${sampleOutput(data.metadataVerify.stdout ?? "", 700)}\`
- Stderr sample: \`${sampleOutput(data.metadataVerify.stderr ?? "", 700)}\`

## 6. Blocked-path E2E

- Status: \`${data.blockedPath.status}\`
- Project ID: \`${data.blockedPath.projectId ?? "n/a"}\`
- Current step: \`${data.blockedPath.currentStep ?? "n/a"}\`
- RuntimeBlockers: ${data.blockedPath.runtimeBlockers ?? 0}
- StepErrors: ${data.blockedPath.stepErrors ?? 0}
- RunAuditOutputs: ${data.blockedPath.runAuditOutputs ?? 0}
- FinalOutputs: ${data.blockedPath.finalOutputs ?? 0}
- Bad evidence count: ${data.blockedPath.badEvidenceCount ?? 0}
- Latest blocker: \`${JSON.stringify(data.blockedPath.latestBlocker ?? {})}\`
- Counts: \`${JSON.stringify(data.blockedPath.counts ?? {})}\`

### Evidence Policy Table

${table(["Evidence ID", "traceabilityKind", "canSupportHypothesis", "citation", "quote", "sourceQualityTier", "generatedBy", "verdict"], evidencePolicyTableRows(data.blockedPath.evidencePolicyRows)) || "No evidence rows."}

## 7. Live-path E2E

- Status: \`${data.livePath.status}\`
- Reason: ${data.livePath.reason ?? "n/a"}
- Prerequisites: \`${JSON.stringify(data.livePath.prerequisites ?? {})}\`
- Counts: \`${JSON.stringify(data.livePath.counts ?? {})}\`

## 8. File / DB Artifact Validation

- Required paths: ${requiredPathSummary(data.artifacts.requiredPaths)}
- rawText SQLite hits: ${data.artifacts.rawTextHits ?? "not run"}
- Main source files: ${data.artifacts.mainSourceFiles ?? 0}
- Project web source files: ${data.artifacts.projectWebSourceFiles ?? 0}
- DB summaries: \`${dbSummariesJson(data.artifacts.dbSummaries)}\`

## 9. Security Tests

- Unsafe URL pre-fetch block: ${data.security.unsafeBlocked ? "PASS" : "not run/fail"}
- Unsafe harness fetch calls: ${data.security.unsafeFetchCalls ?? "n/a"}
- Public URL stub accepted: ${data.security.publicUrlAccepted ? "PASS" : "not run/fail"}
- Timeout/size/content-type coverage: covered by \`npm test\` and source invariant checks.

## 10. UTF-8 Test

- Korean blocked-path input preserved: ${data.utf8.blockedJsonHasKorean ? "PASS" : "not run/fail"}
- Korean blocked-path sentinels: \`${JSON.stringify(data.utf8.blockedJsonKoreanSentinels ?? {})}\`
- Blocked-path JSON fatal UTF-8 decode: ${data.utf8.blockedJsonFatalUtf8 ? "PASS" : "FAIL"} (first bytes: \`${data.utf8.blockedJsonFirstBytes ?? ""}\`)
- Audit markdown Korean preserved: ${data.utf8.auditHasKoreanRequirement ? "PASS" : "not run/fail"}
- Audit markdown Korean sentinels: \`${JSON.stringify(data.utf8.auditKoreanSentinels ?? {})}\`
- Generated text files fatal UTF-8 decode: ${data.utf8.generatedTextFatalUtf8 ? "PASS" : "FAIL"} (${data.utf8.generatedTextFileCount ?? 0} files)
- Generated text BOM files: \`${JSON.stringify(data.utf8.generatedTextBomFiles ?? [])}\`
- Generated text fatal failures: \`${JSON.stringify(data.utf8.generatedTextFatalFailures ?? [])}\`
- Contains \`??\`: ${data.utf8.hasQuestionQuestion ? "YES" : "NO"}
- Contains replacement char: ${data.utf8.hasReplacement ? "YES" : "NO"}
- Contains broader mojibake marker: ${data.utf8.hasMojibake ? "YES" : "NO"}
- API charset: \`${data.utf8.apiCharset ?? data.server.health?.contentType ?? "unknown"}\`
- Markdown BOM policy: \`${data.utf8.markdownBomPolicy ?? "unknown"}\`

Windows PowerShell note: if default \`Get-Content <path>\` displays Korean as garbled text, use \`Get-Content -Encoding UTF8 <path>\` for generated text files.

## 11. Findings

### Critical
${list(data.findings.critical)}

### High
${list(data.findings.high)}

### Medium
${list(data.findings.medium)}

### Low
${list(data.findings.low)}

## 12. Recommended Fixes

${list(data.recommendations.length ? data.recommendations : ["No mandatory fixes. Configure real embedding/search credentials to exercise live-path E2E."])}

## 13. Verdict

\`${data.verdict}\`
`;
}
