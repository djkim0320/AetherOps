import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, extname, isAbsolute, join, relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import {
  PRODUCTION_ADAPTER_PATHS,
  PRODUCTION_ADAPTER_PATTERN,
  REQUIRED_SCRIPTS,
  canListen,
  collectMissingScripts,
  forbiddenProductionAdapterLines,
  scanTextForPattern,
  satisfiesNodeEngine
} from "./lib/checks.mjs";

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

const missingScripts = collectMissingScripts(REQUIRED_SCRIPTS, packageJson.scripts ?? {});
checks.push({ key: "scripts", status: missingScripts.length ? "fail" : "pass", detail: missingScripts.length ? `missing: ${missingScripts.join(", ")}` : "all required scripts present" });

const portAvailable = Number.isFinite(port) && port > 0 ? await canListen(port) : true;
checks.push({ key: "serverPort", status: portAvailable ? "pass" : "warn", detail: Number.isFinite(port) ? `port ${port} ${portAvailable ? "available" : "occupied"}` : "invalid port" });
if (!portAvailable) recommendations.push(`Port ${port} is occupied. Use AETHEROPS_PORT or run npm run selftest without --port to use an isolated port.`);

const forbiddenAdapters = grepForbiddenProductionAdapters();
checks.push({ key: "productionSubstituteAdapters", status: forbiddenAdapters.length ? "fail" : "pass", detail: forbiddenAdapters.length ? forbiddenAdapters.join("; ") : "none found" });
if (forbiddenAdapters.length) recommendations.push("Remove production synthetic-substitute adapter imports before running live research.");

const legacyRpcGate = fileIncludes(join(repoRoot, "src", "server", "webServer.ts"), "AETHEROPS_ENABLE_LEGACY_RPC");
checks.push({ key: "legacyRpcGate", status: legacyRpcGate ? "pass" : "fail", detail: legacyRpcGate ? "AETHEROPS_ENABLE_LEGACY_RPC gate found" : "legacy RPC gate not found" });

const opencode = assessOpenCode(settings.openCode);
const embedding = assessEmbedding(settings.embedding);
const webSearch = assessWebSearch(settings.webSearch);
const llm = assessLlm(settings.openCodeLlm);
const researchMetadata = assessResearchMetadata(settings);
const engineeringPrograms = assessEngineeringPrograms(settings);
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
if (!researchMetadata.ready) recommendations.push(`Configure research metadata if paper discovery is expected: ${researchMetadata.status}.`);
if (!engineeringPrograms.ready) recommendations.push(`Configure real engineering programs before expecting LLM solver/tool use: ${engineeringPrograms.status}.`);

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
  researchMetadata: researchMetadata.status,
  engineeringPrograms: engineeringPrograms.status,
  engineeringProgramTargets: engineeringPrograms.targets,
  browser,
  allowExternalSearch: externalSearch,
  allowCodeExecution: codeExecution,
  legacyRpcGate: legacyRpcGate ? "pass" : "fail",
  productionSubstituteAdapters: forbiddenAdapters.length ? "fail" : "pass",
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
  const lines = [
    "AetherOps Doctor",
    "================",
    `Node.js: ${result.nodeVersion} (${result.engine})`,
    `npm: ${result.npmVersion || "unknown"}`,
    `Data root: ${result.dataRoot}`,
    `Server port: ${result.port} (${result.portAvailable ? "available" : "occupied"})`,
    `LLM: ${result.llm}`,
    `OpenCode: ${result.opencode} (${result.opencodeCommand ?? "not configured"})`,
    `Embedding: ${result.embedding}`,
    `Web Search: ${result.webSearch}`,
    `Research Metadata: ${result.researchMetadata}`,
    `Engineering Programs: ${result.engineeringPrograms} (${result.engineeringProgramTargets.join(", ") || "none"})`,
    `Browser runtime: ${result.browser}`,
    `allowExternalSearch: ${result.allowExternalSearch}`,
    `allowCodeExecution: ${result.allowCodeExecution}`,
    `Legacy RPC gate: ${result.legacyRpcGate}`,
    `Production synthetic-substitute adapters: ${result.productionSubstituteAdapters}`,
    `Blocked-path ready: ${result.blockedPathReady}`,
    `Live-test ready: ${result.liveReady}`
  ];
  if (!result.liveReady) lines.push("LIVE_TEST_NOT_READY");
  if (result.recommendations.length) {
    lines.push("", "Recommended next actions:");
    for (const item of result.recommendations) lines.push(`- ${item}`);
  }
  if (process.platform === "win32") {
    lines.push(
      "",
      "Windows note: if Korean text looks garbled in PowerShell output or redirected files, read generated files with `Get-Content -Encoding UTF8 <path>`. For redirected command output, set `$OutputEncoding = [Console]::OutputEncoding = [Text.Encoding]::UTF8` and use `Out-File -Encoding utf8`."
    );
  }
  process.stdout.write(`${lines.join("\n")}\n`);
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8").replace(/^\uFEFF/, ""));
}

