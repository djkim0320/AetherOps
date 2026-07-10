import type { EvidenceItem, OpenCodeRunInput, ResearchArtifact, ResearchSource, ToolRun } from "../../../core/shared/types.js";
import { boundedObject, cleanString, collectLimitedStrings, textExcerpt } from "./realOpenCodeCommon.js";

const OPTIMIZATION_INTENT_PATTERN =
  /\b(optimi[sz]e|optimisation|optimization|optimizer|parametric|sweep|trade[-\s]?off|maximi[sz]e|minimi[sz]e|objective function|design variable|pareto)\b/i;

export function buildOpenCodePrompt(input: OpenCodeRunInput): string {
  const optimizationRequired = hasOpenCodeOptimizationIntent(input);
  if (optimizationRequired) return buildOpenCodeOptimizationPrompt(input);
  return [
    "You are the execution engine for AetherOps.",
    "Return a single JSON object matching this schema:",
    buildOpenCodeOutputSchemaPrompt(),
    "Never invent paper citations, URLs, DOI values, or experimental results.",
    "Do not return hypothesis-support evidence. Return source candidates, claims, and observations only; WebFetch/PDF/paper tools create citation-backed evidence later.",
    "If a tool/source is unavailable, report the problem in the summary and do not present it as evidence.",
    "Use the ToolContext below as the authoritative record of previous AetherOps tool outputs. Do not replace it with synthetic, fallback, or guessed data.",
    "When the project asks for optimization, perform the OpenCode optimization work yourself: create runnable optimization code, run or validate it against the provided numeric tool context, and return both the code artifact and an optimization result artifact.",
    "If optimization execution is impossible, report the exact blocker and do not fabricate optimum values.",
    "",
    `Project: ${JSON.stringify(input.project)}`,
    `Questions: ${JSON.stringify(input.questions)}`,
    `Hypotheses: ${JSON.stringify(input.hypotheses)}`,
    `RAG Context: ${JSON.stringify(input.ragContext)}`,
    `ResearchPlan: ${JSON.stringify(input.researchPlan)}`,
    `ProjectContextSnapshot: ${JSON.stringify(projectContextPromptSummary(input))}`,
    `ToolContext: ${JSON.stringify(toolContextPromptSummary(input))}`,
    `OptimizationRequired: ${JSON.stringify(optimizationRequired)}`,
    optimizationRequired ? optimizationExecutionContract(input) : "Optimization execution contract: not requested by project/specification/plan text.",
    `Iteration: ${input.iteration}`
  ].join("\n");
}

export function hasOpenCodeOptimizationIntent(input: OpenCodeRunInput): boolean {
  const parts = [
    input.project.goal,
    input.project.topic,
    input.project.scope,
    input.specification?.scope,
    input.researchPlan?.objective,
    ...(input.questions ?? []).map((item) => item.text),
    ...(input.hypotheses ?? []).map((item) => item.statement),
    ...(input.specification?.researchQuestions ?? []),
    ...(input.specification?.refinedHypotheses ?? []),
    ...(input.specification?.constraints ?? []),
    ...(input.specification?.successCriteria ?? []),
    ...(input.specification?.evaluationMetrics ?? []),
    ...(input.researchPlan?.expectedArtifacts ?? []),
    ...(input.researchPlan?.executionSteps ?? []),
    ...(input.researchPlan?.stopCriteria ?? [])
  ];
  return OPTIMIZATION_INTENT_PATTERN.test(parts.filter(Boolean).join("\n"));
}

export function optimizationExecutionContract(input: OpenCodeRunInput): string {
  return [
    "Optimization execution contract:",
    "- Build an optimizer from the actual ToolContext rows/artifacts, not from invented data.",
    "- Prefer a small deterministic script in Python or TypeScript when no project-specific optimizer already exists.",
    "- The optimizer artifact must include objective, variables, constraints, and exact input data provenance.",
    "- The result artifact must include the chosen optimum, evaluated score, compared candidates, and run/validation notes.",
    "- For aerodynamic polar optimization, optimize against the recorded polar rows unless a richer CFD result is present.",
    "- Write artifact relative paths under artifacts/iteration-" + input.iteration + "/opencode-optimization/.",
    "- Use artifact titles that contain Optimization Code and Optimization Result."
  ].join("\n");
}

