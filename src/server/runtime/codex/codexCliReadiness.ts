import { spawn } from "node:child_process";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { resolveBundledCodexCli } from "./bundledCodexCli.js";
import { CodexCliError } from "./codexCliErrors.js";
import { permissionProfileArgs, permissionProfileName } from "./codexPermissionProfiles.js";
import type { CodexCliResolution, CodexCliRunRequest } from "./codexCliTypes.js";

export type CodexCliReadinessStatus = "ready" | "cli_unavailable" | "elevated_sandbox_unavailable" | "permission_profile_invalid" | "probe_failed";

export interface CodexCliReadiness {
  ready: boolean;
  status: CodexCliReadinessStatus;
  cliAvailable: boolean;
  platform: NodeJS.Platform;
  sandboxMode: "elevated" | "platform-default";
  permissionProfile: string;
  networkPolicy: "disabled";
  version?: string;
  message?: string;
}

export interface CodexCliReadinessOptions {
  appRoot?: string;
  codexHome?: string;
  cwd?: string;
  platform?: NodeJS.Platform;
  profile?: CodexCliRunRequest["workspaceProfile"];
  resolution?: CodexCliResolution;
  timeoutMs?: number;
  execute?: (command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv, timeoutMs: number) => Promise<ProbeResult>;
}

interface ProbeResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

const cached = new Map<string, Promise<CodexCliReadiness>>();

export function probeCodexCliReadiness(options: CodexCliReadinessOptions = {}): Promise<CodexCliReadiness> {
  const platform = options.platform ?? process.platform;
  const profile = options.profile ?? { mode: "workspace", inputsDirectoryName: "inputs", outputsDirectoryName: "outputs" };
  const key = options.execute ? undefined : JSON.stringify({ appRoot: options.appRoot ?? process.cwd(), platform, profile, cwd: options.cwd ?? "temporary" });
  if (!key) return probe({ ...options, platform, profile });
  const existing = cached.get(key);
  if (existing) return existing;
  const pending = probe({ ...options, platform, profile });
  cached.set(key, pending);
  return pending;
}

export async function assertCodexCliReadiness(options: CodexCliReadinessOptions = {}): Promise<CodexCliReadiness> {
  const readiness = await probeCodexCliReadiness(options);
  if (!readiness.ready) {
    throw new CodexCliError("NOT_READY", readiness.message ?? `Codex CLI is not ready: ${readiness.status}.`, {
      status: readiness.status,
      sandboxMode: readiness.sandboxMode,
      permissionProfile: readiness.permissionProfile
    });
  }
  return readiness;
}

async function probe(
  options: CodexCliReadinessOptions & { platform: NodeJS.Platform; profile: CodexCliRunRequest["workspaceProfile"] }
): Promise<CodexCliReadiness> {
  const profileName = permissionProfileName(options.profile);
  let resolution: CodexCliResolution;
  try {
    resolution = options.resolution ?? resolveBundledCodexCli(options.appRoot);
  } catch (error) {
    return status(false, "cli_unavailable", options.platform, profileName, undefined, error);
  }
  if (options.platform !== "win32") return status(true, "ready", options.platform, profileName, resolution.version);
  const ownedRoot = options.cwd ? undefined : await mkdtemp(join(tmpdir(), "aetherops-codex-readiness-"));
  const cwd = options.cwd ?? ownedRoot!;
  try {
    await Promise.all([mkdir(join(cwd, "inputs"), { recursive: true }), mkdir(join(cwd, "outputs"), { recursive: true })]);
    const args = [
      ...resolution.argsPrefix,
      ...permissionProfileArgs(options.profile, options.platform),
      "sandbox",
      "-P",
      profileName,
      "-C",
      cwd,
      "cmd.exe",
      "/d",
      "/c",
      "exit",
      "0"
    ];
    const result = await (options.execute ?? executeProbe)(resolution.command, args, cwd, probeEnvironment(options.codexHome), options.timeoutMs ?? 10_000);
    if (result.exitCode === 0) return status(true, "ready", options.platform, profileName, resolution.version);
    const diagnostic = `${result.stderr} ${result.stdout}`.trim().slice(-1_000);
    const invalidProfile = /permission|filesystem|config|toml/i.test(diagnostic);
    return status(
      false,
      invalidProfile ? "permission_profile_invalid" : "elevated_sandbox_unavailable",
      options.platform,
      profileName,
      resolution.version,
      diagnostic || `Codex sandbox probe exited with code ${result.exitCode}.`
    );
  } catch (error) {
    return status(false, "probe_failed", options.platform, profileName, resolution.version, error);
  } finally {
    if (ownedRoot) {
      try {
        await rm(ownedRoot, { recursive: true, force: true, maxRetries: 4, retryDelay: 50 });
      } catch {
        // Readiness is determined by the completed sandbox process; Windows can briefly retain its cwd handle.
      }
    }
  }
}

function executeProbe(command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv, timeoutMs: number): Promise<ProbeResult> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let settled = false;
    const finish = (exitCode: number) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ exitCode, stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8") });
    };
    const timer = setTimeout(() => {
      terminateProbeProcess(child);
      finish(-1);
    }, timeoutMs);
    timer.unref();
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.once("error", () => finish(-1));
    child.once("close", (code) => finish(code ?? -1));
  });
}

function terminateProbeProcess(child: ReturnType<typeof spawn>): void {
  if (!child.pid || child.exitCode !== null) return;
  if (process.platform === "win32") {
    const killer = spawn("taskkill.exe", ["/pid", String(child.pid), "/t", "/f"], { stdio: "ignore", windowsHide: true });
    killer.once("error", () => child.kill());
    return;
  }
  child.kill("SIGKILL");
}

function probeEnvironment(codexHome?: string): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH,
    SystemRoot: process.env.SystemRoot,
    ComSpec: process.env.ComSpec,
    PATHEXT: process.env.PATHEXT,
    HOME: process.env.HOME,
    USERPROFILE: process.env.USERPROFILE,
    CODEX_HOME: codexHome?.trim() || process.env.CODEX_HOME?.trim() || join(homedir(), ".codex"),
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
    NO_COLOR: "1"
  };
}

function status(
  ready: boolean,
  value: CodexCliReadinessStatus,
  platform: NodeJS.Platform,
  permissionProfile: string,
  version?: string,
  detail?: unknown
): CodexCliReadiness {
  const message = detail instanceof Error ? detail.message : typeof detail === "string" ? detail : undefined;
  return {
    ready,
    status: value,
    cliAvailable: value !== "cli_unavailable",
    platform,
    sandboxMode: platform === "win32" ? "elevated" : "platform-default",
    permissionProfile,
    networkPolicy: "disabled",
    ...(version ? { version } : {}),
    ...(message ? { message } : {})
  };
}
