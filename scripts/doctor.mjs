import { existsSync, readFileSync } from "node:fs";
import { createServer } from "node:net";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const repoRoot = process.cwd();
const args = new Set(process.argv.slice(2));
const jsonMode = args.has("--json");
const packageJson = readJson(join(repoRoot, "package.json"));
const dataRoot = resolve(process.env.AETHEROPS_DATA_DIR ?? join(repoRoot, ".aetherops"));
const port = Number(process.env.AETHEROPS_PORT ?? 5179);
const settings = readSettings(dataRoot);
const checks = [];
const recommendations = [];

const engineStatus = satisfiesNodeEngine(process.versions.node, packageJson.engines?.node ?? ">=22.16.0") ? "pass" : "fail";
checks.push({ key: "engine", status: engineStatus, detail: `node ${process.version}, required ${packageJson.engines?.node ?? "unspecified"}` });
if (engineStatus === "fail") recommendations.push("Install Node.js >=22.16.0.");

const requiredScripts = ["typecheck", "test", "build", "start", "selftest", "selftest:blocked", "selftest:live", "doctor"];
const missingScripts = requiredScripts.filter((name) => !packageJson.scripts?.[name]);
checks.push({ key: "scripts", status: missingScripts.length ? "fail" : "pass", detail: missingScripts.length ? `missing: ${missingScripts.join(", ")}` : "all required scripts present" });

const portAvailable = Number.isFinite(port) && port > 0 ? await canListen(port) : true;
checks.push({ key: "serverPort", status: portAvailable ? "pass" : "warn", detail: Number.isFinite(port) ? `port ${port} ${portAvailable ? "available" : "occupied"}` : "invalid port" });
if (!portAvailable) recommendations.push(`Port ${port} is occupied. Use AETHEROPS_PORT or run npm run selftest without --port to use an isolated port.`);

const forbiddenAdapters = grepForbiddenProductionAdapters();
checks.push({ key: "productionMockFallbackAdapters", status: forbiddenAdapters.length ? "fail" : "pass", detail: forbiddenAdapters.length ? forbiddenAdapters.join("; ") : "none found" });
if (forbiddenAdapters.length) recommendations.push("Remove production mock/fallback adapter imports before running live research.");

const legacyRpcGate = fileIncludes(join(repoRoot, "src", "server", "webServer.ts"), "AETHEROPS_ENABLE_LEGACY_RPC");
checks.push({ key: "legacyRpcGate", status: legacyRpcGate ? "pass" : "fail", detail: legacyRpcGate ? "AETHEROPS_ENABLE_LEGACY_RPC gate found" : "legacy RPC gate not found" });

const opencode = assessOpenCode(settings.openCode);
const embedding = assessEmbedding(settings.embedding);
const webSearch = assessWebSearch(settings.webSearch);
const llm = assessLlm(settings.openCodeLlm);
const browser = settings.browserUse?.enabled ? "enabled" : "disabled";
const externalSearch = Boolean(settings.allowExternalSearch);
const codeExecution = Boolean(settings.allowCodeExecution);

const liveReady = llm.ready && opencode.ready && embedding.ready && externalSearch && (webSearch.ready || settings.browserUse?.enabled);
const blockedPathReady = engineStatus === "pass" && !forbiddenAdapters.length;
if (!liveReady) {
  recommendations.push("LIVE_TEST_NOT_READY: configure embedding API key and a web search provider/API key or browser search path before expecting live E2E research to run.");
}
if (embedding.status === "missing_api_key") recommendations.push("Set an embedding API key for the configured provider.");
if (webSearch.status === "disabled") recommendations.push("Configure Web Search provider/API key for web-source live research, or rely on explicitly enabled browser search where appropriate.");

const result = {
  engine: engineStatus,
  nodeVersion: process.version,
  npmVersion: commandText(npmCommand(), ["-v"]),
  dataRoot,
  port,
  portAvailable,
  scripts: missingScripts.length ? "missing" : "pass",
  llm: llm.status,
  opencode: opencode.status,
  opencodeCommand: settings.openCode?.command,
  embedding: embedding.status,
  webSearch: webSearch.status,
  browser,
  allowExternalSearch: externalSearch,
  allowCodeExecution: codeExecution,
  legacyRpcGate: legacyRpcGate ? "pass" : "fail",
  productionMockFallbackAdapters: forbiddenAdapters.length ? "fail" : "pass",
  liveReady,
  blockedPathReady,
  checks,
  recommendations
};

if (jsonMode) {
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} else {
  printHuman(result);
}

process.exit(engineStatus === "fail" || forbiddenAdapters.length || !legacyRpcGate || missingScripts.length ? 1 : 0);

