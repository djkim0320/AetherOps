import { z } from "zod";
import { createId, nowIso } from "../shared/ids.js";
import type { AppSettings, CodexCliAdapter, ResearchToolInput, ResearchArtifact, ToolRun } from "../shared/types.js";
import type { ResearchTool, ResearchToolExecutionContext, ResearchToolResult } from "./researchToolTypes.js";

const InputSchema = z
  .object({
    task: z.string().trim().min(1).max(20_000),
    inputArtifactIds: z.array(z.string().trim().min(1)).max(32),
    outputs: z
      .array(
        z
          .object({
            relativePath: z.string().trim().min(1).max(240),
            kind: z.enum(["code", "report", "data"])
          })
          .strict()
      )
      .min(1)
      .max(16)
  })
  .strict();

export class CodexCliTool implements ResearchTool {
  readonly name = "CodexCliTool";

  constructor(private readonly adapter: CodexCliAdapter) {}

  async run(input: ResearchToolInput, settings: AppSettings, context?: ResearchToolExecutionContext): Promise<ResearchToolResult> {
    if (!context?.stagingRef) throw new Error("Codex CLI execution requires an isolated action workspace.");
    const task = InputSchema.parse(context.inputs);
    const artifacts = task.inputArtifactIds.map((id) => validatedArtifact(input.artifacts ?? [], id));
    const startedAt = nowIso();
    const result = await this.adapter.run({
      actionRoot: context.stagingRef,
      input: task,
      artifacts,
      settings: settings.codex,
      signal: context.signal,
      ...(context.onCodexCliStage ? { onStage: context.onCodexCliStage } : {})
    });
    const completedAt = nowIso();
    const outputArtifacts: ResearchArtifact[] = result.outputs.map((item) => ({
      id: createId("artifact"),
      projectId: input.project.id,
      category: "generated_artifact",
      title: item.relativePath.split("/").at(-1) ?? item.relativePath,
      relativePath: item.relativePath,
      rawPath: item.absolutePath,
      mimeType: mimeType(item.relativePath, item.kind),
      summary: result.summary,
      metadata: {
        originTool: this.name,
        sha256: item.sha256,
        bytes: item.bytes,
        codexCliTrace: result.trace
      },
      createdAt: completedAt
    }));
    const toolRun: ToolRun = {
      id: createId("tool"),
      projectId: input.project.id,
      iteration: input.iteration,
      toolName: this.name,
      input: task,
      output: {
        summary: result.summary,
        artifactIds: outputArtifacts.map((item) => item.id),
        outputManifestHash: result.trace.outputManifestHash,
        workspaceManifestHash: result.trace.workspaceManifestHash,
        codexCliTrace: result.trace
      },
      status: "completed",
      startedAt,
      completedAt
    };
    return { toolRun, evidence: [], sources: [], artifacts: outputArtifacts };
  }
}

function validatedArtifact(artifacts: ResearchArtifact[], id: string): { id: string; sourcePath: string; sha256: string } {
  const artifact = artifacts.find((item) => item.id === id);
  if (!artifact) throw new Error(`Codex CLI input artifact is not present in the current execution: ${id}`);
  if (!artifact.rawPath) throw new Error(`Codex CLI input artifact has no promoted filesystem path: ${id}`);
  const sha256 = artifact.metadata?.sha256;
  if (typeof sha256 !== "string" || !/^[a-f0-9]{64}$/i.test(sha256)) throw new Error(`Codex CLI input artifact has no validated SHA-256: ${id}`);
  return { id, sourcePath: artifact.rawPath, sha256: sha256.toLowerCase() };
}

function mimeType(relativePath: string, kind: "code" | "report" | "data"): string {
  if (relativePath.endsWith(".json")) return "application/json";
  if (relativePath.endsWith(".md")) return "text/markdown";
  if (relativePath.endsWith(".csv")) return "text/csv";
  return kind === "code" ? "text/plain" : "application/octet-stream";
}
