import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { codexSettings, hasEncryptedSecret } from "./settings.mjs";

export function assessCodex(settings) {
  const codex = codexSettings(settings);
  const source = codex.source ?? "codex-oauth";
  const hasApiSecret = Boolean(codex.apiKey || codex.apiKeyConfigured || settings.encryptedLlmKey);
  const valid = source === "codex-oauth" && !hasApiSecret;
  const configured = Boolean(codex.model);
  const catalog = SUPPORTED_CODEX_MODELS.has(codex.model) ? "supported" : "unsupported";
  const effortSupported = isSupportedEffort(codex.model, codex.reasoningEffort);
  const authenticated = hasCodexOAuth(resolve(process.env.CODEX_HOME ?? join(homedir(), ".codex")));
  const sandbox = assessCodexSandbox(process.cwd());
  const cliAvailable = sandbox.cliAvailable;
  const status = !valid
    ? "invalid_non_codex_orchestrator"
    : !configured
      ? "missing_model"
      : catalog === "unsupported"
        ? "unsupported_model"
        : !effortSupported
          ? "unsupported_reasoning_effort"
          : !authenticated
            ? "unauthenticated"
            : !cliAvailable
              ? "cli_unavailable"
              : !sandbox.ready
                ? sandbox.status
                : "access_not_checked";
  return {
    ready: valid && configured && catalog === "supported" && effortSupported && authenticated && cliAvailable && sandbox.ready,
    status,
    catalog,
    access: "not_checked",
    authenticated,
    cliAvailable,
    sandboxReady: sandbox.ready,
    sandboxStatus: sandbox.status,
    sandboxMode: sandbox.mode
  };
}

export function assessCodexSandbox(appRoot, platform = process.platform) {
  const packageRoot = resolve(appRoot, "node_modules", "@openai", "codex");
  const cli = join(packageRoot, "bin", "codex.js");
  if (!fileExists(cli)) return { ready: false, cliAvailable: false, status: "cli_unavailable", mode: platform === "win32" ? "elevated" : "platform-default" };
  if (platform !== "win32") return { ready: true, cliAvailable: true, status: "ready", mode: "platform-default" };
  const root = mkdtempSync(join(tmpdir(), "aetherops-doctor-codex-"));
  try {
    mkdirSync(join(root, "inputs"), { recursive: true });
    mkdirSync(join(root, "outputs"), { recursive: true });
    const profile =
      '{description="AetherOps doctor probe.",filesystem={":root"="deny",":minimal"="read",":tmpdir"="deny",":slash_tmp"="deny",":workspace_roots"={"."="read","inputs"="read","outputs"="write"}},network={enabled=false}}';
    const result = spawnSync(
      process.execPath,
      [
        cli,
        "-c",
        'default_permissions="aetherops-workspace"',
        "-c",
        `permissions.aetherops-workspace=${profile}`,
        "-c",
        'windows.sandbox="elevated"',
        "sandbox",
        "-P",
        "aetherops-workspace",
        "-C",
        root,
        "cmd.exe",
        "/d",
        "/c",
        "exit",
        "0"
      ],
      { encoding: "utf8", timeout: 10_000, windowsHide: true }
    );
    return {
      ready: result.status === 0,
      cliAvailable: true,
      status: result.status === 0 ? "ready" : "elevated_sandbox_unavailable",
      mode: "elevated"
    };
  } catch {
    return { ready: false, cliAvailable: true, status: "sandbox_probe_failed", mode: "elevated" };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function isSupportedEffort(model, effort) {
  if (!SUPPORTED_CODEX_EFFORTS.has(effort)) return false;
  return effort !== "max" || (typeof model === "string" && model.startsWith("gpt-5.6"));
}

export function assessEmbedding(settings) {
  const embedding = settings.embedding ?? {};
  const provider = embedding.provider;
  const secret = hasEncryptedSecret(settings.encryptedEmbeddingKey) || embedding.apiKeyConfigured;
  const remote = provider && provider !== "local" && provider !== "local-hash";
  const endpointReady = provider !== "custom" || Boolean(embedding.baseUrl);
  return {
    ready: Boolean(remote && secret && endpointReady),
    status: !provider ? "not_configured" : remote && secret && endpointReady ? "configured" : "not_ready"
  };
}

export function assessSearch(settings) {
  const search = settings.webSearch ?? settings.search ?? {};
  if (!search.provider || search.provider === "disabled") return { ready: false, status: "disabled" };
  const secret = hasEncryptedSecret(settings.encryptedWebSearchKey) || search.apiKeyConfigured;
  const endpointReady = search.provider !== "custom" || Boolean(search.endpoint);
  return { ready: Boolean(secret && endpointReady), status: secret && endpointReady ? "configured" : "not_ready" };
}

export function assessEngineering(settings) {
  const tools = settings.engineeringTools ?? {};
  if (!tools.enabled) return { ready: false, status: "disabled", targets: [] };
  const targets = [
    ["xfoil", tools.xfoil],
    ["su2", tools.su2],
    ["openvsp", tools.openVsp],
    ["xflr5", tools.xflr5]
  ]
    .filter(([, tool]) => tool?.enabled && commandAvailable(tool.command))
    .map(([name]) => name);
  if (tools.modeling?.enabled && directoryExists(tools.modeling.artifactRoot)) targets.push("modeling");
  return { ready: targets.length > 0, status: targets.length ? "configured" : "commands_unavailable", targets };
}

export function assessFts5() {
  try {
    const database = new DatabaseSync(":memory:");
    database.exec("CREATE VIRTUAL TABLE doctor_fts USING fts5(content)");
    database.close();
    return { ready: true, status: "available" };
  } catch (error) {
    return { ready: false, status: error instanceof Error ? error.message : String(error) };
  }
}

export function commandText(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8", shell: process.platform === "win32" });
  return result.status === 0 ? result.stdout.trim() : "";
}

function commandAvailable(command) {
  if (typeof command !== "string" || !command.trim()) return false;
  if (/[\\/]/.test(command)) return fileExists(command);
  const result =
    process.platform === "win32"
      ? spawnSync("where.exe", [command], { encoding: "utf8" })
      : spawnSync("sh", ["-lc", `command -v ${JSON.stringify(command)}`], { encoding: "utf8" });
  return result.status === 0;
}

function fileExists(path) {
  try {
    return existsSync(path) && statSync(resolve(path)).isFile();
  } catch {
    return false;
  }
}

function directoryExists(path) {
  try {
    return typeof path === "string" && statSync(resolve(path)).isDirectory();
  } catch {
    return false;
  }
}

function hasCodexOAuth(codexHome) {
  try {
    const auth = JSON.parse(readFileText(join(codexHome, "auth.json")));
    const usesOAuth = auth.auth_mode === "oauth" || auth.auth_mode === "chatgpt";
    return Boolean(usesOAuth && auth.tokens?.access_token && auth.tokens?.refresh_token && auth.tokens?.account_id);
  } catch {
    return false;
  }
}

function readFileText(path) {
  if (!existsSync(path)) throw new Error("missing file");
  return readFileSync(path, "utf8").replace(/^\uFEFF/, "");
}

const SUPPORTED_CODEX_MODELS = new Set([
  "gpt-5.6",
  "gpt-5.6-sol",
  "gpt-5.6-terra",
  "gpt-5.6-luna",
  "gpt-5.5",
  "gpt-5.4",
  "gpt-5.4-mini",
  "gpt-5.3-codex-spark"
]);
const SUPPORTED_CODEX_EFFORTS = new Set(["low", "medium", "high", "xhigh", "max"]);
