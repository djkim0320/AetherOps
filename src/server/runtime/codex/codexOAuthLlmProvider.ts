import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { LlmAccessUnavailableError, LlmTimeoutError, type LlmJsonCompletion, type LlmJsonRequest, type LlmProvider } from "../../../core/providers/llm.js";
import type { CodexModelId, CodexReasoningEffort } from "../../../shared/kernel/codexModels.js";
import { assertCodexSettings, DEFAULT_CODEX_MODEL, DEFAULT_CODEX_REASONING_EFFORT, DEFAULT_CODEX_TIMEOUT_MS } from "../../../shared/kernel/codexModels.js";
import { resolveBundledCodexCli } from "./bundledCodexCli.js";
import { CodexCliError } from "./codexCliErrors.js";
import { probeCodexCliReadiness, type CodexCliReadiness } from "./codexCliReadiness.js";
import { CodexCliProcessRunner } from "./codexCliProcessRunner.js";
import { normalizeCodexOutputSchema } from "./codexOutputSchema.js";
import { attachInvocationMetadata, formatParseError, parseAndValidateResponse, safeValidationError, sha256 } from "./llmInvocation.js";

export interface CodexExecutionSettings {
  model: CodexModelId;
  reasoningEffort: CodexReasoningEffort;
  timeoutMs: number;
}

export interface CodexOAuthLlmProviderOptions {
  appRoot?: string;
  codexHome?: string;
  settings?: CodexExecutionSettings | (() => CodexExecutionSettings | Promise<CodexExecutionSettings>);
  runner?: CodexCliProcessRunner;
}

export class CodexModelUnavailableError extends LlmAccessUnavailableError {
  constructor(message: string, model: string, options?: ErrorOptions) {
    super(message, "codex-oauth", model, options);
    this.name = "CodexModelUnavailableError";
  }
}

const defaults: CodexExecutionSettings = {
  model: DEFAULT_CODEX_MODEL,
  reasoningEffort: DEFAULT_CODEX_REASONING_EFFORT,
  timeoutMs: DEFAULT_CODEX_TIMEOUT_MS
};

export class CodexOAuthLlmProvider implements LlmProvider {
  readonly name = "codex-oauth";
  private readonly codexHome: string;
  private readonly runner: CodexCliProcessRunner;
  private readonly settings: NonNullable<CodexOAuthLlmProviderOptions["settings"]>;
  private access: "not_checked" | "available" | "unavailable" = "not_checked";

  constructor(private readonly options: CodexOAuthLlmProviderOptions = {}) {
    this.codexHome = options.codexHome ?? process.env.CODEX_HOME?.trim() ?? join(homedir(), ".codex");
    this.settings = options.settings ?? defaults;
    this.runner = options.runner ?? new CodexCliProcessRunner(() => resolveBundledCodexCli(options.appRoot));
  }

  async isAvailable(): Promise<boolean> {
    if (!hasOAuth(this.codexHome) || this.access === "unavailable") return false;
    try {
      resolveBundledCodexCli(this.options.appRoot);
      return true;
    } catch {
      return false;
    }
  }

  async getStatus(): Promise<{
    authenticated: boolean;
    cliAvailable: boolean;
    catalog: "supported";
    access: "not_checked" | "available" | "unavailable";
    sandbox: CodexCliReadiness;
  }> {
    let cliAvailable: boolean;
    try {
      resolveBundledCodexCli(this.options.appRoot);
      cliAvailable = true;
    } catch {
      cliAvailable = false;
    }
    const sandbox = await probeCodexCliReadiness({ appRoot: this.options.appRoot, codexHome: this.codexHome });
    return { authenticated: hasOAuth(this.codexHome), cliAvailable, catalog: "supported", access: this.access, sandbox };
  }

  async completeJson<T>(request: LlmJsonRequest<T>): Promise<T> {
    return (await this.completeJsonWithMetadata(request)).value;
  }

  async completeJsonWithMetadata<T>(request: LlmJsonRequest<T>): Promise<LlmJsonCompletion<T>> {
    const settings = await this.resolveSettings();
    const startedAt = new Date().toISOString();
    const started = Date.now();
    const prompt = completionPrompt(request);
    let repairCount: 0 | 1 = 0;
    const validationErrors: string[] = [];
    try {
      if (!hasOAuth(this.codexHome)) throw new Error("Codex OAuth is not available. Run `codex login` first.");
      const first = await this.invoke(request, prompt, settings);
      let value: T;
      try {
        value = parseAndValidateResponse(request, first);
      } catch (error) {
        validationErrors.push(safeValidationError(error));
        repairCount = 1;
        const repaired = await this.invoke(request, repairPrompt(request, first, error), settings);
        try {
          value = parseAndValidateResponse(request, repaired);
        } catch (repairError) {
          validationErrors.push(safeValidationError(repairError));
          throw new Error(`LLM JSON schema validation failed after one repair: ${formatParseError(error)}; ${formatParseError(repairError)}`, {
            cause: repairError
          });
        }
      }
      this.access = "available";
      const completedAt = new Date().toISOString();
      return {
        value,
        metadata: metadata(
          request,
          settings,
          prompt,
          startedAt,
          completedAt,
          Date.now() - started,
          repairCount,
          "completed",
          JSON.stringify(value),
          validationErrors
        )
      };
    } catch (error) {
      const mapped = mapCliError(error, settings, request, prompt.length);
      if (mapped instanceof CodexModelUnavailableError) this.access = "unavailable";
      attachInvocationMetadata(
        mapped,
        metadata(request, settings, prompt, startedAt, new Date().toISOString(), Date.now() - started, repairCount, "failed", undefined, validationErrors)
      );
      throw mapped;
    }
  }

