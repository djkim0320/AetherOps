import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { auditUtf8File, auditUtf8Files, scanAuditUtf8, sentinelStatus, KOREAN_UTF8_SENTINELS, MOJIBAKE_MARKER } from "./utf8.mjs";
import { makeSecuritySources, safeGlobFiles } from "./runtime.mjs";
import { shouldWriteMarkdownBom } from "./report-utils.mjs";

export async function runSecurityHarness(context) {
  const webFetchModule = join(context.repoRoot, "dist-server", "server", "runtime", "tools", "webFetchTool.js");
  const { WebFetchTool } = await import(pathToFileURL(webFetchModule).href);
  const now = new Date().toISOString();
  const settings = {
    openCodeLlm: { source: "codex-oauth", model: "gpt-5.6", reasoningEffort: "xhigh", timeoutMs: 180000 },
    openCode: { enabled: true, command: "opencode", provider: "openai", model: "gpt-5.5", timeoutMs: 180000 },
    webSearch: { provider: "disabled" },
    embedding: { provider: "openai", model: "text-embedding-3-small", dimensions: 1536 },
    browserUse: { enabled: true, mode: "background", maxPages: 2, timeoutMs: 30000, captureScreenshots: true },
    allowExternalSearch: true,
    allowCodeExecution: false,
    ontologyExtractionMode: "rule_based",
    finalOutputExport: { markdown: true, json: true, ontologyGraph: true, artifactPackage: true },
    updatedAt: now
  };
  const makeInput = (urls) => ({
    project: {
      id: "security-project",
      goal: "g",
      topic: "t",
      scope: "s",
      budget: "b",
      autonomyPolicy: { toolApproval: "suggested", allowExternalSearch: true, allowCodeExecution: false },
      createdAt: now,
      updatedAt: now,
      currentStep: "EXECUTE_TOOLS",
      status: "running",
      projectRoot: ".tmp/security"
    },
    iteration: 1,
    requiredTools: ["WebFetchTool"],
    researchPlan: {
      id: "plan",
      projectId: "security-project",
      iteration: 1,
      objective: "o",
      requiredTools: ["WebFetchTool"],
      expectedSources: [],
      analysisMethods: [],
      deliverables: [],
      successCriteria: [],
      riskControls: [],
      fetchCandidateUrls: [],
      createdAt: now
    },
    questions: [],
    hypotheses: [],
    evidence: [],
    artifacts: [],
    sources: makeSecuritySources(urls, now),
    settings
  });
  const unsafeUrls = [
    "http://localhost:3000",
    "http://127.0.0.1",
    "http://192.168.0.1",
    "http://169.254.169.254",
    "http://[::1]",
    "http://[fc00::1]",
    "http://[fe80::1]",
    "http://[ff02::1]",
    "http://[::ffff:127.0.0.1]"
  ];
  let fetchCalls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    fetchCalls += 1;
    return new Response("<html><title>ok</title><body>safe public page text</body></html>", { status: 200, headers: { "content-type": "text/html" } });
  };
  try {
    const batches = [unsafeUrls.slice(0, 3), unsafeUrls.slice(3, 6), unsafeUrls.slice(6)];
    const blockedResults = [];
    for (const urls of batches) {
      const result = await new WebFetchTool().run(makeInput(urls), settings);
      blockedResults.push(result.toolRun.output);
    }
    const unsafeFetchCalls = fetchCalls;
    fetchCalls = 0;
    const publicResult = await new WebFetchTool().run(makeInput(["https://93.184.216.34"]), settings);
    context.results.security = {
      unsafeUrls,
      unsafeFetchCalls,
      unsafeBlocked: unsafeFetchCalls === 0 && blockedResults.every((output) => output.failedUrls?.length > 0),
      publicUrlAccepted: publicResult.toolRun.status === "completed" && publicResult.evidence.length === 1 && fetchCalls === 1,
      unitCoverageMarkers: true
    };
    if (!context.results.security.unsafeBlocked) context.results.findings.high.push("WebFetch unsafe URL harness did not block all unsafe URLs before fetch.");
    if (!context.results.security.publicUrlAccepted)
      context.results.findings.medium.push("WebFetch public URL stub harness did not produce expected citation-backed evidence.");
  } finally {
    globalThis.fetch = originalFetch;
  }
}

export async function validateUtf8(context) {
  const blockedResultPath = join(context.dataRoot, "blocked-path-result.json");
  const blockedAudit = auditUtf8File(blockedResultPath);
  const blockedText = blockedAudit.text;
  const reportCandidates = safeGlobFiles(join(context.dataRoot, "projects"), /run-audit\.md$/);
  const generatedTextAudit = auditUtf8Files(safeGlobFiles(context.dataRoot, /\.(?:md|json|jsonl|nt|txt)$/i));
  const auditScan = scanAuditUtf8(reportCandidates, generatedTextAudit.audits);
  const blockedJsonSentinels = sentinelStatus(blockedText, KOREAN_UTF8_SENTINELS);
  const hasQuestionQuestion = /[?]{2,}/.test(blockedText) || auditScan.hasQuestionQuestion;
  const hasReplacement = blockedText.includes("\uFFFD") || auditScan.hasReplacement;
  const hasMojibake = MOJIBAKE_MARKER.test(blockedText) || auditScan.hasMojibake || !generatedTextAudit.fatalOk;
  context.results.utf8 = {
    blockedJsonHasKorean: Object.values(blockedJsonSentinels).some(Boolean),
    blockedJsonKoreanSentinels: blockedJsonSentinels,
    blockedJsonFatalUtf8: blockedAudit.fatalOk,
    blockedJsonFirstBytes: blockedAudit.firstBytes,
    auditHasKoreanRequirement: auditScan.hasKoreanRequirement,
    auditKoreanSentinels: auditScan.koreanSentinels,
    generatedTextFileCount: generatedTextAudit.fileCount,
    generatedTextFatalUtf8: generatedTextAudit.fatalOk,
    generatedTextFatalFailures: generatedTextAudit.failures,
    generatedTextBomFiles: generatedTextAudit.bomFiles,
    hasQuestionQuestion,
    hasReplacement,
    hasMojibake,
    apiCharset: context.results.server.health?.contentType,
    markdownBomPolicy: shouldWriteMarkdownBom() ? "bom-enabled" : "bom-disabled"
  };
  if (hasMojibake) context.results.findings.medium.push("UTF-8/mojibake regression marker found in blocked-path JSON or audit markdown.");
  if (blockedText && !Object.values(blockedJsonSentinels).every(Boolean)) {
    context.results.findings.medium.push("Blocked-path JSON is missing one or more Korean UTF-8 sentinel strings.");
  }
  if (!generatedTextAudit.fatalOk) {
    context.results.findings.high.push(`Generated text files failed strict UTF-8 decoding: ${generatedTextAudit.failures.length}.`);
  }
}
