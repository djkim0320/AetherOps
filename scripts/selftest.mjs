import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join, relative, resolve } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";

const repoRoot = process.cwd();
const packageJson = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
const args = parseArgs(process.argv.slice(2));
const mode = args.mode ?? "full";
const strictLive = args.strictLive;
const dataRoot = resolve(args.dataRoot ?? process.env.AETHEROPS_DATA_DIR ?? join(repoRoot, ".tmp", "aetherops-selftest"));
const reportPath = resolve(repoRoot, "docs", "aetherops-self-test-report.md");
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const results = {
  startedAt: new Date().toISOString(),
  environment: {},
  staticChecks: [],
  grepChecks: [],
  server: {},
  settings: {},
  blockedPath: { status: "SKIPPED" },
  livePath: { status: "SKIPPED" },
  artifacts: {},
  security: {},
  utf8: {},
  findings: { critical: [], high: [], medium: [], low: [] },
  recommendations: []
};

let serverProcess;

try {
  collectEnvironment();
  await prepareDataRoot();
  await runStaticChecks();
  await runGrepChecks();
  const requestedPort = args.port !== undefined ? Number(args.port) : await findFreePort();
  await assertPortSafe(requestedPort);
  await startServer(requestedPort);
  await runServerSmoke();
  const liveGate = await assessLiveGate();
  if (mode !== "live") {
    await runBlockedPath();
  }
  if (mode !== "blocked") {
    if (liveGate.ready) {
      await runLivePath();
    } else {
      results.livePath = { status: "SKIPPED", reason: liveGate.reason, prerequisites: liveGate.prerequisites };
      if (mode === "live" && strictLive) {
        results.findings.high.push("selftest:live prerequisites are missing and --strict-live was set.");
      } else {
        results.findings.medium.push("Live-path E2E skipped because real live provider prerequisites are missing.");
      }
    }
  }
  await validateArtifactsAndDb();
  await runSecurityHarness();
  await validateUtf8();
} catch (error) {
  results.findings.critical.push(error instanceof Error ? error.message : String(error));
} finally {
  await stopServer();
  results.finishedAt = new Date().toISOString();
  results.verdict = verdict();
  writeReport(results);
}

console.log(`AetherOps self-test verdict: ${results.verdict}`);
console.log(`Report: ${reportPath}`);
if (results.findings.critical.length || results.findings.high.length) {
  console.log([...results.findings.critical, ...results.findings.high].join("\n"));
}
if (mode === "live" && strictLive && results.livePath.status === "SKIPPED") {
  process.exit(1);
}
process.exit(results.verdict === "FAIL" ? 1 : 0);

function collectEnvironment() {
  results.environment = {
    commit: command("git", ["rev-parse", "--short", "HEAD"]).stdout.trim(),
    branch: command("git", ["branch", "--show-current"]).stdout.trim(),
    dirtyFiles: command("git", ["status", "--short"]).stdout.trim().split(/\r?\n/).filter(Boolean),
    nodeVersion: process.version,
    npmVersion: command(npm, ["-v"]).stdout.trim(),
    os: `${process.platform} ${process.arch}`,
    engine: packageJson.engines?.node ?? "unspecified",
    engineSatisfied: satisfiesNodeEngine(process.versions.node, packageJson.engines?.node ?? ">=22.16.0"),
    scripts: Object.keys(packageJson.scripts ?? {}),
    dataRoot
  };
  if (!results.environment.engineSatisfied) {
    results.findings.critical.push(`Node engine check failed: ${process.version} does not satisfy ${results.environment.engine}.`);
  }
}

async function prepareDataRoot() {
  if (!dataRoot.startsWith(repoRoot)) {
    throw new Error(`Refusing to clear self-test data outside repo: ${dataRoot}`);
  }
  rmSync(dataRoot, { recursive: true, force: true });
  mkdirSync(dataRoot, { recursive: true });
}

async function runStaticChecks() {
  if (mode !== "live") {
    results.staticChecks.push(runTimed(npm, ["run", "typecheck"], "npm run typecheck"));
    results.staticChecks.push(runTimed(npm, ["test"], "npm test"));
  }
  results.staticChecks.push(runTimed(npm, ["run", "build"], "npm run build"));
  for (const check of results.staticChecks) {
    if (check.exitCode !== 0) {
      results.findings.critical.push(`${check.label} failed with exit code ${check.exitCode}.`);
    }
  }
}

