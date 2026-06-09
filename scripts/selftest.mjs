import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { createServer } from "node:net";
import { join, relative, resolve } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import {
  PRODUCTION_ADAPTER_PATHS,
  PRODUCTION_ADAPTER_PATTERN,
  canListen,
  hasForbiddenProductionAdapterLine,
  scanTextForPattern,
  satisfiesNodeEngine
} from "./lib/checks.mjs";

const repoRoot = process.cwd();
const packageJson = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
const args = parseArgs(process.argv.slice(2));
const mode = args.mode ?? "full";
const strictLive = args.strictLive;
const skipStatic = args.skipStatic;
const fullStatic = args.fullStatic;
const dataRoot = resolve(args.dataRoot ?? process.env.AETHEROPS_DATA_DIR ?? join(repoRoot, ".tmp", "aetherops-selftest"));
const reportPath = resolve(repoRoot, "docs", "aetherops-self-test-report.md");
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const GIT_STATUS_LABELS = {
  "??": "untracked",
  " M": "modified",
  "M ": "modified-index",
  "A ": "added-index",
  "D ": "deleted-index",
  " D": "deleted",
  "R ": "renamed-index"
};
const MOJIBAKE_MARKER = /\uFFFD|[?]{2,}|[\u0080-\u009F]|[\uF900-\uFAFF]|\u00C3.|\u00C2.|\u00E2\u20AC|\u00EC[\u0080-\u00BF]|\u00ED[\u0080-\u00BF]|\u00EB[\u0080-\u00BF]|\u00EA[\u0080-\u00BF]/u;
const KOREAN_UTF8_SENTINELS = Object.freeze([
  "서술형 질문",
  "근거 추적성",
  "설정 부족",
  "검색 snippet은 evidence가 아님"
]);
const results = {
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
  recommendations: []
};

let serverProcess;