function readSettings(root) {
  const settingsPath = join(root, "settings.json");
  const defaults = {
    openCodeLlm: { source: "codex-oauth", model: "gpt-5.5" },
    openCode: { enabled: true, command: "opencode", provider: "openai", model: "gpt-5.5", timeoutMs: 180000 },
    webSearch: { provider: "disabled" },
    embedding: { provider: "openai", model: "text-embedding-3-small", dimensions: 1536 },
    browserUse: { enabled: true, mode: "background", maxPages: 2, timeoutMs: 30000, captureScreenshots: true },
    researchMetadata: { enabled: true, provider: "openalex", maxResults: 5, timeoutMs: 15000 },
    engineeringTools: {
      enabled: false,
      toolchainRoot: "vendor/engineering-tools",
      xfoil: { enabled: false, command: "", timeoutMs: 30000 },
      modeling: { enabled: false, artifactRoot: "", maxMeshBytes: 20 * 1024 * 1024 },
      su2: {
        enabled: false,
        command: "",
        caseRoot: "",
        configFile: "",
        workingDirectory: "",
        probeArgs: ["--help"],
        runArgsTemplate: ["{config}"],
        timeoutMs: 30 * 60 * 1000
      },
      openVsp: {
        enabled: false,
        command: "vspscript",
        scriptPath: "",
        workingDirectory: "",
        probeArgs: ["-help"],
        runArgsTemplate: ["-script", "{script}", "-spec", "{spec}", "-output", "{output}"],
        timeoutMs: 30 * 60 * 1000
      },
      xflr5: {
        enabled: false,
        command: "xflr5",
        scriptPath: "",
        workingDirectory: "",
        probeArgs: ["--help"],
        runArgsTemplate: ["--script", "{script}", "--spec", "{spec}", "--output", "{output}"],
        timeoutMs: 30 * 60 * 1000
      }
    },
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
    browserUse: { ...defaults.browserUse, ...(persisted.browserUse ?? {}) },
    researchMetadata: { ...defaults.researchMetadata, ...(persisted.researchMetadata ?? {}) },
    engineeringTools: {
      enabled: persisted.engineeringTools?.enabled ?? defaults.engineeringTools.enabled,
      toolchainRoot: persisted.engineeringTools?.toolchainRoot ?? defaults.engineeringTools.toolchainRoot,
      xfoil: { ...defaults.engineeringTools.xfoil, ...(persisted.engineeringTools?.xfoil ?? {}) },
      modeling: { ...defaults.engineeringTools.modeling, ...(persisted.engineeringTools?.modeling ?? {}) },
      su2: { ...defaults.engineeringTools.su2, ...(persisted.engineeringTools?.su2 ?? {}) },
      openVsp: {
        ...defaults.engineeringTools.openVsp,
        ...(persisted.engineeringTools?.openVsp ?? {}),
        command: normalizeCommand(persisted.engineeringTools?.openVsp?.command, defaults.engineeringTools.openVsp.command)
      },
      xflr5: {
        ...defaults.engineeringTools.xflr5,
        ...(persisted.engineeringTools?.xflr5 ?? {}),
        command: normalizeCommand(persisted.engineeringTools?.xflr5?.command, defaults.engineeringTools.xflr5.command)
      }
    }
  };
}

