import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { extractJsonObject, LlmAccessUnavailableError, LlmTimeoutError, type LlmJsonRequest, type LlmProvider } from "../../../core/providers/llm.js";
import type { CodexModelId, CodexReasoningEffort } from "../../../shared/kernel/codexModels.js";
import {
  assertCodexSettings,
  DEFAULT_CODEX_MODEL,
  DEFAULT_CODEX_REASONING_EFFORT,
  DEFAULT_CODEX_TIMEOUT_MS,
  isCodexModelId
} from "../../../shared/kernel/codexModels.js";
import { decodeStrictUtf8Chunks, readStrictUtf8File } from "../support/strictUtf8.js";

export interface CodexExecutionSettings {
  model: CodexModelId;
  reasoningEffort: CodexReasoningEffort;
  timeoutMs: number;
}

export type CodexAccessStatus = "not_checked" | "available" | "unavailable";

export interface CodexOAuthProviderStatus {
  authenticated: boolean;
  cliAvailable: boolean;
  catalog: "supported" | "unsupported";
  access: CodexAccessStatus;
  message?: string;
}

export interface CodexOAuthLlmProviderOptions {
  codexHome?: string;
  cwd?: string;
  settings?: CodexExecutionSettings | (() => CodexExecutionSettings | Promise<CodexExecutionSettings>);
  command?: string;
  commandArgsPrefix?: string[];
}

export class CodexModelUnavailableError extends LlmAccessUnavailableError {
  constructor(message: string, model: string, options?: ErrorOptions) {
    super(message, "codex-oauth", model, options);
    this.name = "CodexModelUnavailableError";
  }
}

const DEFAULT_SETTINGS: CodexExecutionSettings = {
  model: DEFAULT_CODEX_MODEL,
  reasoningEffort: DEFAULT_CODEX_REASONING_EFFORT,
  timeoutMs: DEFAULT_CODEX_TIMEOUT_MS
};

export class CodexOAuthLlmProvider implements LlmProvider {
  readonly name = "codex-oauth";
  private readonly codexHome: string;
  private readonly cwd: string;
  private readonly settings: NonNullable<CodexOAuthLlmProviderOptions["settings"]>;
  private readonly command: string;
  private readonly commandArgsPrefix: string[];
  private cachedLocalAvailability?: { authenticated: boolean; cliAvailable: boolean };
  private readonly modelAccess = new Map<string, { access: Exclude<CodexAccessStatus, "not_checked">; message?: string }>();
  private readonly activeChildren = new Set<ReturnType<typeof spawn>>();

  constructor(options: CodexOAuthLlmProviderOptions = {}) {
    this.codexHome = options.codexHome ?? (process.env.CODEX_HOME?.trim() || join(homedir(), ".codex"));
    this.cwd = options.cwd ?? process.cwd();
    this.settings = options.settings ?? DEFAULT_SETTINGS;
    this.command = options.command ?? "codex";
    this.commandArgsPrefix = options.commandArgsPrefix ?? [];
  }

  async isAvailable(): Promise<boolean> {
    const local = await this.resolveLocalAvailability();
    if (!local.authenticated || !local.cliAvailable) return false;
    const settings = await this.resolveSettings();
    return this.modelAccess.get(settings.model)?.access !== "unavailable";
  }

  async getStatus(): Promise<CodexOAuthProviderStatus> {
    const local = await this.resolveLocalAvailability();
    let catalog: CodexOAuthProviderStatus["catalog"];
    let access: CodexAccessStatus = "not_checked";
    let message: string | undefined;
    try {
      const settings = await this.resolveSettings();
      catalog = isCodexModelId(settings.model) ? "supported" : "unsupported";
      const checked = this.modelAccess.get(settings.model);
      access = checked?.access ?? "not_checked";
      message = checked?.message;
    } catch {
      catalog = "unsupported";
    }
    return {
      ...local,
      catalog,
      access,
      ...(message ? { message } : {})
    };
  }

