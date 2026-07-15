import { AetherOpsOrchestrator } from "../../core/orchestration/orchestrator.js";
import { createId, nowIso } from "../../core/shared/ids.js";
import { ResearchLoopStep } from "../../core/shared/types.js";
import type {
  AppSettings,
  EngineeringProgramDirectRunInput,
  EngineeringProgramDirectRunResult,
  EngineeringProgramRequest,
  ResearchToolInput,
  ResearchArtifact
} from "../../core/shared/types.js";
import { EngineeringProgramTool } from "../../core/tools/engineeringProgramTool.js";
import type { ResearchToolExecutionContext } from "../../core/tools/researchToolTypes.js";
import { runEngineeringProgram } from "../runtime/engineering/engineeringProgramRegistry.js";

export async function runEngineeringProgramDirect(
  payload: EngineeringProgramDirectRunInput,
  settings: AppSettings,
  orchestrator: AetherOpsOrchestrator,
  context?: Pick<ResearchToolExecutionContext, "signal">
): Promise<EngineeringProgramDirectRunResult> {
  context?.signal.throwIfAborted();
  const startedAt = nowIso();
  const programRequests = normalizeDirectProgramRequests(payload?.programRequests, settings);
  const title = payload?.title?.trim() || "Direct engineering program run";
  const projectId = requiredProjectId(payload?.projectId);
  let persistentSnapshot = await orchestrator.getSnapshot(projectId);
  if (!persistentSnapshot.database) {
    persistentSnapshot = await orchestrator.createResearchDb(projectId);
  }
  const executionSettings: AppSettings = {
    ...settings,
    allowExternalSearch: Boolean(settings.allowExternalSearch && persistentSnapshot.project.autonomyPolicy.allowExternalSearch),
    allowCodeExecution: Boolean(settings.allowCodeExecution && persistentSnapshot.project.autonomyPolicy.allowCodeExecution)
  };
  for (const request of programRequests) validateDirectProgramRequest(request, executionSettings);
  const directQuestions = persistentSnapshot.questions.slice(0, 1);
  const directHypotheses = persistentSnapshot.hypotheses.slice(0, 1);
  const input: ResearchToolInput = {
    project: {
      ...persistentSnapshot.project,
      currentStep: ResearchLoopStep.ExecuteTools,
      status: "running"
    },
    questions: directQuestions,
    hypotheses: directHypotheses,
    evidence: [],
    artifacts: [],
    sources: [],
    researchPlan: {
      id: createId("plan"),
      projectId,
      iteration: 1,
      objective: title,
      targetQuestions: directQuestions.map((question) => question.id),
      targetHypotheses: directHypotheses.map((hypothesis) => hypothesis.id),
      requiredTools: ["EngineeringProgramTool"],
      expectedSources: ["real engineering program inputs"],
      expectedArtifacts: ["engineering program output artifact"],
      executionSteps: ["Run EngineeringProgramTool with the supplied structured request."],
      stopCriteria: ["Engineering program output is returned or an explicit failure is recorded."],
      programRequests,
      createdAt: startedAt
    },
    iteration: 1
  };

  try {
    const result = await new EngineeringProgramTool(runEngineeringProgram).run(input, executionSettings, context);
    const completedAt = nowIso();
    const programRuns = programRunsFromOutput(result.toolRun.output);
    const reportMarkdown = engineeringDirectReport(title, result.toolRun.status, programRuns, result.artifacts, result.evidence, result.toolRun.error);
    let savedReportArtifact: ResearchArtifact | undefined;
    let persistenceError: string | undefined;
    if (result.toolRun.status === "completed") {
      try {
        savedReportArtifact = await saveEngineeringDirectReport(
          orchestrator,
          projectId,
          title,
          reportMarkdown,
          result.toolRun.status,
          result.toolRun.id,
          startedAt,
          completedAt
        );
      } catch (error) {
        persistenceError = error instanceof Error ? error.message : String(error);
      }
    }
    return {
      status: result.toolRun.status === "completed" && !persistenceError ? "completed" : "failed",
      startedAt,
      completedAt,
      toolRun: result.toolRun,
      programRuns,
      artifacts: result.artifacts,
      evidence: result.evidence,
      reportMarkdown,
      savedReportArtifact,
      error: result.toolRun.error ?? persistenceError
    };
  } catch (error) {
    context?.signal.throwIfAborted();
    const completedAt = nowIso();
    const message = error instanceof Error ? error.message : String(error);
    const toolRun = {
      id: createId("tool"),
      projectId,
      iteration: 1,
      toolName: "EngineeringProgramTool",
      input: { programRequests },
      output: { programRequests },
      status: "failed" as const,
      error: message,
      startedAt,
      completedAt
    };
    return {
      status: "failed",
      startedAt,
      completedAt,
      toolRun,
      programRuns: [],
      artifacts: [],
      evidence: [],
      reportMarkdown: engineeringDirectReport(title, "failed", [], [], [], message),
      error: message
    };
  }
}