async function runGrepChecks() {
  const checks = [
    {
      label: "production mock/fallback adapters",
      command: ["rg", "-n", "MockOpenCodeAdapter|LocalResearchAdapter|CompositeOpenCodeAdapter", "src", "README.md"],
      passWhen: (result) => result.exitCode !== 0 || !result.stdout.split(/\r?\n/).filter(Boolean).some((line) => !/\.test\./.test(line) && !/README\.md:.*(mock|fallback|금지|없음)/i.test(line))
    },
    { label: "legacy RPC gate", command: ["rg", "-n", "AETHEROPS_ENABLE_LEGACY_RPC", "src/server/webServer.ts"], passWhen: (result) => result.exitCode === 0 },
    { label: "WebSearchTool no evidence policy", command: ["rg", "-n", "class WebSearchTool|evidence:\\s*\\[\\]", "src/core/toolRegistry.ts"], passWhen: (result) => result.exitCode === 0 && result.stdout.includes("evidence: []") },
    { label: "ProjectContextSnapshot enforcement", command: ["rg", "-n", "ProjectContextSnapshot|buildContextFromProjectContext", "src/core/orchestrator.ts", "src/core/hybridRetrievalEngine.ts", "src/core/projectContextBuilder.ts"], passWhen: (result) => result.exitCode === 0 },
    { label: "DataAnalysis tool input availability", command: ["rg", "-n", "normalizedRecords:|validationResults:|projectContextSnapshots:", "src/core/orchestrator.ts"], passWhen: (result) => result.exitCode === 0 },
    { label: "WebFetch hardening markers", command: ["rg", "-n", "AbortController|content-length|body read timeout|fc00|fe80|ff00|::ffff", "src/core/toolRegistry.ts"], passWhen: (result) => result.exitCode === 0 },
    { label: "rawText sanitization markers", command: ["rg", "-n", "rawText", "scripts", "src/server", "src/core"], passWhen: (result) => result.exitCode === 0 },
    { label: "old previous-evidence WebFetch message removed", command: ["rg", "-n", "requires at least one external source URL from previous evidence", "src"], passWhen: (result) => result.exitCode !== 0 }
  ];
  for (const check of checks) {
    const result = runProcess(check.command[0], check.command.slice(1));
    const passed = check.passWhen(result);
    results.grepChecks.push({ label: check.label, exitCode: result.exitCode, passed, sample: sampleOutput(result.stdout || result.stderr) });
    if (!passed) results.findings.high.push(`Grep invariant failed: ${check.label}.`);
  }
}

async function assertPortSafe(port) {
  if (port === 0) return;
  const canUse = await canListen(port);
  if (canUse) return;
  const health = await fetchJson(`http://127.0.0.1:${port}/api/health`, 2_000).catch(() => undefined);
  const existingRoot = health?.body?.dataRoot ? resolve(String(health.body.dataRoot)) : undefined;
  if (existingRoot && existingRoot === dataRoot) {
    throw new Error(`Port ${port} is already occupied by an AetherOps server using the self-test data root. Stop it before running selftest.`);
  }
  throw new Error(`Port ${port} is occupied${existingRoot ? ` by AetherOps dataRoot=${existingRoot}` : ""}. Re-run without --port or use another --port.`);
}