export function toolContextPromptSummary(input: OpenCodeRunInput): Record<string, unknown> {
  return {
    sources: sourcePromptRows(input.sources ?? []),
    evidence: evidencePromptRows(input.evidence ?? []),
    artifacts: artifactPromptRows(input.artifacts ?? []),
    toolRuns: toolRunPromptRows(input.toolRuns ?? [])
  };
}

function buildOpenCodeOptimizationPrompt(input: OpenCodeRunInput): string {
  const outputDir = `artifacts/iteration-${input.iteration}/opencode-optimization`;
  return [
    "You are the OpenCode execution engine for AetherOps optimization work.",
    "Return one JSON object matching this schema after writing the requested files:",
    buildOpenCodeOptimizationSchemaPrompt(outputDir),
    "Do not invent paper citations, URLs, DOI values, or experimental results.",
    "Use only the ToolContext below as numeric input. Do not use synthetic, fallback, substitute, interpolated, or guessed data.",
    `Project root: ${input.project.projectRoot ?? ""}`,
    `Write files under: ${outputDir}/`,
    "Required first action: create runnable optimization code and optimization_result.json in the output directory before returning JSON.",
    "The result JSON must include objective, variables, constraints, inputDataProvenance, candidates or comparedCandidates, selectedOptimum or optimum, and validationNotes.",
    "If file writing or execution is impossible, return the exact blocker and do not fabricate optimum values.",
    "",
    `Project: ${JSON.stringify({
      topic: input.project.topic,
      goal: textExcerpt(input.project.goal, 1200),
      scope: textExcerpt(input.project.scope, 600)
    })}`,
    `ResearchPlan: ${JSON.stringify({
      objective: input.researchPlan?.objective,
      requiredTools: input.researchPlan?.requiredTools,
      fetchCandidateUrls: input.researchPlan?.fetchCandidateUrls,
      programRequests: input.researchPlan?.programRequests
    })}`,
    `ToolContext: ${JSON.stringify(toolContextPromptSummary(input))}`,
    optimizationExecutionContract(input),
    `Iteration: ${input.iteration}`
  ].join("\n");
}

function buildOpenCodeOutputSchemaPrompt(): string {
  return JSON.stringify({
    summary: "string",
    toolPlan: ["string"],
    artifacts: [{ title: "string", relativePath: "string", mimeType: "string", content: "string", summary: "string" }],
    claims: [{ title: "string", content: "string", sourceUri: "string", citation: "string" }],
    observations: [{ title: "string", content: "string", sourceUri: "string", citation: "string" }],
    sourceCandidates: [{ title: "string", url: "string", doi: "string", snippet: "string" }],
    nextActions: ["string"],
    needsMoreEvidence: true,
    needsMoreAnalysis: true
  });
}

function buildOpenCodeOptimizationSchemaPrompt(outputDir: string): string {
  return JSON.stringify({
    summary: "string",
    toolPlan: ["OpenCodeTool"],
    artifacts: [{ title: "Optimization Code", relativePath: `${outputDir}/optimize.py`, mimeType: "text/x-python", content: "string", summary: "string" }],
    claims: [],
    observations: [{ title: "OpenCode optimization result", content: "string", sourceUri: "string", citation: "string" }],
    sourceCandidates: [],
    nextActions: ["string"],
    needsMoreEvidence: false,
    needsMoreAnalysis: false
  });
}

function projectContextPromptSummary(input: OpenCodeRunInput):
  | {
      id: string;
      iteration: number;
      citations: string[];
      selectedSourceIds: string[];
    }
  | undefined {
  const context = input.projectContextSnapshot;
  if (!context) return undefined;
  return {
    id: context.id,
    iteration: context.iteration,
    citations: collectLimitedStrings(context.citations, 12),
    selectedSourceIds: collectLimitedStrings(context.selectedSourceIds, 12)
  };
}