  async completeJson<T>(request: LlmJsonRequest): Promise<T> {
    const settings = await this.resolveSettings();
    const local = await this.resolveLocalAvailability();
    if (!local.authenticated || !local.cliAvailable) {
      throw new Error("Codex OAuth is not available. Run `codex login` first.");
    }
    const checkedAccess = this.modelAccess.get(settings.model);
    if (checkedAccess?.access === "unavailable") {
      throw new CodexModelUnavailableError(checkedAccess.message ?? `Codex model ${settings.model} is not available for this account.`, settings.model);
    }
    const timeoutMs = settings.timeoutMs;
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
      const raw = await this.runCodexExec(prompt, outputPath, timeoutMs, settings, request.schemaName);
      const finalMessage = readFileIfExists(outputPath) || raw;
      try {
        return extractJsonObject(finalMessage) as T;
      } catch (parseError) {
        const repaired = await this.repairJsonResponse(request, finalMessage, parseError, timeoutMs, settings);
        return extractJsonObject(repaired) as T;
      }
    } finally {
      rmSync(outputPath, { force: true });
    }
  }

  dispose(): void {
    for (const child of this.activeChildren) child.kill();
    this.activeChildren.clear();
  }

  private async resolveLocalAvailability(): Promise<{ authenticated: boolean; cliAvailable: boolean }> {
    if (this.cachedLocalAvailability?.authenticated && this.cachedLocalAvailability.cliAvailable) return this.cachedLocalAvailability;
    const authenticated = this.hasUsableCodexOAuth();
    const cliAvailable = authenticated ? await this.hasCodexCli() : false;
    this.cachedLocalAvailability = { authenticated, cliAvailable };
    return this.cachedLocalAvailability;
  }

  private hasUsableCodexOAuth(): boolean {
    const authPath = join(this.codexHome, "auth.json");
    if (!existsSync(authPath)) return false;
    try {
      const auth = JSON.parse(readFileSync(authPath, "utf8")) as {
        auth_mode?: string;
        tokens?: { access_token?: string; refresh_token?: string; account_id?: string };
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

  private async resolveSettings(): Promise<CodexExecutionSettings> {
    const value = typeof this.settings === "function" ? await this.settings() : this.settings;
    assertCodexSettings(value);
    return value;
  }

  private async runCodexExec(prompt: string, outputPath: string, timeoutMs: number, settings: CodexExecutionSettings, schemaName?: string): Promise<string> {
    mkdirSync(dirname(outputPath), { recursive: true });
    writeFileSync(outputPath, "", "utf8");
    const args = [
      "exec",
      "--model",
      settings.model,
      "-c",
      'service_tier="fast"',
      "-c",
      `model_reasoning_effort="${settings.reasoningEffort}"`,
      "--skip-git-repo-check",
      "--ephemeral",
      "--sandbox",
      "read-only",
      "--output-last-message",
      outputPath,
      "-"
    ];
    try {
      const output = await this.runCommand(args, prompt, timeoutMs, schemaName, settings.model);
      this.modelAccess.set(settings.model, { access: "available" });
      return output;
    } catch (error) {
      if (error instanceof CodexModelUnavailableError) {
        this.modelAccess.set(settings.model, { access: "unavailable", message: error.message });
      }
      throw error;
    }
  }

  private async repairJsonResponse(
    request: LlmJsonRequest,
    invalidResponse: string,
    parseError: unknown,
    timeoutMs: number,
    settings: CodexExecutionSettings
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
      const raw = await this.runCodexExec(repairPrompt, repairOutputPath, Math.min(timeoutMs, 120_000), settings, request.schemaName);
      return readFileIfExists(repairOutputPath) || raw;
    } catch (repairError) {
      if (repairError instanceof CodexModelUnavailableError) throw repairError;
      throw new Error(`LLM JSON parsing failed and repair failed: ${formatParseError(parseError)}; ${formatParseError(repairError)}`, {
        cause: repairError
      });
    } finally {
      rmSync(repairOutputPath, { force: true });
    }
  }

  private runCommand(args: string[], stdin: string, timeoutMs: number, schemaName?: string, model?: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const useWindowsCodexWrapper = process.platform === "win32" && this.command === "codex";
      const command = useWindowsCodexWrapper ? "cmd.exe" : this.command;
      const commandArgs = useWindowsCodexWrapper ? ["/d", "/s", "/c", "codex", ...args] : [...this.commandArgsPrefix, ...args];
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
      let settled = false;
      let timeoutError: LlmTimeoutError | undefined;
      const finish = (action: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.activeChildren.delete(child);
        action();
      };
      const timer = setTimeout(() => {
        timeoutError = new LlmTimeoutError(`Codex LLM request timed out after ${timeoutMs}ms.`, {
          provider: this.name,
          model,
          timeoutMs,
          promptLength: stdin.length,
          promptTokenEstimate: Math.ceil(stdin.length / 4),
          retryAttempt: 0,
          step: schemaName === "AetherOpsResearchPlan" ? "PLAN_RESEARCH" : undefined,
          schemaName
        });
        child.kill();
      }, timeoutMs);
      child.stdout.on("data", (chunk: Buffer) => stdoutChunks.push(chunk));
      child.stderr.on("data", (chunk: Buffer) => stderrChunks.push(chunk));
      child.on("error", (error) => finish(() => reject(timeoutError ?? error)));
      child.on("close", (code) =>
        finish(() => {
          if (timeoutError) return reject(timeoutError);
          const stdout = decodeCodexCliStream(stdoutChunks, "Codex stdout");
          const stderr = sanitizeCodexOutput(decodeCodexCliStream(stderrChunks, "Codex stderr"));
          if (code === 0) return resolve(stdout);
          const message = `Codex CLI exited with code ${code}: ${stderr || "no stderr"}`;
          if (model && isModelAccessError(stderr)) return reject(new CodexModelUnavailableError(message, model));
          reject(new Error(message));
        })
      );
      child.stdin.end(stdin);
    });
  }
}

function readFileIfExists(path: string): string {
  if (!existsSync(path)) return "";
  return readStrictUtf8File(path, `Codex output file ${path}`).trim();
}

function decodeCodexCliStream(chunks: Buffer[], label: string): string {
  try {
    return decodeStrictUtf8Chunks(chunks, label);
  } catch {
    const decoded = Buffer.concat(chunks)
      .toString("utf8")
      .replace(/\uFFFD/g, "");
    return decoded.trim() ? decoded : `${label} was not valid UTF-8.`;
  }
}

function sanitizeCodexOutput(text: string): string {
  return text.replace(/(access_token|refresh_token|id_token)["'=:\s]+[A-Za-z0-9._-]+/gi, "$1=<redacted>");
}

function isModelAccessError(stderr: string): boolean {
  return /(?:model[^\n]*(?:not found|not available|unsupported|access|entitlement)|(?:access|permission|entitlement|eligible|account)[^\n]*(?:model|gpt-)|(?:not eligible|no access)[^\n]*gpt-)/i.test(
    stderr
  );
}

function formatParseError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