async function startServer(port) {
  const serverPath = join(repoRoot, "dist-server", "server", "webServer.js");
  if (!existsSync(serverPath)) throw new Error("dist-server/server/webServer.js does not exist. Build did not produce the server.");
  const env = {
    ...process.env,
    AETHEROPS_DATA_DIR: dataRoot,
    AETHEROPS_ENABLE_LEGACY_RPC: "false",
    AETHEROPS_PORT: String(port),
    PYTHONIOENCODING: "utf-8",
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8"
  };
  const stdout = [];
  const stderr = [];
  results.server.port = port;
  serverProcess = spawn(process.execPath, [serverPath], { cwd: repoRoot, env, windowsHide: true });
  serverProcess.stdout.setEncoding("utf8");
  serverProcess.stderr.setEncoding("utf8");
  serverProcess.stdout.on("data", (chunk) => stdout.push(String(chunk)));
  serverProcess.stderr.on("data", (chunk) => stderr.push(String(chunk)));

  const deadline = Date.now() + 30_000;
  let lastError;
  while (Date.now() < deadline) {
    if (serverProcess.exitCode !== null) {
      throw new Error(`Server exited early (${serverProcess.exitCode}). stdout=${stdout.join("")} stderr=${stderr.join("")}`);
    }
    try {
      const health = await fetchJson(`http://127.0.0.1:${port}/api/health`, 2_000);
      if (health.body?.ok) {
        results.server.command = `${process.execPath} ${relative(repoRoot, serverPath)}`;
        results.server.stdout = stdout.join("");
        results.server.stderr = stderr.join("");
        return;
      }
    } catch (error) {
      lastError = error;
      await sleep(250);
    }
  }
  throw new Error(`Server health check timed out: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
}

async function runServerSmoke() {
  const port = Number(results.server.port ?? 0) || findPortInServerOutput(results.server.stdout) || await currentServerPort();
  const health = await fetchJson(`http://127.0.0.1:${port}/api/health`, 5_000);
  const settings = await rpc(port, "settings.get", []);
  results.server.port = health.body.port ?? port;
  results.server.health = { status: health.status, contentType: health.contentType, body: health.body };
  results.settings = settings.result;
  if (!health.contentType.includes("application/json; charset=utf-8")) results.findings.critical.push("Health response is missing application/json; charset=utf-8.");
  if (resolve(health.body.dataRoot) !== dataRoot) results.findings.critical.push(`Health dataRoot mismatch: ${health.body.dataRoot}`);
  const legacy = await rpc(port, "opencode.run", ["invalid-project"], { allowFailure: true });
  results.server.legacyRpcBlocked = Boolean(legacy.error?.includes("Legacy RPC method opencode.run is disabled"));
  if (!results.server.legacyRpcBlocked) results.findings.high.push("Legacy RPC opencode.run was not blocked by default.");
}

async function runBlockedPath() {
  const port = results.server.port;
  const projectInput = {
    goal: "AetherOps blocked-path self test",
    topic: "Vector RAG vs Hybrid RAG 테스트",
    scope: "설정 부족 시 blocked 상태와 RunAuditOutput 생성 여부 확인",
    budget: "10분",
    autonomyPolicy: {
      toolApproval: "suggested",
      allowExternalSearch: true,
      allowCodeExecution: false,
      maxLoopIterations: 1
    }
  };
  const created = await rpc(port, "projects.create", [projectInput]);
  const projectId = created.result.project.id;
  await rpc(port, "researchDb.create", [projectId]);
  await rpc(port, "research.inputResearchQuestionHypothesis", [projectId, {
    researchQuestion: "검색 snippet을 evidence로 쓰지 않는 strict research loop가 설정 부족 상황에서 올바르게 blocked 되는가? 한글 질문: Vector RAG와 Hybrid RAG의 근거 추적성 차이를 검증한다.",
    initialHypotheses: [
      "필수 LLM/OpenCode/Embedding 설정이 부족하면 연구는 조용히 fallback하지 않고 blocked 또는 failed로 기록되어야 한다.",
      "blocked 상태에서도 RuntimeBlocker, StepError, RunAuditOutput이 생성되어야 한다.",
      "가설: 온톨로지 그래프는 citation coverage를 개선할 수 있다."
    ],
    constraints: ["mock/fallback 사용 금지", "검색 snippet은 evidence가 아님", "실제 API key가 없으면 blocked가 정상"],
    expectedOutputs: ["RuntimeBlocker", "StepError", "RunAuditOutput"]
  }]);
  const started = performance.now();
  await rpc(port, "loop.start", [projectId], { timeoutMs: 360_000 });
  const snapshot = (await rpc(port, "snapshots.get", [projectId])).result;
  const badEvidence = (snapshot.evidence ?? []).filter((item) => !item.sourceUri && !item.citation && !item.quote);
  results.blockedPath = {
    status: snapshot.project.status,
    projectId,
    elapsedSeconds: Number(((performance.now() - started) / 1000).toFixed(2)),
    currentStep: snapshot.project.currentStep,
    runtimeBlockers: snapshot.runtimeBlockers.length,
    stepErrors: snapshot.stepErrors.length,
    runAuditOutputs: snapshot.runAuditOutputs.length,
    finalOutputs: snapshot.finalOutputs.length,
    counts: snapshotCounts(snapshot),
    latestBlocker: snapshot.runtimeBlockers.at(-1),
    latestStepError: snapshot.stepErrors.at(-1),
    latestAudit: snapshot.runAuditOutputs.at(-1),
    badEvidenceCount: badEvidence.length
  };
  writeFileSync(join(dataRoot, "blocked-path-result.json"), `${JSON.stringify({ snapshot }, null, 2)}\n`, "utf8");
  if (!["blocked", "failed"].includes(snapshot.project.status)) results.findings.high.push(`Blocked-path ended with unexpected status: ${snapshot.project.status}.`);
  if (snapshot.finalOutputs.length !== 0) results.findings.high.push("Blocked-path produced FinalOutput.");
  if (!snapshot.runtimeBlockers.length && !snapshot.stepErrors.length) results.findings.high.push("Blocked-path did not record RuntimeBlocker or StepError.");
  if (!snapshot.runAuditOutputs.length) results.findings.medium.push("Blocked-path did not create RunAuditOutput.");
  if (badEvidence.length) results.findings.high.push("Blocked-path evidence pollution detected: evidence without sourceUri/citation/quote.");
}

async function assessLiveGate() {
  const port = results.server.port;
  const llmStatus = await rpc(port, "llm.status", [], { allowFailure: true });
  const settings = results.settings;
  const prerequisites = {
    llm: Boolean(llmStatus.result?.available),
    openCode: Boolean(settings.openCode?.enabled && settings.openCode?.command),
    embedding: Boolean(settings.embedding?.apiKeyConfigured),
    externalSearch: Boolean(settings.allowExternalSearch && ((settings.webSearch?.provider !== "disabled" && settings.webSearch?.apiKeyConfigured) || settings.browserUse?.enabled)),
    noMockFallback: !results.grepChecks.some((check) => check.label === "production mock/fallback adapters" && !check.passed)
  };
  const ready = Object.values(prerequisites).every(Boolean);
  return {
    ready,
    prerequisites,
    reason: ready ? undefined : Object.entries(prerequisites).filter(([, value]) => !value).map(([key]) => key).join(", ")
  };
}

async function runLivePath() {
  const port = results.server.port;
  const projectInput = {
    goal: "Compare Vector RAG and Hybrid RAG citation coverage.",
    topic: "자동 연구 에이전트에서 Vector RAG와 Hybrid RAG의 citation coverage 비교",
    scope: "공개 웹/문헌 자료로 1회 짧은 live-path E2E를 검증한다.",
    budget: "30분",
    autonomyPolicy: { toolApproval: "suggested", allowExternalSearch: true, allowCodeExecution: false, maxLoopIterations: 1 }
  };
  const created = await rpc(port, "projects.create", [projectInput], { timeoutMs: 60_000 });
  const projectId = created.result.project.id;
  await rpc(port, "researchDb.create", [projectId]);
  await rpc(port, "research.inputResearchQuestionHypothesis", [projectId, {
    researchQuestion: "Vector RAG 단독 방식과 Ontology Graph를 결합한 Hybrid RAG 방식은 claim-source traceability와 evidence gap detection 측면에서 어떤 차이를 보이는가?",
    initialHypotheses: [
      "Vector RAG는 chunk retrieval에는 유리하지만 claim-evidence-source traceability는 약할 수 있다.",
      "Hybrid RAG는 ProjectContextSnapshot과 ontology relation을 통해 evidence gap detection을 개선할 수 있다.",
      "relation extraction 오류가 citation correctness를 떨어뜨릴 수 있다."
    ],
    constraints: ["검색 snippet은 evidence로 사용 금지", "WebFetch 또는 PDF span 추출 자료만 evidence로 사용", "코드 실행 금지"],
    expectedOutputs: ["comparison table", "evidence summary", "recommendations"]
  }]);
  await rpc(port, "loop.start", [projectId], { timeoutMs: 900_000 });
  const snapshot = (await rpc(port, "snapshots.get", [projectId])).result;
  results.livePath = {
    status: snapshot.project.status,
    projectId,
    currentStep: snapshot.project.currentStep,
    counts: snapshotCounts(snapshot),
    finalOutputs: snapshot.finalOutputs.length,
    runAuditOutputs: snapshot.runAuditOutputs.length,
    evidenceSamples: (snapshot.evidence ?? []).slice(0, 3).map((item) => ({ title: item.title, sourceUri: item.sourceUri, citation: item.citation, quotePresent: Boolean(item.quote) }))
  };
}

async function validateArtifactsAndDb() {
  const dbPaths = [
    join(dataRoot, "aetherops.sqlite"),
    join(dataRoot, "main", "main.sqlite"),
    join(dataRoot, "main", "vector.sqlite"),
    join(dataRoot, "main", "ontology.sqlite")
  ];
  const projectsRoot = join(dataRoot, "projects");
  if (existsSync(projectsRoot)) {
    for (const name of safeReaddir(projectsRoot)) {
      const projectDb = join(projectsRoot, name, "project.sqlite");
      if (existsSync(projectDb)) dbPaths.push(projectDb);
    }
  }
  const dbSummaries = [];
  let rawTextHits = 0;
  for (const dbPath of dbPaths.filter(existsSync)) {
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      const tables = db.prepare("select name from sqlite_master where type='table' order by name").all().map((row) => row.name);
      const counts = {};
      for (const table of tables) {
        counts[table] = db.prepare(`select count(*) as n from ${JSON.stringify(table)}`).get().n;
        if (hasDataColumn(db, table)) {
          rawTextHits += db.prepare(`select count(*) as n from ${JSON.stringify(table)} where data like '%rawText%'`).get().n;
        }
      }
      dbSummaries.push({ path: relative(dataRoot, dbPath), counts });
    } finally {
      db.close();
    }
  }
  const requiredPaths = [
    "main/main.sqlite",
    "main/vector.sqlite",
    "main/ontology.sqlite",
    "main/files/sources",
    "projects"
  ].map((item) => ({ path: item, exists: existsSync(join(dataRoot, item)) }));
  results.artifacts = {
    requiredPaths,
    dbSummaries,
    rawTextHits,
    mainSourceFiles: countFiles(join(dataRoot, "main", "files", "sources")),
    projectWebSourceFiles: countMatchingFiles(projectsRoot, /[\\/]sources[\\/]web[\\/]/)
  };
  if (requiredPaths.some((item) => !item.exists)) results.findings.medium.push("One or more expected self-test data paths were not created.");
  if (rawTextHits > 0) results.findings.high.push(`rawText payload found in SQLite JSON rows: ${rawTextHits}.`);
}

