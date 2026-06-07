import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { extractJsonObject, LlmTimeoutError, type LlmJsonRequest, type LlmProvider } from "../../core/llm.js";
import { decodeStrictUtf8Chunks, readStrictUtf8File } from "./strictUtf8.js";

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
      const raw = await this.runCodexExec(prompt, outputPath, request.timeoutMs ?? this.timeoutMs, request.schemaName);
      const finalMessage = readFileIfExists(outputPath) || raw;
      try {
        return extractJsonObject(finalMessage) as T;
      } catch (parseError) {
        const repaired = await this.repairJsonResponse(request, finalMessage, parseError, request.timeoutMs ?? this.timeoutMs);
        return extractJsonObject(repaired) as T;
      }
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

  private async runCodexExec(prompt: string, outputPath: string, timeoutMs: number, schemaName?: string): Promise<string> {
    mkdirSync(dirname(outputPath), { recursive: true });
    writeFileSync(outputPath, "", "utf8");

    const args = [
      "exec",
      "-c",
      'service_tier="fast"',
      "-c",
      'model_reasoning_effort="xhigh"',
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
    return this.runCommand(args, prompt, timeoutMs, schemaName, model);
  }

  private async resolveModel(): Promise<string | undefined> {
    return typeof this.model === "function" ? this.model() : this.model;
  }

  private async repairJsonResponse(
    request: LlmJsonRequest,
    invalidResponse: string,
    parseError: unknown,
    timeoutMs: number
  ): Promise<string> {
    const repairOutputPath = join(tmpdir(), `aetherops-codex-repair-${Date.now()}-${Math.random().toString(16).slice(2)}.txt`);
    const repairPrompt = [
      "The previous response for an AetherOps JSON-only request was invalid JSON.",
      "Return exactly one valid JSON object. Do not add markdown fences or commentary.",
      `Schema name: ${request.schemaName}`,
      `Parse error: ${formatParseError(parseError)}`,
      "",
      "Original system instruction:",
      request.system,
      "",
      "Original user instruction:",
      request.user.slice(0, 12_000),
      "",
      "Invalid response to repair:",
      invalidResponse.slice(0, 20_000)
    ].join("\n");

    try {
      const raw = await this.runCodexExec(repairPrompt, repairOutputPath, Math.min(timeoutMs, 120_000), request.schemaName);
      return readFileIfExists(repairOutputPath) || raw;
    } catch (repairError) {
      throw new Error(`LLM JSON parsing failed and repair failed: ${formatParseError(parseError)}; ${formatParseError(repairError)}`);
    } finally {
      rmSync(repairOutputPath, { force: true });
    }
  }

  private runCommand(args: string[], stdin: string, timeoutMs: number, schemaName?: string, model?: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const command = process.platform === "win32" ? "cmd.exe" : "codex";
      const commandArgs = process.platform === "win32" ? ["/d", "/s", "/c", "codex", ...args] : args;
      const child = spawn(command, commandArgs, {
        cwd: this.cwd,
        env: {
          ...process.env,
          CODEX_HOME: this.codexHome,
          PYTHONIOENCODING: "utf-8",
          LANG: process.env.LANG ?? "C.UTF-8",
          LC_ALL: process.env.LC_ALL ?? "C.UTF-8"
        },
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true
      });
      this.activeChildren.add(child);

      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];
      const timer = setTimeout(() => {
        child.kill();
        reject(new LlmTimeoutError(`Codex LLM request timed out after ${timeoutMs}ms.`, {
          provider: this.name,
          model,
          timeoutMs,
          promptLength: stdin.length,
          promptTokenEstimate: Math.ceil(stdin.length / 4),
          retryAttempt: 0,
          step: schemaName === "AetherOpsResearchPlan" ? "PLAN_RESEARCH" : undefined,
          schemaName
        }));
      }, timeoutMs);

      child.stdout.on("data", (chunk: Buffer) => {
        stdoutChunks.push(chunk);
      });
      child.stderr.on("data", (chunk: Buffer) => {
        stderrChunks.push(chunk);
      });
      child.on("error", (error) => {
        clearTimeout(timer);
        this.activeChildren.delete(child);
        reject(error);
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        this.activeChildren.delete(child);
        let stdout = "";
        let stderr = "";
        stdout = decodeCodexCliStream(stdoutChunks, "Codex stdout");
        stderr = sanitizeCodexOutput(decodeCodexCliStream(stderrChunks, "Codex stderr"));
        if (code === 0) {
          resolve(stdout);
          return;
        }
        reject(new Error(`Codex CLI exited with code ${code}: ${stderr || "no stderr"}`));
      });
      child.stdin.end(stdin);
    });
  }
}

function readFileIfExists(path: string): string {
  if (!existsSync(path)) {
    return "";
  }
  return readStrictUtf8File(path, `Codex output file ${path}`).trim();
}

function decodeCodexCliStream(chunks: Buffer[], label: string): string {
  try {
    return decodeStrictUtf8Chunks(chunks, label);
  } catch {
    const decoded = Buffer.concat(chunks).toString("utf8").replace(/\uFFFD/g, "");
    return decoded.trim() ? decoded : `${label} was not valid UTF-8.`;
  }
}

function sanitizeCodexOutput(text: string): string {
  return text.replace(/(access_token|refresh_token|id_token)["'=:\s]+[A-Za-z0-9._-]+/gi, "$1=<redacted>");
}

function formatParseError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
