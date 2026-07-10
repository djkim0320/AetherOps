import { spawn } from "node:child_process";
import { decodeStrictUtf8Chunks } from "../support/strictUtf8.js";
import type { OpenCodeRunOutput } from "../../../core/shared/types.js";
import type { OpenCodeCommandResolution } from "./opencodeResolver.js";
import { isWindowsShellCommand } from "./opencodeResolver.js";
import { sanitizeOpenCodeCommandOutput } from "./realOpenCodeOutputSanitizer.js";

export interface OpenCodeProcessResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  recoveredOutput?: OpenCodeRunOutput;
}

export function describeOpenCodeResolution(resolution: OpenCodeCommandResolution): string {
  if (resolution.source === "bundled") {
    return `bundled OpenCode (${resolution.command})`;
  }
  if (resolution.source === "configured") {
    return `configured OpenCode (${resolution.command})`;
  }
  const checked = resolution.checkedPaths.length ? `; checked bundled paths: ${resolution.checkedPaths.join(", ")}` : "";
  return `system OpenCode (${resolution.command})${checked}`;
}

export function createOpenCodeError(message: string, metadata: Record<string, unknown>, cause?: unknown): Error {
  const error = cause instanceof Error ? new Error(message, { cause }) : new Error(message);
  (error as Error & { metadata?: Record<string, unknown> }).metadata = metadata;
  return error;
}

export function getOpenCodeErrorMetadata(error: unknown): Record<string, unknown> | undefined {
  return error && typeof error === "object" && "metadata" in error ? (error as { metadata?: Record<string, unknown> }).metadata : undefined;
}

export function runOpenCodeCommand(
  command: string,
  args: string[],
  timeoutMs: number,
  artifactProbe?: () => OpenCodeRunOutput | undefined
): Promise<OpenCodeProcessResult> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const child = spawn(command, args, {
      windowsHide: true,
      shell: isWindowsShellCommand(command),
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        PYTHONIOENCODING: "utf-8",
        LANG: process.env.LANG ?? "C.UTF-8",
        LC_ALL: process.env.LC_ALL ?? "C.UTF-8"
      }
    });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    const clearTimers = () => {
      clearTimeout(timer);
      if (probeTimer) clearInterval(probeTimer);
    };
    const settleResolve = (result: OpenCodeProcessResult) => {
      if (settled) return;
      settled = true;
      clearTimers();
      resolve(result);
    };
    const settleReject = (error: unknown) => {
      if (settled) return;
      settled = true;
      clearTimers();
      reject(error);
    };
    const timer = setTimeout(() => {
      child.kill();
      settleReject(
        createOpenCodeError(`OpenCode CLI timeout after ${timeoutMs}ms`, {
          timeout: true,
          timeoutMs,
          stdoutTail: sanitizeOpenCodeCommandOutput(decodeCommandTail(stdoutChunks)),
          stderrTail: sanitizeOpenCodeCommandOutput(decodeCommandTail(stderrChunks))
        })
      );
    }, timeoutMs);
    const probeTimer = artifactProbe
      ? setInterval(() => {
          let recoveredOutput: OpenCodeRunOutput | undefined;
          try {
            recoveredOutput = artifactProbe();
          } catch {
            recoveredOutput = undefined;
          }
          if (!recoveredOutput) return;
          child.kill();
          settleResolve({
            stdout: decodeCommandTail(stdoutChunks),
            stderr: sanitizeOpenCodeCommandOutput(decodeCommandTail(stderrChunks)),
            exitCode: 0,
            recoveredOutput
          });
        }, 2_000)
      : undefined;
    child.stdout.on("data", (chunk: Buffer) => {
      stdoutChunks.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderrChunks.push(chunk);
    });
    child.on("error", (error) => {
      settleReject(
        createOpenCodeError(
          error instanceof Error ? error.message : String(error),
          {
            spawnError: true,
            command,
            args,
            stdoutTail: sanitizeOpenCodeCommandOutput(decodeCommandTail(stdoutChunks)),
            stderrTail: sanitizeOpenCodeCommandOutput(decodeCommandTail(stderrChunks))
          },
          error
        )
      );
    });
    child.on("close", (exitCode, signal) => {
      if (settled) return;
      if (signal) {
        settleReject(
          createOpenCodeError(`OpenCode CLI terminated by signal ${signal}`, {
            signal,
            stdoutTail: sanitizeOpenCodeCommandOutput(decodeCommandTail(stdoutChunks)),
            stderrTail: sanitizeOpenCodeCommandOutput(decodeCommandTail(stderrChunks))
          })
        );
        return;
      }
      try {
        settleResolve({
          stdout: decodeStrictUtf8Chunks(stdoutChunks, "OpenCode stdout"),
          stderr: sanitizeOpenCodeCommandOutput(decodeStrictUtf8Chunks(stderrChunks, "OpenCode stderr")),
          exitCode: exitCode ?? 0
        });
      } catch (error) {
        settleReject(
          createOpenCodeError(
            error instanceof Error ? error.message : String(error),
            {
              decodeError: true,
              stdoutTail: sanitizeOpenCodeCommandOutput(decodeCommandTail(stdoutChunks)),
              stderrTail: sanitizeOpenCodeCommandOutput(decodeCommandTail(stderrChunks))
            },
            error
          )
        );
      }
    });
  });
}

function decodeCommandTail(chunks: Buffer[]): string {
  if (!chunks.length) return "";
  return Buffer.concat(chunks)
    .toString("utf8")
    .replace(/\uFFFD/g, "")
    .slice(-2000);
}