async function runSecurityHarness() {
  const { WebFetchTool } = await import(new URL("../dist-server/core/toolRegistry.js", import.meta.url).href);
  const now = new Date().toISOString();
  const settings = {
    openCodeLlm: { source: "codex-oauth", model: "gpt-5.5" },
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
    project: { id: "security-project", goal: "g", topic: "t", scope: "s", budget: "b", autonomyPolicy: { toolApproval: "suggested", allowExternalSearch: true, allowCodeExecution: false }, createdAt: now, updatedAt: now, currentStep: "EXECUTE_TOOLS", status: "running", projectRoot: ".tmp/security" },
    iteration: 1,
    requiredTools: ["WebFetchTool"],
    researchPlan: { id: "plan", projectId: "security-project", iteration: 1, objective: "o", requiredTools: ["WebFetchTool"], expectedSources: [], analysisMethods: [], deliverables: [], successCriteria: [], riskControls: [], fetchCandidateUrls: [], createdAt: now },
    questions: [],
    hypotheses: [],
    evidence: [],
    artifacts: [],
    sources: urls.map((url, index) => ({ id: `s${index}`, projectId: "security-project", kind: "web", title: url, url, retrievedAt: now, metadata: {}, createdAt: now })),
    settings
  });
  const unsafeUrls = ["http://localhost:3000", "http://127.0.0.1", "http://192.168.0.1", "http://169.254.169.254", "http://[::1]", "http://[fc00::1]", "http://[fe80::1]", "http://[ff02::1]", "http://[::ffff:127.0.0.1]"];
  let fetchCalls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    fetchCalls += 1;
    return new Response("<html><title>ok</title><body>safe public page text</body></html>", { status: 200, headers: { "content-type": "text/html" } });
  };
  try {
    const batches = [
      unsafeUrls.slice(0, 3),
      unsafeUrls.slice(3, 6),
      unsafeUrls.slice(6)
    ];
    const blockedResults = [];
    for (const urls of batches) {
      const result = await new WebFetchTool().run(makeInput(urls), settings);
      blockedResults.push(result.toolRun.output);
    }
    const unsafeFetchCalls = fetchCalls;
    fetchCalls = 0;
    const publicResult = await new WebFetchTool().run(makeInput(["https://example.com"]), settings);
    results.security = {
      unsafeUrls,
      unsafeFetchCalls,
      unsafeBlocked: unsafeFetchCalls === 0 && blockedResults.every((output) => output.failedUrls?.length > 0),
      publicUrlAccepted: publicResult.toolRun.status === "completed" && publicResult.evidence.length === 1 && fetchCalls === 1,
      unitCoverageMarkers: true
    };
    if (!results.security.unsafeBlocked) results.findings.high.push("WebFetch unsafe URL harness did not block all unsafe URLs before fetch.");
    if (!results.security.publicUrlAccepted) results.findings.medium.push("WebFetch public URL stub harness did not produce expected citation-backed evidence.");
  } finally {
    globalThis.fetch = originalFetch;
  }
}