try {
  collectEnvironment();
  await prepareDataRoot();
  await runStaticChecks();
  await runGrepChecks();
  await runMetadataVerify();
  const requestedPort = args.port !== undefined ? Number(args.port) : await findFreePort();
  await assertPortSafe(requestedPort);
  await startServer(requestedPort);
  await runServerVerify();
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
  await runUiVerify();
} catch (error) {
  results.findings.critical.push(error instanceof Error ? error.message : String(error));
} finally {
  await stopServer();
  results.finishedAt = new Date().toISOString();
  collectFinalGitStatus();
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
  const dirtyFilesBefore = gitStatusShort();
  results.environment = {
    commit: command("git", ["rev-parse", "--short", "HEAD"]).stdout.trim(),
    branch: command("git", ["branch", "--show-current"]).stdout.trim(),
    dirtyFilesBefore,
    dirtyFiles: dirtyFilesBefore,
    nodeVersion: process.version,
    npmVersion: command(npm, ["-v"]).stdout.trim(),
    os: `${process.platform} ${process.arch}`,
    engine: packageJson.engines?.node ?? "unspecified",
    engineSatisfied: satisfiesNodeEngine(process.versions.node, packageJson.engines?.node ?? ">=22.16.0"),
    scripts: Object.keys(packageJson.scripts ?? {}),
    staticMode: describeStaticMode(),
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
  if (skipStatic) {
    results.staticChecks.push({ label: "static checks", exitCode: 0, seconds: 0, skipped: true, reason: "--skip-static" });
    return;
  }
  if (mode !== "live" || fullStatic) {
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
      label: "production synthetic-substitute adapters",
      pattern: PRODUCTION_ADAPTER_PATTERN,
      paths: PRODUCTION_ADAPTER_PATHS,
      passWhen: (result) => result.exitCode !== 0 || !hasForbiddenProductionAdapterLine(result.stdout, /README\.md:.*(policy|synthetic|substitute|adapter|none)/i)
    },
    { label: "legacy RPC gate", pattern: /AETHEROPS_ENABLE_LEGACY_RPC/, paths: ["src/server/webServer.ts"], passWhen: (result) => result.exitCode === 0 },
    { label: "WebSearchTool no evidence policy", pattern: /class WebSearchTool|evidence:\s*\[\]/, paths: ["src/core/tools/toolRegistry.ts"], passWhen: (result) => result.exitCode === 0 && result.stdout.includes("evidence: []") },
    { label: "ProjectContextSnapshot enforcement", pattern: /ProjectContextSnapshot|buildContextFromProjectContext/, paths: ["src/core/orchestration/orchestrator.ts", "src/core/retrieval/hybridRetrievalEngine.ts", "src/core/retrieval/projectContextBuilder.ts"], passWhen: (result) => result.exitCode === 0 },
    { label: "DataAnalysis tool input availability", pattern: /normalizedRecords:|validationResults:|projectContextSnapshots:/, paths: ["src/core/orchestration/orchestrator.ts"], passWhen: (result) => result.exitCode === 0 },
    { label: "WebFetch hardening markers", pattern: /AbortController|content-length|body read timeout|fc00|fe80|ff00|::ffff/, paths: ["src/core/tools/toolRegistry.ts"], passWhen: (result) => result.exitCode === 0 },
    { label: "rawText sanitization markers", pattern: /rawText/, paths: ["scripts", "src/server", "src/core"], passWhen: (result) => result.exitCode === 0 },
    { label: "old previous-evidence WebFetch message removed", pattern: /requires at least one external source URL from previous evidence/, paths: ["src"], passWhen: (result) => result.exitCode !== 0 }
  ];
  for (const check of checks) {
    const matches = scanTextForPattern(check.pattern, check.paths);
    const result = { exitCode: matches.length ? 0 : 1, stdout: matches.join("\n"), stderr: "" };
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
  serverProcess.stdout.on("data", (chunk) => {
    stdout.push(String(chunk));
    results.server.stdout = stdout.join("");
  });
  serverProcess.stderr.on("data", (chunk) => {
    stderr.push(String(chunk));
    results.server.stderr = stderr.join("");
  });

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

async function runServerVerify() {
  const port = Number(results.server.port ?? 0) || findPortInServerOutput(results.server.stdout) || await currentServerPort();
  const health = await fetchJson(`http://127.0.0.1:${port}/api/health`, 5_000);
  const settings = await rpc(port, "settings.get", []);
  const toolDiagnostics = await rpc(port, "tools.diagnostics", []);
  const toolPreflight = await rpc(port, "tools.preflightEngineering", ["all"]);
  results.server.port = health.body.port ?? port;
  results.server.health = { status: health.status, contentType: health.contentType, body: health.body };
  results.settings = settings.result;
  results.toolDiagnostics = toolDiagnostics.result;
  results.toolPreflight = toolPreflight.result;
  assertEngineeringTemplateContract(results.toolDiagnostics);
  if (!health.contentType.includes("application/json; charset=utf-8")) results.findings.critical.push("Health response is missing application/json; charset=utf-8.");
  if (resolve(health.body.dataRoot) !== dataRoot) results.findings.critical.push(`Health dataRoot mismatch: ${health.body.dataRoot}`);
  if (results.toolPreflight.status !== "failed") results.findings.high.push("Engineering program preflight did not fail closed with default self-test settings.");
  const legacy = await rpc(port, "opencode.run", ["invalid-project"], { allowFailure: true });
  results.server.legacyRpcBlocked = Boolean(legacy.error?.includes("Legacy RPC method opencode.run is disabled"));
  if (!results.server.legacyRpcBlocked) results.findings.high.push("Legacy RPC opencode.run was not blocked by default.");
}

function assertEngineeringTemplateContract(toolDiagnostics = {}) {
  const templates = Array.isArray(toolDiagnostics.engineeringProgramRequestTemplates) ? toolDiagnostics.engineeringProgramRequestTemplates : [];
  const openVspTemplate = templates.find((template) => template.id === "openvsp-analysis-run:openvsp");
  const xflr5Template = templates.find((template) => template.id === "xflr5-analysis-run:xflr5");
  const su2Template = templates.find((template) => template.id === "su2-case-run:su2");
  const xfoilWasmTemplate = templates.find((template) => template.id === "xfoil-wasm-polar:xfoil-wasm");
  if (templates.length !== 7) {
    results.findings.high.push(`Engineering program template contract changed: expected 7 templates, found ${templates.length}.`);
  }
  if (!xfoilWasmTemplate) {
    results.findings.high.push("Engineering program template contract is missing xfoil-wasm-polar:xfoil-wasm.");
  } else if (xfoilWasmTemplate.request?.kind !== "xfoil-wasm-polar" || xfoilWasmTemplate.request?.target !== "xfoil-wasm") {
    results.findings.high.push("XFOIL-WASM request template does not expose kind=xfoil-wasm-polar and target=xfoil-wasm.");
  } else if (!xfoilWasmTemplate.request?.sourceUrl && !xfoilWasmTemplate.request?.artifactPath && !xfoilWasmTemplate.request?.naca) {
    results.findings.high.push("XFOIL-WASM request template does not name sourceUrl, artifactPath, or naca.");
  }
  if (!su2Template) {
    results.findings.high.push("Engineering program template contract is missing su2-case-run:su2.");
  } else {
    if (su2Template.request?.kind !== "su2-case-run" || su2Template.request?.target !== "su2") {
      results.findings.high.push("SU2 request template does not expose kind=su2-case-run and target=su2.");
    }
    if (su2Template.request?.outputFileName !== "su2-run-output.txt") {
      results.findings.high.push("SU2 request template outputFileName changed unexpectedly.");
    }
    if (!su2Template.request?.cfdRunSpec) {
      results.findings.high.push("SU2 request template does not expose cfdRunSpec.");
    }
  }
  if (!openVspTemplate) {
    results.findings.high.push("Engineering program template contract is missing openvsp-analysis-run:openvsp.");
    return;
  }
  if (openVspTemplate.request?.kind !== "openvsp-analysis-run" || openVspTemplate.request?.target !== "openvsp") {
    results.findings.high.push("OpenVSP request template does not expose kind=openvsp-analysis-run and target=openvsp.");
  }
  if (!openVspTemplate.request?.cfdRunSpec) {
    results.findings.high.push("OpenVSP request template does not expose cfdRunSpec.");
  }
  if (openVspTemplate.request?.outputFileName !== "openvsp-analysis-output.json") {
    results.findings.high.push("OpenVSP request template outputFileName changed unexpectedly.");
  }
  if (!xflr5Template) {
    results.findings.high.push("Engineering program template contract is missing xflr5-analysis-run:xflr5.");
  } else if (xflr5Template.request?.kind !== "xflr5-analysis-run" || xflr5Template.request?.target !== "xflr5") {
    results.findings.high.push("XFLR5 request template does not expose kind=xflr5-analysis-run and target=xflr5.");
  } else if (!xflr5Template.request?.cfdRunSpec) {
    results.findings.high.push("XFLR5 request template does not expose cfdRunSpec.");
  }
}

async function runUiVerify() {
  const port = Number(results.server.port ?? 0) || findPortInServerOutput(results.server.stdout) || await currentServerPort();
  const check = runTimed(process.execPath, [join(repoRoot, "scripts", "ui-layout-verify.mjs"), "--url", `http://127.0.0.1:${port}`], "npm run ui:verify", 120_000);
  results.uiVerify = {
    status: check.exitCode === 0 ? "PASS" : "FAIL",
    exitCode: check.exitCode,
    signal: check.signal,
    timedOut: check.timedOut,
    seconds: check.seconds,
    stdout: check.stdout,
    stderr: check.stderr
  };
  if (check.exitCode !== 0) {
    results.findings.high.push("UI layout verification failed against the self-test server.");
  }
}

async function runMetadataVerify() {
  if (mode === "blocked") {
    results.metadataVerify = { status: "SKIPPED", reason: "blocked mode" };
    return;
  }
  const check = runTimed(
    process.execPath,
    [join(repoRoot, "scripts", "research-metadata-verify.mjs"), "--query", "Clark Y airfoil", "--max-results", "5", "--timeout-ms", "30000"],
    "npm run metadata:verify",
    90_000
  );
  results.metadataVerify = {
    status: check.exitCode === 0 ? "PASS" : "FAIL",
    exitCode: check.exitCode,
    signal: check.signal,
    timedOut: check.timedOut,
    seconds: check.seconds,
    stdout: check.stdout,
    stderr: check.stderr
  };
  if (check.exitCode !== 0) {
    results.findings.high.push("Live OpenAlex metadata verification failed.");
  }
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
      "필수 LLM/OpenCode/Embedding 설정이 부족하면 연구는 조용히 대체하지 않고 blocked 또는 failed로 기록되어야 한다.",
      "blocked 상태에서도 RuntimeBlocker, StepError, RunAuditOutput이 생성되어야 한다.",
      "가설: 온톨로지 그래프는 citation coverage를 개선할 수 있다."
    ],
    constraints: ["synthetic-substitute 사용 금지", "검색 snippet은 evidence가 아님", "실제 API key가 없으면 blocked가 정상"],
    expectedOutputs: ["RuntimeBlocker", "StepError", "RunAuditOutput"]
  }]);
  const started = performance.now();
  await rpc(port, "loop.start", [projectId], { timeoutMs: 360_000 });
  const snapshot = (await rpc(port, "snapshots.get", [projectId])).result;
  const evidencePolicyRows = buildEvidencePolicyRows(snapshot);
  let badEvidenceCount = 0;
  for (const item of evidencePolicyRows) {
    if (item.verdict !== "PASS") badEvidenceCount += 1;
  }
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
    badEvidenceCount,
    evidencePolicyRows
  };
  writeFileSync(join(dataRoot, "blocked-path-result.json"), `${JSON.stringify({ snapshot }, null, 2)}\n`, "utf8");
  if (!["blocked", "failed"].includes(snapshot.project.status)) results.findings.high.push(`Blocked-path ended with unexpected status: ${snapshot.project.status}.`);
  if (snapshot.finalOutputs.length !== 0) results.findings.high.push("Blocked-path produced FinalOutput.");
  if (!snapshot.runtimeBlockers.length && !snapshot.stepErrors.length) results.findings.high.push("Blocked-path did not record RuntimeBlocker or StepError.");
  if (!snapshot.runAuditOutputs.length) results.findings.medium.push("Blocked-path did not create RunAuditOutput.");
  if (badEvidenceCount) results.findings.high.push(`Blocked-path evidence policy violation detected: ${badEvidenceCount} bad evidence rows.`);
}

