import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

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
import { assessCodex, assessEmbedding, assessEngineering, assessFts5, assessSearch, commandText } from "./doctor/assessments.mjs";
import { printDoctorResult } from "./doctor/presentation.mjs";
import { capabilitySettings, readPersistedSettings } from "./doctor/settings.mjs";

const repoRoot = process.cwd();
const argumentsSet = new Set(process.argv.slice(2));
const packageJson = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8").replace(/^\uFEFF/, ""));
const dataRoot = resolve(process.env.AETHEROPS_DATA_DIR ?? join(repoRoot, ".aetherops"));
const port = Number(process.env.AETHEROPS_PORT ?? 5179);
const persisted = readPersistedSettings(dataRoot);
const settings = persisted.value;
const recommendations = [];

const engine = satisfiesNodeEngine(process.versions.node, packageJson.engines?.node ?? ">=22.16.0") ? "pass" : "fail";
const missingScripts = collectMissingScripts(REQUIRED_SCRIPTS, packageJson.scripts ?? {});
const portAvailable = Number.isFinite(port) && port > 0 ? await canListen(port) : false;
const forbiddenAdapters = forbiddenProductionAdapterLines(
  scanTextForPattern(PRODUCTION_ADAPTER_PATTERN, PRODUCTION_ADAPTER_PATHS).join("\n"),
  /README\.md:.*(policy|synthetic|substitute|adapter|none)/i
);
const canonicalApiViolations = scanTextForPattern(
  /AETHEROPS_ENABLE_LEGACY_RPC|["'`]\/api\/rpc["'`]|\bopencode\.run\b|\brag\.buildContext\b|\bresults\.derive\b|\breports\.finalize\b/,
  ["src"],
  { extensions: [".ts", ".tsx"] }
).filter((line) => !/\.test\./.test(line));
const apiLlmViolations = scanTextForPattern(/openCodeLlm[^\n]*(?:apiKey|source\s*===\s*["']api)|encryptedApiKey/, ["src/core", "src/server"], {
  extensions: [".ts", ".tsx"]
}).filter((line) => !/\.test\./.test(line));
const codex = assessCodex(settings);
const embedding = assessEmbedding(settings);
const search = assessSearch(settings);
const engineering = assessEngineering(settings);
const fts5 = assessFts5();
const capabilities = capabilitySettings(settings);
const canonicalApiOnly = canonicalApiViolations.length === 0;
const codexOnlySource = apiLlmViolations.length === 0;
const offlineReady = engine === "pass" && fts5.ready && !missingScripts.length && !forbiddenAdapters.length && canonicalApiOnly && codexOnlySource;
const liveReady = offlineReady && persisted.present && codex.ready && embedding.ready && capabilities.agent && (!capabilities.search || search.ready);

if (!persisted.present) recommendations.push("Create settings through the application before running live checks.");
if (!codex.ready) recommendations.push(`Codex orchestrator is not ready (${codex.status}); account model access remains unchecked offline.`);
if (!embedding.ready) recommendations.push("Configure a real remote embedding provider and encrypted API key.");
if (capabilities.search && !search.ready) recommendations.push("Search capability is enabled but its provider is not ready.");
if (!fts5.ready) recommendations.push("Install a Node 22 build with SQLite FTS5 support.");
if (!canonicalApiOnly) recommendations.push(`Remove legacy RPC source references: ${canonicalApiViolations.slice(0, 3).join("; ")}`);
if (!codexOnlySource) recommendations.push(`Move retired API-LLM handling into migration-only code: ${apiLlmViolations.slice(0, 3).join("; ")}`);
if (missingScripts.length) recommendations.push(`Restore required npm scripts: ${missingScripts.join(", ")}.`);

const result = {
  engine,
  nodeVersion: process.version,
  npmVersion: commandText(process.platform === "win32" ? "npm.cmd" : "npm", ["-v"]),
  dataRoot,
  port,
  portAvailable,
  settings: persisted.present ? "present" : "missing",
  codex: codex.status,
  codexCatalog: codex.catalog,
  codexAccess: codex.access,
  codexAuthenticated: codex.authenticated,
  codexCliAvailable: codex.cliAvailable,
  codexSandboxReady: codex.sandboxReady,
  codexSandboxStatus: codex.sandboxStatus,
  codexSandboxMode: codex.sandboxMode,
  embedding: embedding.status,
  search: search.status,
  engineering: engineering.status,
  engineeringTargets: engineering.targets,
  fts5: fts5.status,
  canonicalApiOnly,
  codexOnlySource,
  productionSubstituteAdapters: forbiddenAdapters.length ? "fail" : "pass",
  offlineReady,
  liveReady,
  recommendations
};

if (argumentsSet.has("--json")) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
else printDoctorResult(result);

process.exitCode = offlineReady ? 0 : 1;