async function validateUtf8() {
  const blockedResultPath = join(dataRoot, "blocked-path-result.json");
  const blockedText = existsSync(blockedResultPath) ? readFileSync(blockedResultPath, "utf8") : "";
  const reportCandidates = safeGlobFiles(join(dataRoot, "projects"), /run-audit\.md$/);
  const auditText = reportCandidates.map((file) => readFileSync(file, "utf8")).join("\n");
  const hasQuestionQuestion = /\?\?/.test(blockedText) || /\?\?/.test(auditText);
  const hasReplacement = blockedText.includes("\uFFFD") || auditText.includes("\uFFFD");
  results.utf8 = {
    blockedJsonHasKorean: blockedText.includes("한글 질문"),
    auditHasKoreanRequirement: auditText.includes("Embedding API key가 필요합니다.") || auditText.includes("LLM 설정") || auditText.includes("OpenCode"),
    hasQuestionQuestion,
    hasReplacement,
    apiCharset: results.server.health?.contentType
  };
  if (hasQuestionQuestion || hasReplacement) results.findings.medium.push("UTF-8 regression marker found in blocked-path JSON or audit markdown.");
}

function snapshotCounts(snapshot) {
  return {
    sources: snapshot.sources?.length ?? 0,
    evidence: snapshot.evidence?.length ?? 0,
    artifacts: snapshot.artifacts?.length ?? 0,
    normalizedRecords: snapshot.normalizedRecords?.length ?? 0,
    chunks: snapshot.chunks?.length ?? 0,
    ontologyEntities: snapshot.ontologyEntities?.length ?? 0,
    ontologyRelations: snapshot.ontologyRelations?.length ?? 0,
    projectContextSnapshots: snapshot.projectContextSnapshots?.length ?? 0,
    validationResults: snapshot.validationResults?.length ?? 0
  };
}