async function assessLiveGate() {
  const port = results.server.port;
  const settings = results.settings;
  const prerequisites = {
    llm: true,
    openCode: Boolean(settings.openCode?.enabled && settings.openCode?.command),
    embedding: Boolean(settings.embedding?.apiKeyConfigured),
    externalSearch: Boolean(settings.allowExternalSearch && ((settings.webSearch?.provider !== "disabled" && settings.webSearch?.apiKeyConfigured) || settings.browserUse?.enabled)),
    noSubstituteAdapters: hasNoFailedGrepCheck("production synthetic-substitute adapters")
  };
  if (prerequisites.embedding && prerequisites.externalSearch && prerequisites.openCode && prerequisites.noSubstituteAdapters) {
    const llmStatus = await rpc(port, "llm.status", [], { allowFailure: true });
    prerequisites.llm = Boolean(llmStatus.result?.available);
  }
  const ready = Object.values(prerequisites).every(Boolean);
  return {
    ready,
    prerequisites,
    reason: ready ? undefined : missingPrerequisiteNames(prerequisites).join(", ")
  };
}

async function runLivePath() {
  const port = results.server.port;
  const projectInput = {
    goal: "Compare Vector RAG and Hybrid RAG citation coverage.",
    topic: "자동 연구 에이전트에서 Vector RAG와 Hybrid RAG의 citation coverage 비교",
    scope: "공개 웹 문헌 자료로 1회차 live-path E2E를 검증한다.",
    budget: "30분",
    autonomyPolicy: { toolApproval: "suggested", allowExternalSearch: true, allowCodeExecution: false, maxLoopIterations: 1 }
  };
  const created = await rpc(port, "projects.create", [projectInput], { timeoutMs: 60_000 });
  const projectId = created.result.project.id;
  await rpc(port, "researchDb.create", [projectId]);
  await rpc(port, "research.inputResearchQuestionHypothesis", [projectId, {
    researchQuestion: "Vector RAG 단독 방식과 Ontology Graph 결합 Hybrid RAG는 claim-source traceability와 evidence gap detection에서 어떤 차이를 보이는가?",
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
    evidenceSamples: sampleEvidence(snapshot.evidence ?? [], 3)
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
  for (const dbPath of dbPaths) {
    if (!existsSync(dbPath)) continue;
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      const tableRows = db.prepare("select name from sqlite_master where type='table' order by name").all();
      const counts = {};
      for (const row of tableRows) {
        const table = row.name;
        const quotedTable = quoteSqlIdentifier(table);
        counts[table] = db.prepare(`select count(*) as n from ${quotedTable}`).get().n;
        if (hasDataColumn(db, quotedTable)) {
          rawTextHits += db.prepare(`select count(*) as n from ${quotedTable} where data like '%rawText%'`).get().n;
        }
      }
      dbSummaries.push({ path: relative(dataRoot, dbPath), counts });
    } finally {
      db.close();
    }
  }
  const requiredPathNames = [
    "main/main.sqlite",
    "main/vector.sqlite",
    "main/ontology.sqlite",
    "main/files/sources",
    "projects"
  ];
  const requiredPaths = [];
  for (const item of requiredPathNames) {
    requiredPaths.push({ path: item, exists: existsSync(join(dataRoot, item)) });
  }
  results.artifacts = {
    requiredPaths,
    dbSummaries,
    rawTextHits,
    mainSourceFiles: countFiles(join(dataRoot, "main", "files", "sources")),
    projectWebSourceFiles: countMatchingFiles(projectsRoot, /[\\/]sources[\\/]web[\\/]/)
  };
  if (hasMissingRequiredPath(requiredPaths)) results.findings.medium.push("One or more expected self-test data paths were not created.");
  if (rawTextHits > 0) results.findings.high.push(`rawText payload found in SQLite JSON rows: ${rawTextHits}.`);
}

async function runSecurityHarness() {
  const { WebFetchTool } = await import(new URL("../dist-server/core/tools/toolRegistry.js", import.meta.url).href);
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
    sources: makeSecuritySources(urls, now),
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
  const blockedAudit = auditUtf8File(blockedResultPath);
  const blockedText = blockedAudit.text;
  const reportCandidates = safeGlobFiles(join(dataRoot, "projects"), /run-audit\.md$/);
  const generatedTextAudit = auditUtf8Files(safeGlobFiles(dataRoot, /\.(?:md|json|jsonl|nt|txt)$/i));
  const auditScan = scanAuditUtf8(reportCandidates, generatedTextAudit.audits);
  const blockedJsonSentinels = sentinelStatus(blockedText, KOREAN_UTF8_SENTINELS);
  const hasQuestionQuestion = /[?]{2,}/.test(blockedText) || auditScan.hasQuestionQuestion;
  const hasReplacement = blockedText.includes("\uFFFD") || auditScan.hasReplacement;
  const hasMojibake = MOJIBAKE_MARKER.test(blockedText) || auditScan.hasMojibake || !generatedTextAudit.fatalOk;
  results.utf8 = {
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
    apiCharset: results.server.health?.contentType,
    markdownBomPolicy: shouldWriteMarkdownBom() ? "bom-enabled" : "bom-disabled"
  };
  if (hasMojibake) results.findings.medium.push("UTF-8/mojibake regression marker found in blocked-path JSON or audit markdown.");
  if (blockedText && !Object.values(blockedJsonSentinels).every(Boolean)) {
    results.findings.medium.push("Blocked-path JSON is missing one or more Korean UTF-8 sentinel strings.");
  }
  if (!generatedTextAudit.fatalOk) {
    results.findings.high.push(`Generated text files failed strict UTF-8 decoding: ${generatedTextAudit.failures.length}.`);
  }
}

function auditUtf8Files(files) {
  const failures = [];
  const bomFiles = [];
  const audits = new Map();
  for (const file of files) {
    const audit = auditUtf8File(file);
    audits.set(file, audit);
    if (!audit.fatalOk) failures.push({ file: relative(repoRoot, file), error: audit.error });
    if (audit.hasBom) bomFiles.push(relative(repoRoot, file));
  }
  return {
    fileCount: files.length,
    fatalOk: failures.length === 0,
    failures,
    bomFiles,
    audits
  };
}

function auditUtf8File(file) {
  if (!existsSync(file)) {
    return { text: "", fatalOk: true, hasBom: false, firstBytes: "" };
  }
  const bytes = readFileSync(file);
  const firstBytes = bytes.subarray(0, 4).toString("hex");
  const hasBom = bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return { text, fatalOk: !text.includes("\uFFFD"), hasBom, firstBytes };
  } catch (error) {
    return { text: "", fatalOk: false, hasBom, firstBytes, error: error instanceof Error ? error.message : String(error) };
  }
}

function scanAuditUtf8(files, audits = new Map()) {
  const result = {
    hasQuestionQuestion: false,
    hasReplacement: false,
    hasMojibake: false,
    hasKoreanRequirement: false,
    koreanSentinels: Object.fromEntries(KOREAN_UTF8_SENTINELS.map((item) => [item, false]))
  };
  for (const file of files) {
    const audit = audits.get(file) ?? auditUtf8File(file);
    const text = audit.text;
    result.hasQuestionQuestion ||= /[?]{2,}/.test(text);
    result.hasReplacement ||= text.includes("\uFFFD");
    result.hasMojibake ||= MOJIBAKE_MARKER.test(text);
    result.hasKoreanRequirement ||=
      text.includes("Embedding API key가 필요합니다.") ||
      text.includes("LLM 설정") ||
      text.includes("OpenCode");
    for (const sentinel of KOREAN_UTF8_SENTINELS) {
      result.koreanSentinels[sentinel] ||= text.includes(sentinel);
    }
  }
  return result;
}

function sentinelStatus(text, sentinels) {
  return Object.fromEntries(sentinels.map((sentinel) => [sentinel, text.includes(sentinel)]));
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

function sampleEvidence(evidence, limit) {
  const samples = [];
  for (const item of evidence) {
    if (samples.length >= limit) break;
    samples.push({
      title: item.title,
      sourceUri: item.sourceUri,
      citation: item.citation,
      quotePresent: Boolean(item.quote)
    });
  }
  return samples;
}

function makeSecuritySources(urls, now) {
  const sources = [];
  let index = 0;
  for (const url of urls) {
    sources.push({
      id: `s${index}`,
      projectId: "security-project",
      kind: "web",
      title: url,
      url,
      retrievedAt: now,
      metadata: {},
      createdAt: now
    });
    index += 1;
  }
  return sources;
}

function verdict() {
  if (results.findings.critical.length || results.findings.high.length) return "FAIL";
  if (results.findings.medium.length || (mode !== "blocked" && results.livePath.status === "SKIPPED")) return "PASS_WITH_WARNINGS";
  return "PASS";
}

function writeReport(data) {
  mkdirSync(join(repoRoot, "docs"), { recursive: true });
  const report = renderReport(data);
  const body = withOptionalMarkdownBom(report);
  writeFileSync(reportPath, body, "utf8");
}

function withOptionalMarkdownBom(markdown) {
  if (!shouldWriteMarkdownBom() || markdown.startsWith("\uFEFF")) return markdown;
  return `\uFEFF${markdown}`;
}

function shouldWriteMarkdownBom() {
  const setting = process.env.AETHEROPS_MARKDOWN_BOM?.trim().toLowerCase();
  if (["true", "1", "yes", "on"].includes(setting)) return true;
  if (["false", "0", "no", "off"].includes(setting)) return false;
  return process.platform === "win32";
}

function collectFinalGitStatus() {
  const dirtyFilesAfter = ensureExpectedReportUpdate(gitStatusShort());
  results.environment.dirtyFilesAfter = dirtyFilesAfter;
  results.environment.generatedBySelfTest = diffGitStatus(results.environment.dirtyFilesBefore ?? [], dirtyFilesAfter);
  results.environment.expectedSelfTestReportUpdate = dirtyFilesAfter.some((entry) => gitStatusPath(entry) === "docs/aetherops-self-test-report.md");
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
- Static mode: ${data.environment.staticMode}

### Dirty files before self-test

${listGitStatusInline(data.environment.dirtyFilesBefore)}

### Files generated by self-test

${listGitStatusInline(data.environment.generatedBySelfTest)}

### Dirty files after self-test

${listGitStatusInline(data.environment.dirtyFilesAfter)}

Expected self-test report update: ${data.environment.expectedSelfTestReportUpdate ? "`docs/aetherops-self-test-report.md`" : "none detected"}

## 2. Static Checks

${table(["Check", "Result", "Seconds"], staticCheckRows(data.staticChecks))}

### Grep Invariants

${grepCheckList(data.grepChecks)}

## 3. Server Verification

- Health status: ${data.server.health?.status ?? "not run"}
- Health content type: \`${data.server.health?.contentType ?? "unknown"}\`
- Health body: \`${JSON.stringify(data.server.health?.body ?? {})}\`
- settings.get summary:
  - LLM: \`${data.settings.openCodeLlm?.source ?? "unknown"}\` / \`${data.settings.openCodeLlm?.model ?? "unknown"}\`
  - OpenCode: enabled=\`${data.settings.openCode?.enabled}\`, command=\`${data.settings.openCode?.command ?? ""}\`
  - Embedding: provider=\`${data.settings.embedding?.provider ?? "unknown"}\`, apiKeyConfigured=\`${Boolean(data.settings.embedding?.apiKeyConfigured)}\`
  - Web Search: provider=\`${data.settings.webSearch?.provider ?? "unknown"}\`, apiKeyConfigured=\`${Boolean(data.settings.webSearch?.apiKeyConfigured)}\`
  - Research Metadata: provider=\`${data.toolDiagnostics.researchMetadata?.provider ?? "unknown"}\`, ready=\`${Boolean(data.toolDiagnostics.researchMetadata?.ready)}\`
  - Engineering Programs: executable=\`${Boolean(data.toolDiagnostics.executableTools?.includes?.("EngineeringProgramTool"))}\`, readyTargets=\`${engineeringReadyTargets(data.toolDiagnostics.engineeringPrograms)}\`
  - Engineering Request Templates: total=\`${data.toolDiagnostics.engineeringProgramRequestTemplates?.length ?? 0}\`, ready=\`${engineeringReadyTemplateCount(data.toolDiagnostics.engineeringProgramRequestTemplates)}\`
  - Engineering Artifact Candidates: total=\`${data.toolDiagnostics.engineeringArtifactCandidates?.length ?? 0}\`, ready=\`${engineeringReadyArtifactCandidateCount(data.toolDiagnostics.engineeringArtifactCandidates)}\`
  - Engineering Preflight: status=\`${data.toolPreflight.status ?? "unknown"}\`, error=\`${data.toolPreflight.error ?? ""}\`
  - Browser: enabled=\`${Boolean(data.settings.browserUse?.enabled)}\`
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

Windows PowerShell note: if default \`Get-Content <path>\` displays Korean as garbled text, this is a console decoding issue, not evidence that AetherOps rewrote the bytes. Use \`Get-Content -Encoding UTF8 <path>\` for generated Markdown, JSON, JSONL, NT, and source files. For example: \`Get-Content -Encoding UTF8 docs/aetherops-self-test-report.md\`.

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

## 12. Verdict

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
    throw new Error(`RPC ${method} failed: ${message}`);
  }
  return response.body;
}

async function fetchJson(url, timeoutMs, init = {}) {
  const parsed = new URL(url);
  const body = typeof init.body === "string" ? init.body : init.body ? String(init.body) : undefined;
  const headers = { ...(init.headers ?? {}) };
  if (body !== undefined && !Object.keys(headers).some((key) => key.toLowerCase() === "content-length")) {
    headers["Content-Length"] = Buffer.byteLength(body);
  }
  return new Promise((resolveJson, reject) => {
    const request = httpRequest(
      {
        protocol: parsed.protocol,
        hostname: parsed.hostname,
        port: parsed.port,
        path: `${parsed.pathname}${parsed.search}`,
        method: init.method ?? "GET",
        headers
      },
      (response) => {
        const chunks = [];
        response.setEncoding("utf8");
        response.on("data", (chunk) => chunks.push(String(chunk)));
        response.on("end", () => {
          try {
            const text = chunks.join("");
            resolveJson({
              status: response.statusCode ?? 0,
              contentType: String(response.headers["content-type"] ?? ""),
              body: text ? JSON.parse(text) : {}
            });
          } catch (error) {
            reject(withLocalServerState(url, error, body));
          }
        });
      }
    );
    request.setTimeout(timeoutMs, () => {
      request.destroy(new Error(`Timed out after ${timeoutMs}ms`));
    });
    request.on("error", (error) => reject(withLocalServerState(url, error, body)));
    if (body !== undefined) request.write(body);
    request.end();
  });
}

function withLocalServerState(url, error, requestBody) {
  let rpcMethod = "";
  try {
    const parsedBody = typeof requestBody === "string" ? JSON.parse(requestBody) : undefined;
    rpcMethod = parsedBody?.method ? ` rpc=${parsedBody.method}` : "";
  } catch {
    rpcMethod = "";
  }
  const serverState =
    serverProcess && url.includes("127.0.0.1")
      ? ` serverExit=${serverProcess.exitCode ?? "running"} serverSignal=${serverProcess.signalCode ?? "none"} stderr=${sampleOutput(results.server.stderr ?? "", 500)}`
      : "";
  return new Error(`fetchJson failed for ${url}${rpcMethod}: ${error instanceof Error ? error.message : String(error)}${serverState}`);
}

function runTimed(commandName, commandArgs, label, timeoutMs) {
  const started = performance.now();
  const result = runProcess(commandName, commandArgs, timeoutMs);
  return {
    label,
    exitCode: result.exitCode,
    signal: result.signal,
    timedOut: result.timedOut,
    seconds: Number(((performance.now() - started) / 1000).toFixed(2)),
    stdout: sampleOutput(result.stdout, 1_500),
    stderr: sampleOutput(result.stderr, 1_500)
  };
}

function runProcess(commandName, commandArgs, timeoutMs) {
  const needsShell = process.platform === "win32" && /\.(?:cmd|bat)$/i.test(commandName);
  const result = spawnSync(commandName, commandArgs, { cwd: repoRoot, encoding: "utf8", shell: needsShell, timeout: timeoutMs, windowsHide: true });
  return {
    exitCode: result.status ?? 1,
    signal: result.signal ?? undefined,
    timedOut: result.error?.code === "ETIMEDOUT",
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? ""
  };
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
  const parsed = { strictLive: false, skipStatic: false, fullStatic: false };
  for (const arg of rawArgs) {
    if (arg.startsWith("--mode=")) parsed.mode = arg.slice("--mode=".length);
    else if (arg.startsWith("--port=")) parsed.port = Number(arg.slice("--port=".length));
    else if (arg.startsWith("--data-root=")) parsed.dataRoot = arg.slice("--data-root=".length);
    else if (arg === "--strict-live") parsed.strictLive = true;
    else if (arg === "--skip-static") parsed.skipStatic = true;
    else if (arg === "--full-static") parsed.fullStatic = true;
  }
  if (!["full", "blocked", "live", undefined].includes(parsed.mode)) {
    throw new Error(`Unknown selftest mode: ${parsed.mode}`);
  }
  return parsed;
}

function describeStaticMode() {
  if (skipStatic) return "skipped (--skip-static)";
  if (mode === "live" && !fullStatic) return "build only (live default)";
  return "typecheck + test + build";
}

function buildEvidencePolicyRows(snapshot) {
  const rows = [];
  const evidenceItems = new Map();
  const sourcesById = new Map();
  for (const source of snapshot.sources ?? []) {
    sourcesById.set(source.id, source);
  }
  for (const item of snapshot.evidence ?? []) {
    const source = sourcesById.get(item.sourceId);
    evidenceItems.set(item.id, {
      id: item.id,
      sourceUri: item.sourceUri,
      citation: item.citation,
      quote: item.quote,
      metadata: { ...(source?.metadata ?? {}), ...(item.metadata ?? {}) },
      sourceId: item.sourceId,
      normalized: false
    });
  }
  for (const record of snapshot.normalizedRecords ?? []) {
    const kind = String(record.kind ?? record.recordKind ?? record.metadata?.recordKind ?? "");
    if (kind !== "evidence") continue;
    const existing = evidenceItems.get(record.sourceEvidenceId ?? record.evidenceId ?? record.id);
    evidenceItems.set(existing?.id ?? record.id, {
      id: existing?.id ?? record.id,
      sourceUri: existing?.sourceUri ?? record.sourceUri ?? record.metadata?.sourceUri,
      citation: existing?.citation ?? record.citation ?? record.metadata?.citation,
      quote: existing?.quote ?? record.quote ?? record.metadata?.quote,
      metadata: { ...(existing?.metadata ?? {}), ...(record.metadata ?? {}) },
      sourceId: existing?.sourceId ?? record.sourceId,
      normalized: true,
      record
    });
  }

  for (const item of evidenceItems.values()) {
    const metadata = item.metadata ?? {};
    const traceabilityKind = String(metadata.traceabilityKind ?? "unknown");
    const canSupportHypothesis = metadata.canSupportHypothesis === true;
    const sourceQualityTier = String(metadata.sourceQualityTier ?? "unknown");
    const generatedBy = String(metadata.generatedBy ?? metadata.toolName ?? metadata.sourceTool ?? metadata.adapter ?? inferGeneratedBy(metadata));
    const hasSourceUri = Boolean(item.sourceUri ?? metadata.sourceUri ?? metadata.url ?? metadata.doi ?? metadata.pdfUrl);
    const hasCitation = Boolean(item.citation ?? metadata.citation ?? metadata.sourceUri ?? metadata.url ?? metadata.doi ?? metadata.pdfUrl);
    const hasQuote = Boolean(item.quote ?? metadata.quote);
    const lowerGeneratedBy = generatedBy.toLowerCase();
    const verdictReasons = [];
    if (lowerGeneratedBy.includes("websearch") || metadata.snippet) verdictReasons.push("WebSearch snippet promoted");
    if (lowerGeneratedBy.includes("opencode") && canSupportHypothesis) verdictReasons.push("OpenCode claim/observation support evidence");
    if (traceabilityKind === "internal_artifact" && canSupportHypothesis) verdictReasons.push("internal_artifact support evidence");
    if (canSupportHypothesis && !hasCitation) verdictReasons.push("support evidence lacks citation/sourceUri/doi/pdfUrl");
    rows.push({
      id: String(item.id),
      traceabilityKind,
      canSupportHypothesis,
      hasCitation,
      hasQuote,
      sourceQualityTier,
      generatedBy,
      verdict: verdictReasons.length ? `FAIL: ${verdictReasons.join("; ")}` : "PASS"
    });
  }
  return rows;
}

function hasNoFailedGrepCheck(label) {
  for (const check of results.grepChecks) {
    if (check.label === label && !check.passed) return false;
  }
  return true;
}

function hasMissingRequiredPath(paths) {
  for (const item of paths) {
    if (!item.exists) return true;
  }
  return false;
}

function missingPrerequisiteNames(prerequisites) {
  const missing = [];
  for (const [key, value] of Object.entries(prerequisites)) {
    if (!value) missing.push(key);
  }
  return missing;
}

function inferGeneratedBy(metadata) {
  if (metadata.fetchStatus === "fetched" || metadata.contentType) return "WebFetchTool";
  if (metadata.snippet) return "WebSearchTool";
  if (metadata.downgradedFromEvidence) return "OpenCodeAdapter";
  return "unknown";
}

function gitStatusShort() {
  const entries = [];
  for (const line of command("git", ["status", "--short"]).stdout.split(/\r?\n/)) {
    if (line.trim()) entries.push(line);
  }
  return entries;
}

function diffGitStatus(before, after) {
  const beforeByPath = new Map();
  for (const entry of before) {
    beforeByPath.set(gitStatusPath(entry), entry);
  }
  const changed = [];
  for (const entry of after) {
    if (beforeByPath.get(gitStatusPath(entry)) !== entry) changed.push(entry);
  }
  return changed;
}

function gitStatusPath(entry) {
  return entry.replace(/^.{2}\s+/, "").replace(/^.* -> /, "").trim().replace(/\\/g, "/");
}

function hasGitStatusPath(statusEntries, targetPath) {
  for (const entry of statusEntries) {
    if (gitStatusPath(entry) === targetPath) return true;
  }
  return false;
}

function ensureExpectedReportUpdate(statusEntries) {
  const reportEntry = " M docs/aetherops-self-test-report.md";
  if (hasGitStatusPath(statusEntries, "docs/aetherops-self-test-report.md")) return statusEntries;
  const output = [];
  for (const entry of statusEntries) output.push(entry);
  output.push(reportEntry);
  return output;
}

function hasDataColumn(db, quotedTable) {
  for (const column of db.prepare(`pragma table_info(${quotedTable})`).all()) {
    if (column.name === "data") return true;
  }
  return false;
}

function quoteSqlIdentifier(value) {
  return JSON.stringify(value);
}

function countFiles(root) {
  return countMatchingFiles(root, /./);
}

function countMatchingFiles(root, pattern) {
  if (!existsSync(root)) return 0;
  let count = 0;
  const stack = [root];
  while (stack.length) {
    const current = stack.pop();
    for (const entry of safeReaddirEntries(current)) {
      const file = join(current, entry.name);
      if (entry.isDirectory()) stack.push(file);
      else if (pattern.test(file)) count += 1;
    }
  }
  return count;
}

function safeGlobFiles(root, pattern) {
  if (!existsSync(root)) return [];
  const output = [];
  const stack = [root];
  while (stack.length) {
    const current = stack.pop();
    for (const entry of safeReaddirEntries(current)) {
      const file = join(current, entry.name);
      if (entry.isDirectory()) stack.push(file);
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

function safeReaddirEntries(root) {
  try {
    return existsSync(root) ? readdirSync(root, { withFileTypes: true }) : [];
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
  if (!rows.length) return "No rows.";
  const lines = [tableRow(headers), tableSeparator(headers.length)];
  for (const row of rows) {
    lines.push(tableRow(row));
  }
  return lines.join("\n");
}

function staticCheckRows(checks = []) {
  const rows = [];
  for (const item of checks) {
    rows.push([
      item.label,
      item.skipped ? `SKIPPED (${item.reason})` : item.exitCode === 0 ? "PASS" : "FAIL",
      String(item.seconds)
    ]);
  }
  return rows;
}

function grepCheckList(checks = []) {
  if (!checks.length) return "- None.";
  const lines = [];
  for (const item of checks) {
    lines.push(`- ${item.passed ? "PASS" : "FAIL"}: ${item.label}${item.sample ? ` - ${item.sample}` : ""}`);
  }
  return lines.join("\n");
}

function evidencePolicyTableRows(rows = []) {
  const tableRows = [];
  for (const item of evidencePolicyRowsForReport(rows)) {
    tableRows.push([
      item.id,
      item.traceabilityKind,
      String(item.canSupportHypothesis),
      item.hasCitation ? "yes" : "no",
      item.hasQuote ? "yes" : "no",
      item.sourceQualityTier,
      item.generatedBy,
      item.verdict
    ]);
  }
  return tableRows;
}

function requiredPathSummary(paths) {
  if (!paths) return "not run";
  if (!paths.length) return "none";
  const parts = [];
  for (const item of paths) {
    parts.push(`${item.exists ? "PASS" : "FAIL"} ${item.path}`);
  }
  return parts.join("; ");
}

function dbSummariesJson(summaries = []) {
  const output = [];
  for (const item of summaries) {
    output.push({ path: item.path, counts: item.counts });
  }
  return JSON.stringify(output);
}

function engineeringReadyTargets(capabilities = []) {
  const ready = [];
  for (const capability of capabilities ?? []) {
    if (capability?.ready && capability.target) ready.push(`${capability.kind}:${capability.target}`);
  }
  return ready.join(", ") || "none";
}

function engineeringReadyTemplateCount(templates = []) {
  let count = 0;
  for (const template of templates ?? []) {
    if (template?.ready) count += 1;
  }
  return count;
}

function engineeringReadyArtifactCandidateCount(candidates = []) {
  let count = 0;
  for (const candidate of candidates ?? []) {
    if (candidate?.ready) count += 1;
  }
  return count;
}

function list(items) {
  if (!items.length) return "- None.";
  const lines = [];
  for (const item of items) {
    lines.push(`- ${item}`);
  }
  return lines.join("\n");
}

function listGitStatusInline(items = []) {
  if (!items.length) return "- None.";
  const lines = [];
  for (const item of items) {
    lines.push(`- \`${formatGitStatusEntry(item)}\``);
  }
  return lines.join("\n");
}

function tableRow(values) {
  const cells = [];
  for (const value of values) {
    cells.push(escapeTableCell(value));
  }
  return `| ${cells.join(" | ")} |`;
}

function tableSeparator(count) {
  const cells = [];
  for (let index = 0; index < count; index += 1) {
    cells.push("---");
  }
  return `| ${cells.join(" | ")} |`;
}

function formatGitStatusEntry(entry) {
  const code = entry.slice(0, 2);
  const filePath = gitStatusPath(entry);
  const label = GIT_STATUS_LABELS[code] ?? (code.trim() || "changed");
  return `${label} ${filePath}`;
}

function escapeTableCell(value) {
  return String(value ?? "").replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

function evidencePolicyRowsForReport(rows = []) {
  return rows.length ? rows : [{
    id: "none",
    traceabilityKind: "n/a",
    canSupportHypothesis: false,
    hasCitation: false,
    hasQuote: false,
    sourceQualityTier: "n/a",
    generatedBy: "n/a",
    verdict: "PASS: no evidence rows to inspect"
  }];
}