async function saveEngineeringDirectReport(
  orchestrator: AetherOpsOrchestrator,
  projectId: string,
  title: string,
  reportMarkdown: string,
  toolStatus: string,
  toolRunId: string,
  startedAt: string,
  completedAt: string
): Promise<ResearchArtifact> {
  const artifactId = createId("artifact");
  const next = await orchestrator.storeArtifact(projectId, {
    id: artifactId,
    category: "experiment_log",
    title: `${title} report`,
    relativePath: "reports/engineering-program-workbench.md",
    mimeType: "text/markdown",
    summary: "Direct engineering program report generated from EngineeringProgramTool output.",
    content: reportMarkdown,
    metadata: {
      traceabilityKind: "tool_observation",
      generatedBy: "EngineeringProgramWorkbench",
      toolName: "EngineeringProgramTool",
      toolRunId,
      toolStatus,
      startedAt,
      completedAt
    },
    createdAt: completedAt
  });
  const artifact = next.artifacts.find((item) => item.id === artifactId);
  if (!artifact) throw new Error("Direct engineering report was not persisted as a project artifact.");
  return artifact;
}

const engineeringRequestKinds = new Set<EngineeringProgramRequest["kind"]>([
  "toolchain-check",
  "mesh-inspect",
  "xfoil-polar",
  "xfoil-wasm-polar",
  "su2-case-run",
  "openvsp-analysis-run",
  "xflr5-analysis-run"
]);
const engineeringTargets = new Set<NonNullable<EngineeringProgramRequest["target"]>>(["all", "xfoil", "xfoil-wasm", "modeling", "su2", "openvsp", "xflr5"]);

function normalizeDirectProgramRequests(value: unknown, settings: AppSettings): EngineeringProgramRequest[] {
  if (!Array.isArray(value) || value.length === 0) throw new Error("engineering.runProgram requires at least one program request.");
  return value.slice(0, 4).map((item) => {
    if (!item || typeof item !== "object") throw new Error("Engineering program request must be an object.");
    const request = item as Partial<EngineeringProgramRequest>;
    if (typeof request.kind !== "string" || !engineeringRequestKinds.has(request.kind as EngineeringProgramRequest["kind"])) {
      throw new Error("Engineering program request requires kind.");
    }
    const normalized: EngineeringProgramRequest = {
      kind: request.kind as EngineeringProgramRequest["kind"],
      target: normalizeDirectTarget(request.target),
      cfdRunSpec: normalizeDirectCfdRunSpec(request.cfdRunSpec),
      artifactPath: normalizeDirectText(request.artifactPath, "artifactPath"),
      sourceUrl: normalizeDirectText(request.sourceUrl, "sourceUrl"),
      outputFileName: normalizeDirectText(request.outputFileName, "outputFileName"),
      naca: normalizeDirectText(request.naca, "naca"),
      reynolds: normalizeDirectNumber(request.reynolds, "reynolds"),
      mach: normalizeDirectNumber(request.mach, "mach"),
      alphaStart: normalizeDirectNumber(request.alphaStart, "alphaStart"),
      alphaEnd: normalizeDirectNumber(request.alphaEnd, "alphaEnd"),
      alphaStep: normalizeDirectNumber(request.alphaStep, "alphaStep"),
      reason: normalizeDirectText(request.reason, "reason")
    };
    validateDirectProgramRequest(normalized, settings);
    return normalized;
  });
}

function normalizeDirectTarget(value: unknown): EngineeringProgramRequest["target"] | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string" || !engineeringTargets.has(value as NonNullable<EngineeringProgramRequest["target"]>)) {
    throw new Error("Engineering program request target is not supported.");
  }
  return value as EngineeringProgramRequest["target"];
}

function normalizeDirectText(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw new Error(`Engineering program request ${field} must be a string.`);
  return value.trim() || undefined;
}

function normalizeDirectNumber(value: unknown, field: string): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`Engineering program request ${field} must be a finite number.`);
  return value;
}

function normalizeDirectCfdRunSpec(value: unknown): EngineeringProgramRequest["cfdRunSpec"] {
  if (value === undefined || value === null) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Engineering program request cfdRunSpec must be an object.");
  const spec = value as NonNullable<EngineeringProgramRequest["cfdRunSpec"]>;
  if (!["xfoil", "xfoil-wasm", "su2", "openvsp", "xflr5"].includes(spec.target))
    throw new Error("Engineering program request cfdRunSpec target is not supported.");
  if (!spec.geometry || typeof spec.geometry !== "object") throw new Error("Engineering program request cfdRunSpec.geometry is required.");
  if (!spec.solver || typeof spec.solver !== "object") throw new Error("Engineering program request cfdRunSpec.solver is required.");
  return spec;
}