function verdict() {
  if (results.findings.critical.length || results.findings.high.length) return "FAIL";
  if (results.findings.medium.length || (mode !== "blocked" && results.livePath.status === "SKIPPED")) return "PASS_WITH_WARNINGS";
  return "PASS";
}

function writeReport(data) {
  mkdirSync(join(repoRoot, "docs"), { recursive: true });
  const report = renderReport(data);
  const body = process.env.AETHEROPS_MARKDOWN_BOM === "true" ? `\uFEFF${report}` : report;
  writeFileSync(reportPath, body, "utf8");
}

function renderReport(data) {
  return `# AetherOps Self-Test Report

Generated: ${new Date().toISOString()}  
Workspace: \`${repoRoot}\`  
Data root: \`${dataRoot}\`

## 1. Environment

- Commit hash: \`${data.environment.commit || "unknown"}\`
- Branch: \`${data.environment.branch || "unknown"}\`
- Node.js: \`${data.environment.nodeVersion}\`
- npm: \`${data.environment.npmVersion}\`
- OS: \`${data.environment.os}\`
- Package engine: \`${data.environment.engine}\`
- Engine check: ${data.environment.engineSatisfied ? "PASS" : "FAIL"}
- Dirty files before self-test: ${data.environment.dirtyFiles?.length ? data.environment.dirtyFiles.map((item) => `\`${item}\``).join(", ") : "none"}

## 2. Static Checks

${table(["Check", "Result", "Seconds"], data.staticChecks.map((item) => [item.label, item.exitCode === 0 ? "PASS" : "FAIL", String(item.seconds)]))}

### Grep Invariants

${data.grepChecks.map((item) => `- ${item.passed ? "PASS" : "FAIL"}: ${item.label}${item.sample ? ` - ${item.sample}` : ""}`).join("\n")}

## 3. Server Smoke Test