function printHuman(result) {
  console.log("AetherOps Doctor");
  console.log("================");
  console.log(`Node.js: ${result.nodeVersion} (${result.engine})`);
  console.log(`npm: ${result.npmVersion || "unknown"}`);
  console.log(`Data root: ${result.dataRoot}`);
  console.log(`Server port: ${result.port} (${result.portAvailable ? "available" : "occupied"})`);
  console.log(`LLM: ${result.llm}`);
  console.log(`OpenCode: ${result.opencode} (${result.opencodeCommand ?? "not configured"})`);
  console.log(`Embedding: ${result.embedding}`);
  console.log(`Web Search: ${result.webSearch}`);
  console.log(`Browser runtime: ${result.browser}`);
  console.log(`allowExternalSearch: ${result.allowExternalSearch}`);
  console.log(`allowCodeExecution: ${result.allowCodeExecution}`);
  console.log(`Legacy RPC gate: ${result.legacyRpcGate}`);
  console.log(`Production mock/fallback adapters: ${result.productionMockFallbackAdapters}`);
  console.log(`Blocked-path ready: ${result.blockedPathReady}`);
  console.log(`Live-test ready: ${result.liveReady}`);
  if (!result.liveReady) console.log("LIVE_TEST_NOT_READY");
  if (result.recommendations.length) {
    console.log("\nRecommended next actions:");
    for (const item of result.recommendations) console.log(`- ${item}`);
  }
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function readSettings(root) {
  const settingsPath = join(root, "settings.json");
  const defaults = {
    openCodeLlm: { source: "codex-oauth", model: "gpt-5.5" },
    openCode: { enabled: true, command: "opencode", provider: "openai", model: "gpt-5.5", timeoutMs: 180000 },
    webSearch: { provider: "disabled" },
    embedding: { provider: "openai", model: "text-embedding-3-small", dimensions: 1536 },
    browserUse: { enabled: true, mode: "background", maxPages: 2, timeoutMs: 30000, captureScreenshots: true },
    allowExternalSearch: true,
    allowCodeExecution: false
  };
  if (!existsSync(settingsPath)) return defaults;
  const persisted = readJson(settingsPath);
  return {
    ...defaults,
    ...persisted,
    webSearch: { ...defaults.webSearch, ...(persisted.webSearch ?? {}), apiKeyConfigured: usableEncryptedKey(persisted.encryptedWebSearchKey) },
    embedding: { ...defaults.embedding, ...(persisted.embedding ?? {}), apiKeyConfigured: usableEncryptedKey(persisted.encryptedEmbeddingKey) },
    openCodeLlm: persisted.openCodeLlm ?? defaults.openCodeLlm,
    browserUse: { ...defaults.browserUse, ...(persisted.browserUse ?? {}) }
  };
}

function usableEncryptedKey(value) {
  return typeof value === "string" && value.trim().length > 0 && value !== "keep";
}

function assessLlm(llmSettings = {}) {
  if (llmSettings.source === "api") {
    const ready = Boolean(llmSettings.apiKeyConfigured || llmSettings.apiKey);
    return { ready, status: ready ? "available" : "missing_api_key" };
  }
  return { ready: true, status: `configured_${llmSettings.source ?? "codex-oauth"}` };
}

function assessOpenCode(openCode = {}) {
  if (!openCode.enabled) return { ready: false, status: "disabled" };
  if (!openCode.command?.trim()) return { ready: false, status: "missing_command" };
  const bundled = bundledOpenCodeExists();
  const commandAvailable = commandExists(openCode.command) || bundled || /[\\/]/.test(openCode.command);
  return { ready: commandAvailable, status: commandAvailable ? "available" : "command_not_found" };
}

function assessEmbedding(embedding = {}) {
  const provider = embedding.provider ?? "openai";
  if (provider === "local" || provider === "local-hash") return { ready: false, status: "local_embedding_forbidden" };
  const hasKey = Boolean(embedding.apiKeyConfigured || embedding.apiKey);
  const hasBaseUrl = provider !== "custom" || Boolean(embedding.baseUrl);
  return { ready: hasKey && hasBaseUrl, status: hasKey && hasBaseUrl ? "available" : "missing_api_key" };
}

function assessWebSearch(webSearch = {}) {
  if (!webSearch.provider || webSearch.provider === "disabled") return { ready: false, status: "disabled" };
  const hasKey = Boolean(webSearch.apiKeyConfigured || webSearch.apiKey);
  const hasEndpoint = webSearch.provider !== "custom" || Boolean(webSearch.endpoint);
  return { ready: hasKey && hasEndpoint, status: hasKey && hasEndpoint ? "available" : "missing_api_key" };
}

function bundledOpenCodeExists() {
  const candidates = process.platform === "win32"
    ? ["node_modules/opencode-ai/bin/opencode.exe", "node_modules/.bin/opencode.cmd", "node_modules/.bin/opencode"]
    : ["node_modules/.bin/opencode", "node_modules/opencode-ai/bin/opencode", "node_modules/opencode-ai/bin/opencode.exe"];
  return candidates.some((candidate) => existsSync(join(repoRoot, candidate)));
}

function commandExists(command) {
  if (!command || /[\\/]/.test(command)) return false;
  const result = process.platform === "win32"
    ? spawnSync("where.exe", [command], { encoding: "utf8" })
    : spawnSync("sh", ["-lc", `command -v ${JSON.stringify(command)}`], { encoding: "utf8" });
  return result.status === 0;
}

function commandText(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8", shell: process.platform === "win32" });
  return result.status === 0 ? result.stdout.trim() : "";
}

function npmCommand() {
  return process.platform === "win32" ? "npm.cmd" : "npm";
}

async function canListen(port) {
  return new Promise((resolveCanListen) => {
    const server = createServer();
    server.once("error", () => resolveCanListen(false));
    server.once("listening", () => server.close(() => resolveCanListen(true)));
    server.listen(port, "127.0.0.1");
  });
}

function grepForbiddenProductionAdapters() {
  const result = spawnSync("rg", ["-n", "MockOpenCodeAdapter|LocalResearchAdapter|CompositeOpenCodeAdapter", "src", "README.md"], { encoding: "utf8" });
  if (result.status !== 0) return [];
  return result.stdout
    .split(/\r?\n/)
    .filter(Boolean)
    .filter((line) => !/\.test\./.test(line))
    .filter((line) => !/README\.md:.*(금지|policy|fallback 없음|mock 없음|no mock|no fallback)/i.test(line));
}

function fileIncludes(path, needle) {
  return existsSync(path) && readFileSync(path, "utf8").includes(needle);
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
