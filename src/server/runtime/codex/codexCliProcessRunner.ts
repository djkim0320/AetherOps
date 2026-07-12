import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { decodeStrictUtf8Chunks, readStrictUtf8File } from "../support/strictUtf8.js";
import { resolveBundledCodexCli } from "./bundledCodexCli.js";
import { CodexCliError } from "./codexCliErrors.js";
import { assertCodexCliReadiness } from "./codexCliReadiness.js";
import { permissionProfileArgs } from "./codexPermissionProfiles.js";
import type { CodexCliProcessResult, CodexCliResolution, CodexCliRunRequest, CodexCliStage } from "./codexCliTypes.js";

type Resolver = () => CodexCliResolution;

interface CodexCliProcessRunnerOptions {
  enforcePermissionPreflight?: boolean;
  platform?: NodeJS.Platform;
}

export class CodexCliProcessRunner {
  private readonly children = new Set<ChildProcessWithoutNullStreams>();
  private readonly enforcePermissionPreflight: boolean;
  private readonly platform: NodeJS.Platform;

  constructor(
    private readonly resolveCli: Resolver = resolveBundledCodexCli,
    options: CodexCliProcessRunnerOptions = {}
  ) {
    this.enforcePermissionPreflight = options.enforcePermissionPreflight ?? true;
    this.platform = options.platform ?? process.platform;
  }

  async run(request: CodexCliRunRequest): Promise<CodexCliProcessResult> {
    if (request.signal?.aborted) throw interruptedError(request.signal);
    await emitStage(request, "resolving_cli");
    const resolution = this.resolveCli();
    const started = Date.now();
    const runtimeTemp = join(request.cwd, ".codex-runtime-tmp");
    mkdirSync(runtimeTemp, { recursive: true });
    await this.ensurePermissionProfile(resolution, request);
    await emitStage(request, "authenticating");
    const args = buildExecArgs(request);
    const child = spawn(resolution.command, [...resolution.argsPrefix, ...args], {
      cwd: request.cwd,
      env: safeCodexEnvironment(request.codexHome, runtimeTemp),
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      detached: process.platform !== "win32"
    });
    this.children.add(child);
    await emitStage(request, "running");
    try {
      const raw = await awaitProcess(child, request);
      const stdout = strictDecode(raw.stdout, "Codex JSONL stdout");
      const stderr = sanitizeDiagnostic(strictDecode(raw.stderr, "Codex stderr"));
      const events = parseJsonLines(stdout);
      for (const event of events) await emitStage(request, stageForEvent(event));
      if (raw.exitCode !== 0) throw processFailure(raw.exitCode, stderr, events, request);
      await emitStage(request, "validating_output");
      let lastMessage: string;
      try {
        lastMessage = readStrictUtf8File(request.outputLastMessagePath, "Codex final output").trim();
      } catch (error) {
        throw new CodexCliError("INVALID_OUTPUT", "Codex CLI did not produce a valid UTF-8 final output file.", {}, { cause: error });
      }
      if (!lastMessage) throw new CodexCliError("INVALID_OUTPUT", "Codex CLI produced an empty final output file.");
      await emitStage(request, "terminal");
      return {
        exitCode: 0,
        durationMs: Date.now() - started,
        eventCount: events.length,
        lastMessage,
        terminationReason: "completed"
      };
    } finally {
      this.children.delete(child);
    }
  }

  async dispose(): Promise<void> {
    await Promise.all([...this.children].map((child) => terminateProcessTree(child)));
    this.children.clear();
  }

  private async ensurePermissionProfile(resolution: CodexCliResolution, request: CodexCliRunRequest): Promise<void> {
    if (!this.enforcePermissionPreflight) return;
    await assertCodexCliReadiness({
      resolution,
      cwd: request.cwd,
      codexHome: request.codexHome,
      platform: this.platform,
      profile: request.workspaceProfile,
      timeoutMs: Math.min(request.timeoutMs, 10_000)
    });
  }
}

export function buildExecArgs(request: CodexCliRunRequest): string[] {
  return [
    "exec",
    "--json",
    "--model",
    request.model,
    "-c",
    `model_reasoning_effort="${request.reasoningEffort}"`,
    "-c",
    'web_search="disabled"',
    "-c",
    "features.apps=false",
    "-c",
    "features.multi_agent=false",
    "-c",
    "features.remote_plugin=false",
    "-c",
    'history.persistence="none"',
    "-c",
    'approval_policy="never"',
    ...permissionProfileArgs(request.workspaceProfile),
    "--skip-git-repo-check",
    "--ephemeral",
    "--ignore-user-config",
    "--output-schema",
    request.outputSchemaPath,
    "--output-last-message",
    request.outputLastMessagePath,
    "-"
  ];
}

interface RawProcessResult {
  exitCode: number;
  stdout: Buffer[];
  stderr: Buffer[];
}