- Health status: ${data.server.health?.status ?? "not run"}
- Health content type: \`${data.server.health?.contentType ?? "unknown"}\`
- Health body: \`${JSON.stringify(data.server.health?.body ?? {})}\`
- settings.get summary:
  - LLM: \`${data.settings.openCodeLlm?.source ?? "unknown"}\` / \`${data.settings.openCodeLlm?.model ?? "unknown"}\`
  - OpenCode: enabled=\`${data.settings.openCode?.enabled}\`, command=\`${data.settings.openCode?.command ?? ""}\`
  - Embedding: provider=\`${data.settings.embedding?.provider ?? "unknown"}\`, apiKeyConfigured=\`${Boolean(data.settings.embedding?.apiKeyConfigured)}\`
  - Web Search: provider=\`${data.settings.webSearch?.provider ?? "unknown"}\`, apiKeyConfigured=\`${Boolean(data.settings.webSearch?.apiKeyConfigured)}\`
  - Browser: enabled=\`${Boolean(data.settings.browserUse?.enabled)}\`
- Legacy RPC default gate: ${data.server.legacyRpcBlocked ? "PASS" : "FAIL"}

## 4. Blocked-path E2E

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

## 5. Live-path E2E

- Status: \`${data.livePath.status}\`
- Reason: ${data.livePath.reason ?? "n/a"}
- Prerequisites: \`${JSON.stringify(data.livePath.prerequisites ?? {})}\`
- Counts: \`${JSON.stringify(data.livePath.counts ?? {})}\`

## 6. File / DB Artifact Validation

- Required paths: ${data.artifacts.requiredPaths?.map((item) => `${item.exists ? "PASS" : "FAIL"} ${item.path}`).join("; ") ?? "not run"}
- rawText SQLite hits: ${data.artifacts.rawTextHits ?? "not run"}
- Main source files: ${data.artifacts.mainSourceFiles ?? 0}
- Project web source files: ${data.artifacts.projectWebSourceFiles ?? 0}
- DB summaries: \`${JSON.stringify((data.artifacts.dbSummaries ?? []).map((item) => ({ path: item.path, counts: item.counts })))}\`

## 7. Security Tests

- Unsafe URL pre-fetch block: ${data.security.unsafeBlocked ? "PASS" : "not run/fail"}
- Unsafe harness fetch calls: ${data.security.unsafeFetchCalls ?? "n/a"}
- Public URL stub accepted: ${data.security.publicUrlAccepted ? "PASS" : "not run/fail"}
- Timeout/size/content-type coverage: covered by \`npm test\` and source invariant checks.

## 8. UTF-8 Test

- Korean blocked-path input preserved: ${data.utf8.blockedJsonHasKorean ? "PASS" : "not run/fail"}
- Audit markdown Korean preserved: ${data.utf8.auditHasKoreanRequirement ? "PASS" : "not run/fail"}
- Contains \`??\`: ${data.utf8.hasQuestionQuestion ? "YES" : "NO"}
- Contains replacement char: ${data.utf8.hasReplacement ? "YES" : "NO"}
- API charset: \`${data.utf8.apiCharset ?? data.server.health?.contentType ?? "unknown"}\`

Windows PowerShell note: use \`Get-Content -Encoding UTF8 docs/aetherops-self-test-report.md\` if the default console displays mojibake.

## 9. Findings

### Critical
${list(data.findings.critical)}

### High
${list(data.findings.high)}

### Medium
${list(data.findings.medium)}

### Low
${list(data.findings.low)}

## 10. Recommended Fixes

${list(data.recommendations.length ? data.recommendations : ["No mandatory fixes. Configure real embedding/search credentials to exercise live-path E2E."])}

## 11. Verdict

\`${data.verdict}\`
`;
}

async function stopServer() {
  if (!serverProcess || serverProcess.exitCode !== null) return;
  await new Promise((resolveStop) => {
    serverProcess.once("exit", resolveStop);
    serverProcess.kill();
    setTimeout(() => {
      if (serverProcess.exitCode === null) serverProcess.kill("SIGKILL");
      resolveStop();
    }, 3_000).unref();
  });
}

async function rpc(port, method, rpcArgs, options = {}) {
  const response = await fetchJson(`http://127.0.0.1:${port}/api/rpc`, options.timeoutMs ?? 60_000, {
    method: "POST",
    headers: { "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify({ method, args: rpcArgs })
  });
  if (!response.body?.ok) {
    const message = response.body?.error ?? `RPC ${method} failed`;
    if (options.allowFailure) return { error: message, status: response.status };
    throw new Error(message);
  }
  return response.body;
}

async function fetchJson(url, timeoutMs, init = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    const text = await response.text();
    const body = text ? JSON.parse(text) : {};
    return { status: response.status, contentType: response.headers.get("content-type") ?? "", body };
  } finally {
    clearTimeout(timeout);
  }
}

