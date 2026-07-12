import { z } from "zod";
import type {
  CodexCliAdapter as CodexCliAdapterContract,
  CodexCliAdapterRequest,
  CodexCliTaskInput,
  CodexCliTaskResult
} from "../../../core/shared/adapterTypes.js";
import { resolveBundledCodexCli } from "./bundledCodexCli.js";
import { CodexCliError } from "./codexCliErrors.js";
import { assertCodexCliReadiness } from "./codexCliReadiness.js";
import { CodexCliProcessRunner } from "./codexCliProcessRunner.js";
import { prepareCodexWorkspace, validateCodexWorkspace, workspaceManifestHash } from "./codexCliWorkspace.js";

const FinalOutputSchema = z
  .object({
    summary: z.string().trim().min(1).max(4_000),
    outputs: z
      .array(
        z
          .object({
            relativePath: z.string().trim().min(1),
            kind: z.enum(["code", "report", "data"])
          })
          .strict()
      )
      .min(1)
  })
  .strict();

export interface CodexCliAdapterOptions {
  appRoot?: string;
  codexHome?: string;
  runtimeReadRoots?: string[];
  runner?: CodexCliProcessRunner;
}

export class CodexCliAdapter implements CodexCliAdapterContract {
  private readonly runner: CodexCliProcessRunner;

  constructor(private readonly options: CodexCliAdapterOptions = {}) {
    this.runner = options.runner ?? new CodexCliProcessRunner(() => resolveBundledCodexCli(options.appRoot));
  }

  async preflight(): Promise<void> {
    await assertCodexCliReadiness({ appRoot: this.options.appRoot, codexHome: this.options.codexHome });
  }

  async run(request: CodexCliAdapterRequest): Promise<CodexCliTaskResult> {
    const resolution = resolveBundledCodexCli(this.options.appRoot);
    const prepared = await prepareCodexWorkspace(request.actionRoot, request.input, request.artifacts, [
      resolution.packageRoot,
      ...(this.options.runtimeReadRoots ?? [])
    ]);
    const processResult = await this.runner.run({
      cwd: prepared.workspaceRoot,
      prompt: buildTaskPrompt(request.input, prepared.inputFiles),
      model: request.settings.model,
      reasoningEffort: request.settings.reasoningEffort,
      timeoutMs: request.settings.taskTimeoutMs,
      outputSchemaPath: prepared.schemaPath,
      outputLastMessagePath: prepared.resultPath,
      workspaceProfile: { mode: "workspace", inputsDirectoryName: "inputs", outputsDirectoryName: "outputs" },
      ...(this.options.codexHome ? { codexHome: this.options.codexHome } : {}),
      ...(request.signal ? { signal: request.signal } : {}),
      ...(request.onStage ? { onStage: request.onStage } : {})
    });
    let parsed: z.infer<typeof FinalOutputSchema>;
    try {
      parsed = FinalOutputSchema.parse(JSON.parse(processResult.lastMessage));
    } catch (error) {
      throw new CodexCliError("INVALID_OUTPUT", "Codex CLI final output does not satisfy the strict task schema.", {}, { cause: error });
    }
    const validated = await validateCodexWorkspace(prepared, request.input, parsed);
    return {
      summary: parsed.summary,
      outputs: validated.outputs,
      trace: {
        model: request.settings.model,
        reasoningEffort: request.settings.reasoningEffort,
        sandboxProfile: "aetherops-codex-workspace-v1",
        networkPolicy: "disabled",
        durationMs: processResult.durationMs,
        exitCode: processResult.exitCode,
        eventCount: processResult.eventCount,
        workspaceManifestHash: workspaceManifestHash(prepared, request.input),
        outputManifestHash: validated.outputManifestHash,
        terminationReason: processResult.terminationReason ?? "completed"
      }
    };
  }

  dispose(): Promise<void> {
    return this.runner.dispose();
  }
}

function buildTaskPrompt(task: CodexCliTaskInput, inputs: Array<{ id: string; relativePath: string; sha256: string; bytes: number }>): string {
  const inputRows = inputs.length
    ? inputs.map((item) => `- ${item.id}: inputs/${item.relativePath} (sha256 ${item.sha256}, ${item.bytes} bytes)`).join("\n")
    : "- none";
  const outputRows = task.outputs.map((item) => `- ${item.kind}: outputs/${item.relativePath}`).join("\n");
  return [
    "Complete one bounded AetherOps workspace task.",
    "Network access is disabled. Do not attempt web search, remote tools, apps, plugins, or subagents.",
    "Treat workspace/inputs as immutable. Write only the explicitly declared files below under workspace/outputs.",
    "Do not create any other files, symlinks, or filesystem paths.",
    "The final response must satisfy the supplied JSON schema and list every declared output exactly once.",
    "",
    "Task:",
    task.task.trim(),
    "",
    "Validated input artifacts:",
    inputRows,
    "",
    "Required outputs:",
    outputRows
  ].join("\n");
}
