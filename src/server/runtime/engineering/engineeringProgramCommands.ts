import { spawn } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import type { CommandProbeResult, ScriptedCfdConfig, Su2Config } from "../../../core/tools/engineeringProgramTypes.js";
import { terminateProcessTree } from "../process/processTree.js";
import { decodeStrictUtf8Chunks } from "../support/strictUtf8.js";

const MAX_CAPTURE_BYTES = 1024 * 1024;
const MAX_INPUT_BYTES = 1024 * 1024;

export class EngineeringProcessInterruptedError extends Error {
  constructor(cause?: unknown) {
    super("Engineering process execution was interrupted.", cause === undefined ? undefined : { cause });
    this.name = "EngineeringProcessInterruptedError";
  }
}

export class EngineeringProcessOutputLimitError extends Error {
  constructor() {
    super(`Engineering process output exceeded ${MAX_CAPTURE_BYTES} bytes.`);
    this.name = "EngineeringProcessOutputLimitError";
  }
}

export function probeSu2(config: Su2Config, signal?: AbortSignal): Promise<CommandProbeResult> {
  return runCommandWithArgs(config.command as string, config.probeArgs, Math.min(config.timeoutMs, 60_000), config.workingDirectory, signal);
}

export function probeScriptedCfd(config: ScriptedCfdConfig, signal?: AbortSignal): Promise<CommandProbeResult> {
  return runCommandWithArgs(config.command as string, config.probeArgs, Math.min(config.timeoutMs, 60_000), config.workingDirectory, signal);
}

export function assertCommandSucceeded(label: string, result: CommandProbeResult): CommandProbeResult {
  if (result.timedOut || result.exitCode !== 0) {
    throw new Error(
      `${label} failed: exitCode=${result.exitCode ?? "none"}, timedOut=${result.timedOut}, stdout=${result.stdoutExcerpt}, stderr=${result.stderrExcerpt}`
    );
  }
  return result;
}

export function probeXfoil(command: string, timeoutMs: number, signal?: AbortSignal): Promise<CommandProbeResult> {
  return runCommandWithInput(command, "quit\n", timeoutMs, signal);
}

export function runCommandWithInput(command: string, inputText: string, timeoutMs: number, signal?: AbortSignal): Promise<CommandProbeResult> {
  if (Buffer.byteLength(inputText, "utf8") > MAX_INPUT_BYTES) return Promise.reject(new Error(`Engineering process input exceeded ${MAX_INPUT_BYTES} bytes.`));
  return runEngineeringCommand(command, [], timeoutMs, undefined, inputText, signal);
}

export function runCommandWithArgs(
  command: string,
  args: string[],
  timeoutMs: number,
  workingDirectory?: string,
  signal?: AbortSignal
): Promise<CommandProbeResult> {
  return runEngineeringCommand(command, args, timeoutMs, normalizeWorkingDirectory(workingDirectory), undefined, signal);
}

export function normalizeWorkingDirectory(workingDirectory: string | undefined): string | undefined {
  if (!workingDirectory?.trim()) return undefined;
  const resolved = resolve(workingDirectory);
  if (!existsSync(resolved) || !statSync(resolved).isDirectory()) {
    throw new Error(`Configured adapter working directory does not exist: ${resolved}`);
  }
  return resolved;
}

function runEngineeringCommand(
  command: string,
  args: string[],
  timeoutMs: number,
  cwd: string | undefined,
  inputText: string | undefined,
  signal: AbortSignal | undefined
): Promise<CommandProbeResult> {
  if (signal?.aborted) return Promise.reject(new EngineeringProcessInterruptedError(signal.reason));
  return new Promise((resolveProbe, rejectProbe) => {
    const child = spawn(command, args, {
      shell: false,
      windowsHide: true,
      cwd,
      env: engineeringProcessEnvironment(),
      detached: process.platform !== "win32",
      stdio: ["pipe", "pipe", "pipe"]
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let capturedBytes = 0;
    let settled = false;
    let stopping = false;
    const cleanup = (): void => {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abort);
    };
    const finish = (action: () => void): void => {
      if (settled) return;
      settled = true;
      cleanup();
      action();
    };
    const capturedResult = (exitCode: number | null, timedOut: boolean): CommandProbeResult => ({
      command,
      exitCode,
      timedOut,
      stdoutExcerpt: excerpt(decodeStrictUtf8Chunks(stdout, "Engineering process stdout")),
      stderrExcerpt: excerpt(decodeStrictUtf8Chunks(stderr, "Engineering process stderr"))
    });
    const resolveCaptured = (exitCode: number | null, timedOut: boolean): void => {
      try {
        resolveProbe(capturedResult(exitCode, timedOut));
      } catch (error) {
        rejectProbe(error);
      }
    };
    const stop = (outcome: { timedOut: true } | { error: Error }): void => {
      if (settled || stopping) return;
      stopping = true;
      cleanup();
      void terminateProcessTree(child).then(
        () =>
          finish(() => {
            if ("error" in outcome) rejectProbe(outcome.error);
            else resolveCaptured(null, true);
          }),
        (error: unknown) => finish(() => rejectProbe(error))
      );
    };
    const capture = (target: Buffer[], chunk: Buffer): void => {
      if (settled || stopping) return;
      capturedBytes += chunk.byteLength;
      if (capturedBytes > MAX_CAPTURE_BYTES) {
        stop({ error: new EngineeringProcessOutputLimitError() });
        return;
      }
      target.push(Buffer.from(chunk));
    };
    const abort = (): void => stop({ error: new EngineeringProcessInterruptedError(signal?.reason) });
    const timeout = setTimeout(() => stop({ timedOut: true }), timeoutMs);
    timeout.unref();
    signal?.addEventListener("abort", abort, { once: true });
    child.stdout.on("data", (chunk: Buffer) => capture(stdout, chunk));
    child.stderr.on("data", (chunk: Buffer) => capture(stderr, chunk));
    child.stdin.on("error", () => undefined);
    child.on("error", (error) => {
      if (!stopping) finish(() => rejectProbe(error));
    });
    child.on("close", (exitCode) => {
      if (!stopping) finish(() => resolveCaptured(exitCode, false));
    });
    if (inputText === undefined) child.stdin.end();
    else child.stdin.end(inputText, "utf8");
  });
}

function engineeringProcessEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    USERPROFILE: process.env.USERPROFILE,
    SystemRoot: process.env.SystemRoot,
    ComSpec: process.env.ComSpec,
    PATHEXT: process.env.PATHEXT,
    TEMP: process.env.TEMP,
    TMP: process.env.TMP,
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
    PYTHONIOENCODING: "utf-8",
    NO_COLOR: "1"
  };
  return Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
}

function excerpt(value: string): string {
  return value.length > 800 ? `${value.slice(0, 800)}...` : value;
}