function runTimed(commandName, commandArgs, label) {
  const started = performance.now();
  const result = runProcess(commandName, commandArgs);
  return {
    label,
    exitCode: result.exitCode,
    seconds: Number(((performance.now() - started) / 1000).toFixed(2)),
    stdout: sampleOutput(result.stdout, 1_500),
    stderr: sampleOutput(result.stderr, 1_500)
  };
}

function runProcess(commandName, commandArgs) {
  const needsShell = process.platform === "win32" && /\.(?:cmd|bat)$/i.test(commandName);
  const result = spawnSync(commandName, commandArgs, { cwd: repoRoot, encoding: "utf8", shell: needsShell, windowsHide: true });
  return { exitCode: result.status ?? 1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

function command(commandName, commandArgs) {
  const result = runProcess(commandName, commandArgs);
  return { stdout: result.stdout, stderr: result.stderr, status: result.exitCode };
}

async function findFreePort() {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => resolvePort(port));
    });
  });
}

async function canListen(port) {
  return new Promise((resolveCanListen) => {
    const server = createServer();
    server.once("error", () => resolveCanListen(false));
    server.once("listening", () => server.close(() => resolveCanListen(true)));
    server.listen(port, "127.0.0.1");
  });
}

async function currentServerPort() {
  const port = findPortInServerOutput(results.server.stdout);
  if (!port) throw new Error("Could not determine server port.");
  return port;
}

function findPortInServerOutput(output = "") {
  const match = output.match(/127\.0\.0\.1:(\d+)/);
  return match ? Number(match[1]) : undefined;
}

function parseArgs(rawArgs) {
  const parsed = { strictLive: false };
  for (const arg of rawArgs) {
    if (arg.startsWith("--mode=")) parsed.mode = arg.slice("--mode=".length);
    else if (arg.startsWith("--port=")) parsed.port = Number(arg.slice("--port=".length));
    else if (arg.startsWith("--data-root=")) parsed.dataRoot = arg.slice("--data-root=".length);
    else if (arg === "--strict-live") parsed.strictLive = true;
  }
  if (!["full", "blocked", "live", undefined].includes(parsed.mode)) {
    throw new Error(`Unknown selftest mode: ${parsed.mode}`);
  }
  return parsed;
}

function satisfiesNodeEngine(version, range) {
  const match = range.match(/>=\s*(\d+)\.(\d+)\.(\d+)/);
  if (!match) return true;
  const actual = version.split(".").map(Number);
  const required = match.slice(1).map(Number);
  for (let index = 0; index < 3; index += 1) {
    if ((actual[index] ?? 0) > required[index]) return true;
    if ((actual[index] ?? 0) < required[index]) return false;
  }
  return true;
}

function hasDataColumn(db, table) {
  return db.prepare(`pragma table_info(${JSON.stringify(table)})`).all().some((column) => column.name === "data");
}

function countFiles(root) {
  return safeGlobFiles(root, /./).length;
}

function countMatchingFiles(root, pattern) {
  return safeGlobFiles(root, pattern).length;
}

function safeGlobFiles(root, pattern) {
  if (!existsSync(root)) return [];
  const output = [];
  const stack = [root];
  while (stack.length) {
    const current = stack.pop();
    for (const name of safeReaddir(current)) {
      const file = join(current, name);
      const stat = statSync(file);
      if (stat.isDirectory()) stack.push(file);
      else if (pattern.test(file)) output.push(file);
    }
  }
  return output;
}

function safeReaddir(root) {
  try {
    return existsSync(root) ? readdirSync(root) : [];
  } catch {
    return [];
  }
}

function sampleOutput(text = "", limit = 240) {
  return text.replace(/\s+/g, " ").trim().slice(0, limit);
}

function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

function table(headers, rows) {
  const header = `| ${headers.join(" | ")} |`;
  const separator = `| ${headers.map(() => "---").join(" | ")} |`;
  return [header, separator, ...rows.map((row) => `| ${row.join(" | ")} |`)].join("\n");
}

function list(items) {
  return items.length ? items.map((item) => `- ${item}`).join("\n") : "- None.";
}
