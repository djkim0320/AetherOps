import { spawn } from "node:child_process";
import type { AppSettings } from "../../core/types.js";
import { isWindowsShellCommand, resolveOpenCodeCommand } from "./opencodeResolver.js";
import { decodeStrictUtf8Chunks } from "./strictUtf8.js";

export interface OpenCodeAuthResult {
  ok: boolean;
  message: string;
  output?: string;
}

export async function launchOpenCodeAuthLogin(settings: AppSettings, provider?: string): Promise<OpenCodeAuthResult> {
  const resolution = resolveOpenCodeCommand(settings.openCode.command);
  const command = resolution.command;
  const args = ["auth", "login", ...(provider ? [provider] : [])];

  if (process.platform === "win32") {
    const commandLine = [quoteForCmd(command), ...args.map(quoteForCmd)].join(" ");
    const child = spawn("cmd.exe", ["/d", "/s", "/c", `start "" cmd /k ${quoteForCmd(commandLine)}`], {
      detached: true,
      env: utf8ChildEnv(),
      stdio: "ignore",
      windowsHide: false
    });
    child.unref();
    return {
      ok: true,
      message: `OpenCode OAuth 로그인 창을 열었습니다. provider: ${provider || "대화형 선택"}`
    };
  }

  const child = spawn(command, args, {
    detached: true,
    env: utf8ChildEnv(),
    stdio: "ignore",
    windowsHide: false
  });
  child.unref();
  return {
    ok: true,
    message: `OpenCode OAuth 로그인을 시작했습니다. provider: ${provider || "대화형 선택"}`
  };
}

export function listOpenCodeAuth(settings: AppSettings): Promise<OpenCodeAuthResult> {
  const resolution = resolveOpenCodeCommand(settings.openCode.command);
  return runCapture(resolution.command, ["auth", "list"], settings.openCode.timeoutMs || 30_000);
}

function runCapture(command: string, args: string[], timeoutMs: number): Promise<OpenCodeAuthResult> {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      windowsHide: true,
      shell: isWindowsShellCommand(command),
      env: utf8ChildEnv(),
      stdio: ["ignore", "pipe", "pipe"]
    });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    const timer = setTimeout(() => {
      child.kill();
      resolve({
        ok: false,
        message: `OpenCode auth 명령이 ${timeoutMs}ms 안에 끝나지 않았습니다.`,
        output: decodeCapturedOutput(stdoutChunks, stderrChunks)
      });
    }, timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => {
      stdoutChunks.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderrChunks.push(chunk);
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({
        ok: false,
        message: `OpenCode auth 명령 실행 실패: ${error.message}`,
        output: decodeCapturedOutput(stdoutChunks, stderrChunks)
      });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      let stdout = "";
      let stderr = "";
      try {
        stdout = decodeStrictUtf8Chunks(stdoutChunks, "OpenCode auth stdout");
        stderr = decodeStrictUtf8Chunks(stderrChunks, "OpenCode auth stderr");
      } catch (error) {
        resolve({
          ok: false,
          message: error instanceof Error ? error.message : String(error),
          output: ""
        });
        return;
      }
      resolve({
        ok: code === 0,
        message: code === 0 ? "OpenCode 인증 목록을 확인했습니다." : `OpenCode auth list 종료 코드: ${code ?? "unknown"}`,
        output: [stdout.trim(), stderr.trim()].filter(Boolean).join("\n")
      });
    });
  });
}

function utf8ChildEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    PYTHONIOENCODING: "utf-8",
    LANG: process.env.LANG ?? "C.UTF-8",
    LC_ALL: process.env.LC_ALL ?? "C.UTF-8"
  };
}

function decodeCapturedOutput(stdoutChunks: Buffer[], stderrChunks: Buffer[]): string {
  try {
    return decodeStrictUtf8Chunks(stderrChunks, "OpenCode auth stderr") || decodeStrictUtf8Chunks(stdoutChunks, "OpenCode auth stdout");
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

function quoteForCmd(value: string): string {
  return `"${value.replace(/"/g, "\\\"")}"`;
}