function validateDirectProgramRequest(request: EngineeringProgramRequest, settings: AppSettings): void {
  if (request.kind === "xfoil-wasm-polar") {
    if (request.target && request.target !== "xfoil-wasm") throw new Error("xfoil-wasm-polar requests must target xfoil-wasm.");
    if (!request.sourceUrl && !request.artifactPath && !request.naca) throw new Error("xfoil-wasm-polar requires sourceUrl, artifactPath, or naca.");
    if (request.sourceUrl && !settings.allowExternalSearch)
      throw new Error("xfoil-wasm-polar sourceUrl execution requires external data access to be enabled.");
    if (request.naca && !/^\d{4,5}$/.test(request.naca)) throw new Error("xfoil-wasm-polar naca must be a 4 or 5 digit series code.");
  }
  if (request.kind === "xfoil-polar" && request.naca && !/^\d{4,5}$/.test(request.naca))
    throw new Error("xfoil-polar naca must be a 4 or 5 digit series code.");
  const expectedTarget =
    request.kind === "su2-case-run" ? "su2" : request.kind === "openvsp-analysis-run" ? "openvsp" : request.kind === "xflr5-analysis-run" ? "xflr5" : undefined;
  if (expectedTarget && !request.cfdRunSpec) throw new Error(`${request.kind} requires cfdRunSpec.`);
  if (expectedTarget && request.cfdRunSpec?.target !== expectedTarget) throw new Error(`${request.kind} requires cfdRunSpec.target ${expectedTarget}.`);
  if (request.alphaStart !== undefined && request.alphaEnd !== undefined && request.alphaEnd < request.alphaStart)
    throw new Error("Engineering program request requires alphaEnd >= alphaStart.");
}

function requiredProjectId(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) throw new Error("Direct engineering execution requires projectId.");
  return value.trim();
}

function programRunsFromOutput(output: unknown): unknown[] {
  const record = asRecord(output);
  if (Array.isArray(record?.programRuns)) return record.programRuns;
  return Array.isArray(record?.outputs) ? record.outputs : [];
}

function engineeringDirectReport(
  title: string,
  status: string,
  programRuns: unknown[],
  artifacts: ResearchArtifact[],
  evidence: Array<{ title: string; summary: string; limitations?: string[] }>,
  error?: string
): string {
  const lines = [`# ${title}`, "", `Status: ${status}`, ""];
  if (error) lines.push("## Error", error, "");
  for (const run of programRuns) {
    const record = asRecord(run);
    const summary = asRecord(record?.summary);
    lines.push(`## ${String(record?.target ?? record?.kind ?? "Engineering program")}`);
    if (summary?.airfoil) lines.push(`Airfoil: ${String(summary.airfoil)}`);
    if (summary?.sourceUrl) lines.push(`Source URL: ${String(summary.sourceUrl)}`);
    if (summary?.runtime) lines.push(`Runtime: ${String(summary.runtime)} ${summary.runtimeVersion ? String(summary.runtimeVersion) : ""}`.trim());
    if (summary?.runtimeLicense) lines.push(`Runtime license: ${String(summary.runtimeLicense)}`);
    if (summary?.reynolds !== undefined) lines.push(`Reynolds: ${formatReportNumber(summary.reynolds)}`);
    if (summary?.mach !== undefined) lines.push(`Mach: ${formatReportNumber(summary.mach)}`);
    const rows = Array.isArray(summary?.rows) ? summary.rows.map(asRecord).filter(Boolean) : [];
    if (rows.length) {
      lines.push("", "| alpha | CL | CD | Cm | Top Xtr | Bot Xtr |", "| ---: | ---: | ---: | ---: | ---: | ---: |");
      for (const row of rows)
        lines.push(
          `| ${formatReportNumber(row?.alpha)} | ${formatReportNumber(row?.cl)} | ${formatReportNumber(row?.cd)} | ${formatReportNumber(row?.cm)} | ${formatReportNumber(row?.topXtr)} | ${formatReportNumber(row?.botXtr)} |`
        );
    }
    lines.push("");
  }
  if (evidence.length) {
    lines.push("## Evidence");
    for (const item of evidence) {
      lines.push(`- ${item.title}: ${item.summary}`);
      for (const limitation of item.limitations ?? []) lines.push(`  - Limitation: ${limitation}`);
    }
    lines.push("");
  }
  lines.push(`Artifacts: ${artifacts.length}`, `Evidence items: ${evidence.length}`, "");
  return `${lines.join("\n").trim()}\n`;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
}

function formatReportNumber(value: unknown): string {
  const numberValue = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numberValue)) return "";
  if (Math.abs(numberValue) >= 1000) return numberValue.toLocaleString("en-US", { maximumFractionDigits: 0 });
  return Number(numberValue.toFixed(5)).toString();
}
