import { spawn } from "node:child_process";
import type { AppSettings } from "../../core/types.js";
import { isWindowsShellCommand, resolveOpenCodeCommand } from "./opencodeResolver.js";

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
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      resolve({
        ok: false,
        message: `OpenCode auth 명령이 ${timeoutMs}ms 안에 끝나지 않았습니다.`,
        output: stderr || stdout
      });
    }, timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({
        ok: false,
        message: `OpenCode auth 명령 실행 실패: ${error.message}`,
        output: stderr || stdout
      });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({
        ok: code === 0,
        message: code === 0 ? "OpenCode 인증 목록을 확인했습니다." : `OpenCode auth list 종료 코드: ${code ?? "unknown"}`,
        output: [stdout.trim(), stderr.trim()].filter(Boolean).join("\n")
      });
    });
  });
}

function quoteForCmd(value: string): string {
  return `"${value.replace(/"/g, "\\\"")}"`;
}