  dispose(): void {
    void this.runner.dispose();
  }

  private async resolveSettings(): Promise<CodexExecutionSettings> {
    const value = typeof this.settings === "function" ? await this.settings() : this.settings;
    assertCodexSettings({ ...value, taskTimeoutMs: value.timeoutMs });
    return value;
  }

  private async invoke<T>(request: LlmJsonRequest<T>, prompt: string, settings: CodexExecutionSettings): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), "aetherops-codex-planner-"));
    const schemaPath = join(root, "result.schema.json");
    const outputPath = join(root, "result.json");
    try {
      const schema = request.schema
        ? normalizeCodexOutputSchema(z.toJSONSchema(request.schema))
        : { type: "object", additionalProperties: false, properties: {}, required: [] };
      await writeFile(schemaPath, `${JSON.stringify(schema, null, 2)}\n`, "utf8");
      const result = await this.runner.run({
        cwd: root,
        prompt,
        model: settings.model,
        reasoningEffort: settings.reasoningEffort,
        timeoutMs: settings.timeoutMs,
        outputSchemaPath: schemaPath,
        outputLastMessagePath: outputPath,
        workspaceProfile: { mode: "read-only" },
        codexHome: this.codexHome
      });
      return result.lastMessage;
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 125 });
    }
  }
}

function hasOAuth(codexHome: string): boolean {
  const path = join(codexHome, "auth.json");
  if (!existsSync(path)) return false;
  try {
    const auth = JSON.parse(readFileSync(path, "utf8")) as { auth_mode?: string; tokens?: Record<string, string> };
    return Boolean(
      (auth.auth_mode === "oauth" || auth.auth_mode === "chatgpt") && auth.tokens?.access_token && auth.tokens.refresh_token && auth.tokens.account_id
    );
  } catch {
    return false;
  }
}

function completionPrompt(request: LlmJsonRequest): string {
  return [
    request.system,
    "",
    "Return exactly one JSON object matching the supplied output schema.",
    `Schema name: ${request.schemaName}`,
    "",
    request.user
  ].join("\n");
}

function repairPrompt(request: LlmJsonRequest, response: string, error: unknown): string {
  return [
    "Repair the previous JSON response. Return exactly one object matching the supplied output schema.",
    `Schema name: ${request.schemaName}`,
    `Validation error: ${safeValidationError(error)}`,
    "",
    request.user.slice(0, 12_000),
    "",
    response.slice(0, 20_000)
  ].join("\n");
}

function mapCliError(error: unknown, settings: CodexExecutionSettings, request: LlmJsonRequest, promptLength: number): Error {
  if (!(error instanceof CodexCliError)) return error instanceof Error ? error : new Error(String(error));
  if (error.kind === "ENTITLEMENT_UNAVAILABLE") return new CodexModelUnavailableError(error.message, settings.model, { cause: error });
  if (error.kind === "NOT_READY") return new LlmAccessUnavailableError(error.message, "codex-oauth", settings.model, { cause: error });
  if (error.kind === "TIMEOUT") {
    return new LlmTimeoutError(error.message, {
      provider: "codex-oauth",
      model: settings.model,
      timeoutMs: settings.timeoutMs,
      promptLength,
      promptTokenEstimate: Math.ceil(promptLength / 4),
      retryAttempt: 0,
      schemaName: request.schemaName
    });
  }
  return error;
}

function metadata(
  request: LlmJsonRequest,
  settings: CodexExecutionSettings,
  prompt: string,
  startedAt: string,
  completedAt: string,
  durationMs: number,
  repairCount: 0 | 1,
  status: "completed" | "failed",
  response: string | undefined,
  validationErrors: string[]
): LlmJsonCompletion<unknown>["metadata"] {
  return {
    provider: "codex-oauth",
    model: settings.model,
    reasoningEffort: settings.reasoningEffort,
    schemaName: request.schemaName,
    promptVersion: request.promptVersion ?? "unspecified",
    schemaVersion: request.schemaVersion ?? request.schemaName,
    promptHash: sha256(prompt),
    ...(response ? { responseHash: sha256(response) } : {}),
    startedAt,
    completedAt,
    durationMs,
    repairCount,
    status,
    ...(validationErrors.length ? { validationErrors } : {})
  };
}