function normalizeCommand(value, defaultValue) {
  if (typeof value !== "string") return defaultValue;
  return value.trim() || defaultValue;
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
  const commandAvailable = bundled || /[\\/]/.test(openCode.command) || commandExists(openCode.command);
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

function assessResearchMetadata(settings = {}) {
  if (!settings.allowExternalSearch) return { ready: false, status: "external_search_disabled" };
  if (!settings.researchMetadata?.enabled) return { ready: false, status: "disabled" };
  if (settings.researchMetadata.provider !== "openalex") return { ready: false, status: `unsupported_provider_${settings.researchMetadata.provider}` };
  return { ready: true, status: "openalex_available" };
}

function assessEngineeringPrograms(settings = {}) {
  const tools = settings.engineeringTools ?? {};
  const targets = [];
  if (!settings.allowCodeExecution) return { ready: false, status: "code_execution_disabled", targets };
  if (!tools.enabled) return { ready: false, status: "disabled", targets };
  if (tools.xfoil?.enabled && embeddedToolReady(tools, "xfoil", tools.xfoil.command)) targets.push("xfoil");
  if (tools.modeling?.enabled && directoryExists(tools.modeling.artifactRoot)) targets.push("modeling");
  if (
    tools.su2?.enabled &&
    embeddedToolReady(tools, "su2", tools.su2.command) &&
    su2CaseReady(tools.su2.caseRoot, tools.su2.configFile) &&
    hasRunArgs(tools.su2.runArgsTemplate) &&
    tools.su2.runArgsTemplate.some((arg) => String(arg).includes("{config}"))
  ) targets.push("su2");
  if (scriptedCfdToolReady(tools, "openvsp", tools.openVsp)) targets.push("openvsp");
  if (scriptedCfdToolReady(tools, "xflr5", tools.xflr5)) targets.push("xflr5");
  return { ready: targets.length > 0, status: targets.length ? "available" : "missing_real_program_configuration", targets };
}

function scriptedCfdToolReady(tools = {}, toolName, tool = {}) {
  if (!tool.enabled) return false;
  if (!embeddedToolReady(tools, toolName, tool.command)) return false;
  if (!tool.scriptPath?.trim()) return true;
  return Boolean(
    fileExists(tool.scriptPath) &&
      hasRunArgs(tool.runArgsTemplate) &&
      tool.runArgsTemplate.some((arg) => String(arg).includes("{script}")) &&
      tool.runArgsTemplate.some((arg) => String(arg).includes("{spec}"))
  );
}

function embeddedToolReady(tools = {}, toolName, command) {
  const explicit = normalizeExplicitCommand(command);
  if (explicit) return fileExists(explicit);
  const root = resolve(tools.toolchainRoot || process.env.AETHEROPS_ENGINEERING_TOOLCHAIN_ROOT || "vendor/engineering-tools");
  if (!directoryExists(root)) return false;
  return Boolean(findExecutableInRoot(root, preferredExecutableNames(toolName, command)));
}

function preferredExecutableNames(toolName, command) {
  const defaults = {
    xfoil: ["xfoil.exe", "xfoil"],
    su2: ["SU2_CFD.exe", "SU2_CFD", "su2_cfd.exe", "su2_cfd"],
    openvsp: ["vspscript.exe", "vspscript", "vsp.exe", "vsp"],
    xflr5: ["xflr5.exe", "XFLR5.exe", "xflr5", "XFLR5"]
  }[toolName] ?? [];
  const bare = typeof command === "string" ? command.trim().replace(/^["']|["']$/g, "") : "";
  if (!bare || /[\\/]/.test(bare)) return defaults;
  const names = [basename(bare)];
  if (process.platform === "win32" && !extname(bare)) names.push(`${bare}.exe`);
  for (const item of defaults) {
    if (!names.some((name) => name.toLowerCase() === item.toLowerCase())) names.push(item);
  }
  return names;
}

function findExecutableInRoot(root, names) {
  const queue = [{ directory: root, depth: 0 }];
  while (queue.length) {
    const current = queue.shift();
    let entries = [];
    try {
      entries = readdirSync(current.directory, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name));
    } catch {
      entries = [];
    }
    const filesByName = new Map(entries.filter((entry) => entry.isFile()).map((entry) => [entry.name.toLowerCase(), entry.name]));
    for (const name of names) {
      const fileName = filesByName.get(name.toLowerCase());
      if (fileName) return resolve(current.directory, fileName);
    }
    for (const entry of entries) {
      const child = resolve(current.directory, entry.name);
      const rel = relative(root, child);
      if (rel.startsWith("..") || isAbsolute(rel)) continue;
      if (entry.isDirectory() && current.depth < 6) queue.push({ directory: child, depth: current.depth + 1 });
    }
  }
  return undefined;
}

function normalizeExplicitCommand(command) {
  if (typeof command !== "string") return undefined;
  const trimmed = command.replace(/^["']|["']$/g, "").trim();
  if (!trimmed) return undefined;
  if (isAbsolute(trimmed) || /[\\/]/.test(trimmed)) return resolve(trimmed);
  return undefined;
}

function hasRunArgs(value) {
  return Array.isArray(value) && value.some((arg) => typeof arg === "string" && arg.trim());
}

function su2CaseReady(caseRoot, configFile) {
  if (!directoryExists(caseRoot)) return false;
  if (typeof configFile !== "string" || !configFile.trim()) return false;
  const root = resolve(caseRoot);
  const configPath = resolve(root, configFile.trim());
  const rel = relative(root, configPath);
  if (rel.startsWith("..") || isAbsolute(rel)) return false;
  return fileExists(configPath) && extname(configPath).toLowerCase() === ".cfg";
}

function fileExists(path) {
  if (!path || typeof path !== "string") return false;
  try {
    return statSync(resolve(path)).isFile();
  } catch {
    return false;
  }
}

function directoryExists(path) {
  if (!path || typeof path !== "string") return false;
  try {
    return statSync(resolve(path)).isDirectory();
  } catch {
    return false;
  }
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

function grepForbiddenProductionAdapters() {
  const stdout = scanTextForPattern(PRODUCTION_ADAPTER_PATTERN, PRODUCTION_ADAPTER_PATHS).join("\n");
  return forbiddenProductionAdapterLines(stdout, /README\.md:.*(policy|synthetic|substitute|adapter|none)/i);
}

function fileIncludes(path, needle) {
  return existsSync(path) && readFileSync(path, "utf8").includes(needle);
}
