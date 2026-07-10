import { createId, nowIso } from "../../../core/shared/ids.js";
import type { AppSettings, OpenCodeAdapter, OpenCodeRunInput, OpenCodeRunOutput } from "../../../core/shared/types.js";
import { resolveOpenCodeCommand, type OpenCodeCommandOptions } from "./opencodeResolver.js";
import { buildOpenCodePrompt } from "./realOpenCodePromptBuilder.js";
import { createOpenCodeError, describeOpenCodeResolution, runOpenCodeCommand, type OpenCodeProcessResult } from "./realOpenCodeProcessRunner.js";
import { normalizeOpenCodeRunOutput } from "./realOpenCodeNormalizer.js";
import { parseOpenCodeJson } from "./realOpenCodeOutputParser.js";
import { recoverOpenCodeFilesystemArtifacts } from "./realOpenCodeFilesystemArtifacts.js";
import { sanitizeOpenCodeCommandOutput } from "./realOpenCodeOutputSanitizer.js";

type SettingsGetter = () => AppSettings | Promise<AppSettings>;

export class RealOpenCodeAdapter implements OpenCodeAdapter {
  constructor(
    private readonly getSettings: SettingsGetter,
    private readonly commandOptions: OpenCodeCommandOptions = {}
  ) {}

  async preflight(): Promise<void> {
    const settings = await this.getSettings();
    if (!settings.openCode.enabled) {
      throw new Error("OpenCode execution engine is disabled in settings.");
    }
    const resolution = resolveOpenCodeCommand(settings.openCode.command, this.commandOptions);
    const raw = await runOpenCodeCommand(resolution.command, ["--version"], Math.min(settings.openCode.timeoutMs, 10_000));
    if (raw.exitCode !== 0) {
      throw createOpenCodeError(
        `OpenCode CLI preflight failed with code ${raw.exitCode} using ${describeOpenCodeResolution(resolution)}: ${raw.stderr || raw.stdout || "no output"}`,
        {
          exitCode: raw.exitCode,
          stdoutTail: sanitizeOpenCodeCommandOutput(raw.stdout.slice(-2000)),
          stderrTail: sanitizeOpenCodeCommandOutput(raw.stderr.slice(-2000))
        }
      );
    }
  }

  async createRunAttempt(input: OpenCodeRunInput): Promise<OpenCodeRunOutput["run"]> {
    const settings = await this.getSettings();
    const resolution = resolveOpenCodeCommand(settings.openCode.command, this.commandOptions);
    const model = formatOpenCodeModel(settings);
    const startedAt = nowIso();
    return {
      id: input.openCodeRunId ?? createId("opencode"),
      projectId: input.project.id,
      iteration: input.iteration,
      prompt: buildOpenCodePrompt(input),
      toolPlan: ["OpenCodeTool"],
      status: "running",
      logs: ["OpenCode CLI attempt started."],
      artifactIds: [],
      evidenceIds: [],
      metadata: {
        command: resolution.command,
        commandSource: resolution.source,
        model,
        provider: settings.openCode.provider,
        timeoutMs: settings.openCode.timeoutMs,
        executionBundleId: input.executionBundleId
      },
      startedAt
    };
  }

  async run(input: OpenCodeRunInput): Promise<OpenCodeRunOutput> {
    const settings = await this.getSettings();
    if (!settings.openCode.enabled) {
      throw new Error("OpenCode execution engine is disabled in settings.");
    }

    const startedAt = nowIso();
    const resolution = resolveOpenCodeCommand(settings.openCode.command, this.commandOptions);
    const prompt = buildOpenCodePrompt(input);
    let raw: OpenCodeProcessResult;
    try {
      raw = await runOpenCodeCommand(resolution.command, this.buildArgs(settings, prompt), settings.openCode.timeoutMs, () =>
        recoverOpenCodeFilesystemArtifacts(
          input,
          startedAt,
          nowIso(),
          prompt,
          createOpenCodeError("OpenCode filesystem optimization artifacts became available before CLI JSON output.", {
            artifactCompletion: true
          })
        )
      );
    } catch (error) {
      const recovered = recoverOpenCodeFilesystemArtifacts(input, startedAt, nowIso(), prompt, error);
      if (recovered) return recovered;
      throw error;
    }
    if (raw.recoveredOutput) return raw.recoveredOutput;

    const completedAt = nowIso();
    if (raw.exitCode !== 0) {
      throw createOpenCodeError(
        `OpenCode CLI exited with code ${raw.exitCode} using ${describeOpenCodeResolution(resolution)}: ${raw.stderr || raw.stdout || "no output"}`,
        {
          exitCode: raw.exitCode,
          stdoutTail: sanitizeOpenCodeCommandOutput(raw.stdout.slice(-2000)),
          stderrTail: sanitizeOpenCodeCommandOutput(raw.stderr.slice(-2000))
        }
      );
    }

    const parsed = parseOpenCodeJson(raw.stdout);
    if (!parsed) {
      const parseError = createOpenCodeError(
        `OpenCode output JSON parsing failed using ${describeOpenCodeResolution(resolution)}: ${(raw.stdout || raw.stderr || "no output").slice(0, 2000)}`,
        {
          parseFailure: true,
          stdoutTail: sanitizeOpenCodeCommandOutput(raw.stdout.slice(-2000)),
          stderrTail: sanitizeOpenCodeCommandOutput(raw.stderr.slice(-2000))
        }
      );
      const recovered = recoverOpenCodeFilesystemArtifacts(input, startedAt, completedAt, prompt, parseError);
      if (recovered) return recovered;
      throw parseError;
    }

    return normalizeOpenCodeRunOutput(input, parsed, startedAt, completedAt, raw.stderr, prompt);
  }

  private buildArgs(settings: AppSettings, prompt: string): string[] {
    const args = ["run", "--format", "json"];
    const model = formatOpenCodeModel(settings);
    if (model) {
      args.push("--model", model);
    }
    args.push(prompt);
    return args;
  }
}

function formatOpenCodeModel(settings: AppSettings): string | undefined {
  const model = settings.openCode.model || settings.openCodeLlm.model;
  const provider = settings.openCode.provider;
  if (!model) {
    return undefined;
  }
  return model.includes("/") || !provider ? model : `${provider}/${model}`;
}