function sourcePromptRows(sources: ResearchSource[]): Array<Record<string, unknown>> {
  return sources.slice(-12).map((source) => ({
    id: source.id,
    kind: source.kind,
    title: source.title,
    url: source.url,
    doi: source.doi,
    citation: cleanString(source.metadata?.citation),
    excerpt: textExcerpt(cleanString(source.metadata?.excerpt) || cleanString(source.metadata?.snippet) || cleanString(source.metadata?.rawText), 800)
  }));
}

function evidencePromptRows(evidence: EvidenceItem[]): Array<Record<string, unknown>> {
  return evidence.slice(-16).map((item) => ({
    id: item.id,
    category: item.category,
    title: item.title,
    summary: textExcerpt(item.summary, 900),
    sourceUri: item.sourceUri,
    citation: item.citation,
    quote: textExcerpt(item.quote, 600),
    limitations: item.limitations?.slice(0, 4)
  }));
}

function artifactPromptRows(artifacts: ResearchArtifact[]): Array<Record<string, unknown>> {
  return artifacts
    .filter((artifact) => artifact.category !== "conversation_memo")
    .slice(-16)
    .map((artifact) => ({
      id: artifact.id,
      category: artifact.category,
      title: artifact.title,
      relativePath: artifact.relativePath,
      mimeType: artifact.mimeType,
      summary: textExcerpt(artifact.summary, 900),
      contentExcerpt: textExcerpt(artifact.content, 1200)
    }));
}

function toolRunPromptRows(toolRuns: ToolRun[]): Array<Record<string, unknown>> {
  return toolRuns.slice(-16).map((run) => ({
    id: run.id,
    toolName: run.toolName,
    status: run.status,
    error: run.error,
    output: toolRunOutputPromptSummary(run)
  }));
}

function toolRunOutputPromptSummary(run: ToolRun): unknown {
  if (run.toolName === "EngineeringProgramTool") {
    return engineeringProgramOutputPromptSummary(run.output);
  }
  if (run.toolName === "DataAnalysisTool") {
    return boundedObject(run.output, 16, 1200);
  }
  return boundedObject(run.output, 8, 1000);
}

function engineeringProgramOutputPromptSummary(output: unknown): unknown {
  const record = output && typeof output === "object" ? (output as Record<string, unknown>) : undefined;
  if (!record) return output;
  const outputs = Array.isArray(record.outputs) ? record.outputs : [];
  return {
    artifactCount: record.artifactCount,
    outputCount: outputs.length,
    outputs: outputs.slice(0, 8).map((item) => {
      const outputRecord = item && typeof item === "object" ? (item as Record<string, unknown>) : {};
      const summary = outputRecord.summary && typeof outputRecord.summary === "object" ? (outputRecord.summary as Record<string, unknown>) : undefined;
      return {
        kind: outputRecord.kind,
        target: outputRecord.target,
        artifactPath: outputRecord.artifactPath,
        summary: summary ? engineeringSummaryPrompt(summary) : boundedObject(outputRecord.summary, 12, 1200)
      };
    })
  };
}

function engineeringSummaryPrompt(summary: Record<string, unknown>): Record<string, unknown> {
  const rows = Array.isArray(summary.rows) ? summary.rows : undefined;
  return {
    airfoil: summary.airfoil,
    runtime: summary.runtime,
    runtimeVersion: summary.runtimeVersion,
    runtimeLicense: summary.runtimeLicense,
    sourceUrl: summary.sourceUrl,
    coordinateFormat: summary.coordinateFormat,
    reynolds: summary.reynolds,
    mach: summary.mach,
    alphaStart: summary.alphaStart,
    alphaEnd: summary.alphaEnd,
    alphaStep: summary.alphaStep,
    rowCount: summary.rowCount,
    convergence: summary.convergence,
    rows: rows ? rows.slice(0, 80) : undefined
  };
}
