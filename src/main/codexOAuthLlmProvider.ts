import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { extractJsonObject, type LlmJsonRequest, type LlmProvider } from "../core/llm.js";

interface CodexOAuthLlmProviderOptions {
  codexHome?: string;
  cwd?: string;
  model?: string | (() => string | undefined | Promise<string | undefined>);
  timeoutMs?: number;
}

export class CodexOAuthLlmProvider implements LlmProvider {
  readonly name = "codex-oauth";
  private readonly codexHome: string;
  private readonly cwd: string;
  private readonly model?: string | (() => string | undefined | Promise<string | undefined>);
  private readonly timeoutMs: number;
  private cachedAvailability?: boolean;
  private readonly activeChildren = new Set<ReturnType<typeof spawn>>();

  constructor(options: CodexOAuthLlmProviderOptions = {}) {
    this.codexHome = options.codexHome ?? join(homedir(), ".codex");
    this.cwd = options.cwd ?? process.cwd();
    this.model = options.model;
    this.timeoutMs = options.timeoutMs ?? 180_000;
  }

  async isAvailable(): Promise<boolean> {
    if (this.cachedAvailability === true) {
      return this.cachedAvailability;
    }
    this.cachedAvailability = this.hasUsableCodexOAuth() && (await this.hasCodexCli());
    return this.cachedAvailability;
  }

  async completeJson<T>(request: LlmJsonRequest): Promise<T> {
    if (!(await this.isAvailable())) {
      throw new Error("Codex OAuth is not available. Run `codex login` first.");
    }

    const outputPath = join(tmpdir(), `aetherops-codex-${Date.now()}-${Math.random().toString(16).slice(2)}.txt`);
    const prompt = [
      request.system,
      "",
      "You must return only one valid JSON object. Do not include markdown fences or commentary.",
      `Schema name: ${request.schemaName}`,
      "",
      request.user
    ].join("\n");

    try {
      const raw = await this.runCodexExec(prompt, outputPath, request.timeoutMs ?? this.timeoutMs);
      const finalMessage = readFileIfExists(outputPath) || raw;
      return extractJsonObject(finalMessage) as T;
    } finally {
      rmSync(outputPath, { force: true });
    }
  }

  dispose(): void {
    for (const child of this.activeChildren) {
      child.kill();
    }
    this.activeChildren.clear();
  }

  private hasUsableCodexOAuth(): boolean {
    const authPath = join(this.codexHome, "auth.json");
    if (!existsSync(authPath)) {
      return false;
    }

    try {
      const auth = JSON.parse(readFileSync(authPath, "utf8")) as {
        auth_mode?: string;
        tokens?: {
          access_token?: string;
          refresh_token?: string;
          account_id?: string;
        };
      };
      const usesCodexOAuth = auth.auth_mode === "oauth" || auth.auth_mode === "chatgpt";
      return Boolean(usesCodexOAuth && auth.tokens?.access_token && auth.tokens.refresh_token && auth.tokens.account_id);
    } catch {
      return false;
    }
  }

  private async hasCodexCli(): Promise<boolean> {
    try {
      await this.runCommand(["--version"], "", 10_000);
      return true;
    } catch {
      return false;
    }
  }

  private async runCodexExec(prompt: string, outputPath: string, timeoutMs: number): Promise<string> {
    mkdirSync(dirname(outputPath), { recursive: true });
    writeFileSync(outputPath, "", "utf8");

    const args = [
      "exec",
      "--skip-git-repo-check",
      "--ephemeral",
      "--sandbox",
      "read-only",
      "--output-last-message",
      outputPath,
      "-"
    ];
    const model = await this.resolveModel();
    if (model) {
      args.splice(1, 0, "--model", model);
    }
    return this.runCommand(args, prompt, timeoutMs);
  }

  private async resolveModel(): Promise<string | undefined> {
    return typeof this.model === "function" ? this.model() : this.model;
  }

  private runCommand(args: string[], stdin: string, timeoutMs: number): Promise<string> {
    return new Promise((resolve, reject) => {
      const command = process.platform === "win32" ? "cmd.exe" : "codex";
      const commandArgs = process.platform === "win32" ? ["/d", "/s", "/c", "codex", ...args] : args;
      const child = spawn(command, commandArgs, {
        cwd: this.cwd,
        env: {
          ...process.env,
          CODEX_HOME: this.codexHome
        },
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true
      });
      this.activeChildren.add(child);

      let stdout = "";
      let stderr = "";
      const timer = setTimeout(() => {
        child.kill();
        reject(new Error(`Codex LLM request timed out after ${timeoutMs}ms.`));
      }, timeoutMs);

      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk) => {
        stdout += chunk;
      });
      child.stderr.on("data", (chunk) => {
        stderr += sanitizeCodexOutput(chunk);
      });
      child.on("error", (error) => {
        clearTimeout(timer);
        this.activeChildren.delete(child);
        reject(error);
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        this.activeChildren.delete(child);
        if (code === 0) {
          resolve(stdout);
        } else {
          reject(new Error(`Codex CLI exited with code ${code}: ${stderr || "no stderr"}`));
        }
      });
      child.stdin.end(stdin);
    });
  }
}

function readFileIfExists(path: string): string {
  try {
    return readFileSync(path, "utf8").trim();
  } catch {
    return "";
  }
}

function sanitizeCodexOutput(text: string): string {
  return text.replace(/(access_token|refresh_token|id_token)["'=:\s]+[A-Za-z0-9._-]+/gi, "$1=<redacted>");
}
