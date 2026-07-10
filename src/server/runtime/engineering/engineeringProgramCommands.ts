import { spawn } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import type { CommandProbeResult, ScriptedCfdConfig, Su2Config } from "../../../core/tools/engineeringProgramTypes.js";

export function probeSu2(config: Su2Config): Promise<CommandProbeResult> {
  return runCommandWithArgs(config.command as string, config.probeArgs, Math.min(config.timeoutMs, 60_000), config.workingDirectory);
}

export function probeScriptedCfd(config: ScriptedCfdConfig): Promise<CommandProbeResult> {
  return runCommandWithArgs(config.command as string, config.probeArgs, Math.min(config.timeoutMs, 60_000), config.workingDirectory);
}

export function assertCommandSucceeded(label: string, result: CommandProbeResult): CommandProbeResult {
  if (result.timedOut || result.exitCode !== 0) {
    throw new Error(
      `${label} failed: exitCode=${result.exitCode ?? "none"}, timedOut=${result.timedOut}, stdout=${result.stdoutExcerpt}, stderr=${result.stderrExcerpt}`
    );
  }
  return result;
}

export function probeXfoil(command: string, timeoutMs: number): Promise<CommandProbeResult> {
  return runCommandWithInput(command, "quit\n", timeoutMs);
}

export function runCommandWithInput(command: string, inputText: string, timeoutMs: number): Promise<CommandProbeResult> {
  return new Promise((resolveProbe, rejectProbe) => {
    const child = spawn(command, [], { shell: false, windowsHide: true });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timeout = setTimeout(() => {
      settled = true;
      child.kill();
      resolveProbe({ command, exitCode: null, timedOut: true, stdoutExcerpt: excerpt(stdout), stderrExcerpt: excerpt(stderr) });
    }, timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      rejectProbe(error);
    });
    child.on("close", (exitCode) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolveProbe({ command, exitCode, timedOut: false, stdoutExcerpt: excerpt(stdout), stderrExcerpt: excerpt(stderr) });
    });
    child.stdin.end(inputText);
  });
}

export function runCommandWithArgs(command: string, args: string[], timeoutMs: number, workingDirectory?: string): Promise<CommandProbeResult> {
  return new Promise((resolveProbe, rejectProbe) => {
    const cwd = normalizeWorkingDirectory(workingDirectory);
    const child = spawn(command, args, { shell: false, windowsHide: true, cwd });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timeout = setTimeout(() => {
      settled = true;
      child.kill();
      resolveProbe({ command, exitCode: null, timedOut: true, stdoutExcerpt: excerpt(stdout), stderrExcerpt: excerpt(stderr) });
    }, timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      rejectProbe(error);
    });
    child.on("close", (exitCode) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolveProbe({ command, exitCode, timedOut: false, stdoutExcerpt: excerpt(stdout), stderrExcerpt: excerpt(stderr) });
    });
  });
}

export function normalizeWorkingDirectory(workingDirectory: string | undefined): string | undefined {
  if (!workingDirectory?.trim()) return undefined;
  const resolved = resolve(workingDirectory);
  if (!existsSync(resolved) || !statSync(resolved).isDirectory()) {
    throw new Error(`Configured adapter working directory does not exist: ${resolved}`);
  }
  return resolved;
}

function excerpt(value: string): string {
  return value.length > 800 ? `${value.slice(0, 800)}...` : value;
}
