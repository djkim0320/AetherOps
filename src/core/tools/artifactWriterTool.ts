import { createId, nowIso } from "../shared/ids.js";
import type { ResearchToolInput, ResearchArtifact, ToolRun } from "../shared/types.js";
import { getToolDescriptor } from "./toolDescriptors.js";
import type { ResearchTool, ResearchToolExecutionContext, ResearchToolResult } from "./researchToolTypes.js";

type ArtifactKind = "research_report" | "evidence_index" | "hypothesis_assessment" | "plan_revision_hints" | "source_inventory" | "engineering_result";
interface ArtifactRequest {
  relativePath: string;
  kind: ArtifactKind;
  format: "markdown" | "json";
}

export class ArtifactWriterTool implements ResearchTool {
  name = "ArtifactWriterTool";

  async run(input: ResearchToolInput, _settings?: unknown, context?: ResearchToolExecutionContext): Promise<ResearchToolResult> {
    const startedAt = nowIso();
    const toolInput = validatedInputs(context);
    const analysis = latestAnalysis(input);
    const completedAt = nowIso();
    const artifacts = toolInput.artifacts.map((request) => artifactFor(input, request, analysis, completedAt));
    return {
      toolRun: completedToolRun(input, startedAt, completedAt, toolInput, artifacts),
      evidence: [],
      artifacts,
      sources: []
    };
  }
}

function validatedInputs(context: ResearchToolExecutionContext | undefined): { artifacts: ArtifactRequest[] } {
  if (!context) throw new Error("ArtifactWriterTool requires validated execution context inputs.");
  const descriptor = getToolDescriptor("ArtifactWriterTool");
  if (!descriptor) throw new Error("ArtifactWriterTool descriptor is not registered.");
  return descriptor.inputSchema.parse(context.inputs) as { artifacts: ArtifactRequest[] };
}

function latestAnalysis(input: ResearchToolInput): Record<string, unknown> {
  const run = [...(input.toolRuns ?? [])].reverse().find((item) => item.toolName === "DataAnalysisTool" && item.status === "completed");
  if (!run || !run.output || typeof run.output !== "object" || Array.isArray(run.output)) {
    throw new Error("ArtifactWriterTool requires a completed DataAnalysisTool output.");
  }
  return run.output as Record<string, unknown>;
}

function artifactFor(input: ResearchToolInput, request: ArtifactRequest, analysis: Record<string, unknown>, createdAt: string): ResearchArtifact {
  const payload = payloadFor(input, request.kind, analysis);
  const content = request.format === "json" ? `${JSON.stringify(payload, null, 2)}\n` : markdownFor(request.kind, payload);
  return {
    id: createId("artifact"),
    projectId: input.project.id,
    category: "generated_artifact",
    title: titleFor(request.kind),
    relativePath: request.relativePath,
    mimeType: request.format === "json" ? "application/json" : "text/markdown",
    summary: `Deterministic ${request.kind.replaceAll("_", " ")} generated from the completed analysis output.`,
    content,
    metadata: { artifactKind: request.kind, generatedBy: "ArtifactWriterTool", internalOnly: true },
    createdAt
  };
}

function payloadFor(input: ResearchToolInput, kind: ArtifactKind, analysis: Record<string, unknown>): Record<string, unknown> {
  const common = { projectId: input.project.id, iteration: input.iteration, objective: input.project.goal };
  if (kind === "evidence_index") return { ...common, evidence: input.evidence ?? [] };
  if (kind === "hypothesis_assessment") return { ...common, hypotheses: analysis.hypothesisAssessments ?? [] };
  if (kind === "plan_revision_hints") return { ...common, evidenceGaps: analysis.evidenceGaps ?? [], hints: analysis.planRevisionHints ?? [] };
  if (kind === "source_inventory") return { ...common, sources: input.sources ?? [] };
  if (kind === "engineering_result") {
    return {
      ...common,
      engineeringChecks: analysis.engineeringChecks ?? [],
      runs: (input.toolRuns ?? []).filter((run) => run.toolName === "EngineeringProgramTool")
    };
  }
  return {
    ...common,
    questions: input.questions.map((item) => ({ id: item.id, text: item.text })),
    hypotheses: input.hypotheses.map((item) => ({ id: item.id, statement: item.statement })),
    analysis,
    traceability: "Internal artifact; it cannot independently support a hypothesis."
  };
}

function markdownFor(kind: ArtifactKind, payload: Record<string, unknown>): string {
  return [`# ${titleFor(kind)}`, "", "```json", JSON.stringify(payload, null, 2), "```", ""].join("\n");
}

function titleFor(kind: ArtifactKind): string {
  return kind
    .split("_")
    .map((part) => `${part[0]?.toUpperCase() ?? ""}${part.slice(1)}`)
    .join(" ");
}

function completedToolRun(input: ResearchToolInput, startedAt: string, completedAt: string, toolInput: unknown, artifacts: ResearchArtifact[]): ToolRun {
  return {
    id: createId("tool"),
    projectId: input.project.id,
    iteration: input.iteration,
    toolName: "ArtifactWriterTool",
    input: toolInput,
    output: { artifacts: artifacts.map((item) => ({ id: item.id, relativePath: item.relativePath })) },
    status: "completed",
    startedAt,
    completedAt
  };
}