function awaitProcess(child: ChildProcessWithoutNullStreams, request: CodexCliRunRequest): Promise<RawProcessResult> {
  return new Promise((resolve, reject) => {
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let terminalError: CodexCliError | undefined;
    let settled = false;
    const finish = (action: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      request.signal?.removeEventListener("abort", abort);
      action();
    };
    const stop = (error: CodexCliError) => {
      terminalError = error;
      void terminateProcessTree(child);
    };
    const abort = () => stop(interruptedError(request.signal));
    const timeout = setTimeout(
      () => stop(new CodexCliError("TIMEOUT", `Codex CLI task timed out after ${request.timeoutMs}ms.`, { timeoutMs: request.timeoutMs })),
      request.timeoutMs
    );
    timeout.unref();
    request.signal?.addEventListener("abort", abort, { once: true });
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", (error) => finish(() => reject(new CodexCliError("PROCESS_FAILED", "Codex CLI process could not be started.", {}, { cause: error }))));
    child.on("close", (code) => finish(() => (terminalError ? reject(terminalError) : resolve({ exitCode: code ?? -1, stdout, stderr }))));
    child.stdin.end(request.prompt, "utf8");
  });
}

async function terminateProcessTree(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (!child.pid || child.exitCode !== null) return;
  if (process.platform === "win32") {
    await new Promise<void>((resolve) => {
      const killer = spawn("taskkill.exe", ["/pid", String(child.pid), "/t", "/f"], { stdio: "ignore", windowsHide: true });
      killer.once("error", () => resolve());
      killer.once("close", () => resolve());
    });
    return;
  }
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    child.kill("SIGTERM");
  }
  const force = setTimeout(() => {
    try {
      process.kill(-child.pid!, "SIGKILL");
    } catch {
      child.kill("SIGKILL");
    }
  }, 5_000);
  force.unref();
}

function safeCodexEnvironment(codexHome: string | undefined, runtimeTemp: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    CODEX_HOME: codexHome?.trim() || process.env.CODEX_HOME?.trim() || join(homedir(), ".codex"),
    HOME: process.env.HOME,
    USERPROFILE: process.env.USERPROFILE,
    SystemRoot: process.env.SystemRoot,
    ComSpec: process.env.ComSpec,
    PATHEXT: process.env.PATHEXT,
    TEMP: runtimeTemp,
    TMP: runtimeTemp,
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
    PYTHONIOENCODING: "utf-8",
    NO_COLOR: "1"
  };
  return Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
}

function strictDecode(chunks: Buffer[], label: string): string {
  try {
    return decodeStrictUtf8Chunks(chunks, label);
  } catch (error) {
    throw new CodexCliError("INVALID_OUTPUT", `${label} is not valid UTF-8.`, {}, { cause: error });
  }
}

function parseJsonLines(stdout: string): Array<Record<string, unknown>> {
  const result: Array<Record<string, unknown>> = [];
  for (const [index, line] of stdout.split(/\r?\n/).entries()) {
    if (!line.trim()) continue;
    try {
      const value = JSON.parse(line) as unknown;
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("event is not an object");
      result.push(value as Record<string, unknown>);
    } catch (error) {
      throw new CodexCliError("INVALID_OUTPUT", `Codex JSONL event ${index + 1} is invalid.`, {}, { cause: error });
    }
  }
  return result;
}

function stageForEvent(event: Record<string, unknown>): CodexCliStage {
  const item = event.item && typeof event.item === "object" ? (event.item as Record<string, unknown>) : undefined;
  const type = `${String(event.type ?? event.event ?? "")} ${String(item?.type ?? "")}`;
  return /tool|command|file|patch/i.test(type) ? "tool_activity" : "running";
}

function processFailure(exitCode: number, stderr: string, events: Array<Record<string, unknown>>, request: CodexCliRunRequest): CodexCliError {
  const diagnostic = sanitizeDiagnostic(stderr || eventFailureDiagnostic(events) || "no diagnostic output");
  if (/(?:usage limit|purchase more credits|not eligible|no access|entitlement|model[^\n]*(?:not available|unsupported|permission))/i.test(diagnostic)) {
    return new CodexCliError("ENTITLEMENT_UNAVAILABLE", `Codex model ${request.model} is unavailable for this account: ${diagnostic}`, { exitCode });
  }
  return new CodexCliError("PROCESS_FAILED", `Codex CLI exited with code ${exitCode}: ${diagnostic}`, { exitCode });
}

function eventFailureDiagnostic(events: Array<Record<string, unknown>>): string {
  for (const event of [...events].reverse()) {
    const nested = event.error && typeof event.error === "object" ? (event.error as Record<string, unknown>).message : undefined;
    const message = typeof nested === "string" ? nested : typeof event.message === "string" ? event.message : undefined;
    if (message?.trim()) return message;
  }
  return "";
}

function interruptedError(signal?: AbortSignal): CodexCliError {
  return new CodexCliError("INTERRUPTED", signal?.reason instanceof Error ? signal.reason.message : "Codex CLI task was interrupted.");
}

function sanitizeDiagnostic(text: string): string {
  return text.replace(/(access_token|refresh_token|id_token|api[_-]?key)["'=:\s]+[^\s,"']+/gi, "$1=<redacted>").slice(-2_000);
}

async function emitStage(request: CodexCliRunRequest, stage: CodexCliStage): Promise<void> {
  await request.onStage?.(stage);
}
