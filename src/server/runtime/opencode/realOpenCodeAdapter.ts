import { spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join, relative } from "node:path";
import { createId, nowIso } from "../../../core/shared/ids.js";
import type {
  AppSettings,
  EvidenceItem,
  OpenCodeAdapter,
  OpenCodeClaim,
  OpenCodeObservation,
  OpenCodeRunInput,
  OpenCodeRunOutput,
  ResearchArtifact,
  ResearchSource,
  ToolRun
} from "../../../core/shared/types.js";
import { isWindowsShellCommand, resolveOpenCodeCommand, type OpenCodeCommandOptions } from "./opencodeResolver.js";
import { decodeStrictUtf8Chunks } from "../support/strictUtf8.js";

type SettingsGetter = () => AppSettings | Promise<AppSettings>;

const OPTIMIZATION_INTENT_PATTERN =
  /\b(optimi[sz]e|optimisation|optimization|optimizer|parametric|sweep|trade[-\s]?off|maximi[sz]e|minimi[sz]e|objective function|design variable|pareto)\b|최적화|최적|최대화|최소화|목적\s*함수|설계\s*변수/i;

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
    const raw = await runCommand(resolution.command, ["--version"], Math.min(settings.openCode.timeoutMs, 10_000));
    if (raw.exitCode !== 0) {
      throw new Error(
        `OpenCode CLI preflight failed with code ${raw.exitCode} using ${describeResolution(resolution)}: ${
          raw.stderr || raw.stdout || "no output"
        }`
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
      prompt: this.buildPrompt(input),
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
    const startedAt = nowIso();
    if (!settings.openCode.enabled) {
      throw new Error("OpenCode execution engine is disabled in settings.");
    }

    const resolution = resolveOpenCodeCommand(settings.openCode.command, this.commandOptions);
    const prompt = this.buildPrompt(input);
    let raw: CommandResult;
    try {
      raw = await runCommand(
        resolution.command,
        this.buildArgs(input, settings, prompt),
        settings.openCode.timeoutMs,
        () => recoverOpenCodeFilesystemArtifacts(
          input,
          startedAt,
          nowIso(),
          prompt,
          commandError("OpenCode filesystem optimization artifacts became available before CLI JSON output.", {
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
      throw commandError(`OpenCode CLI exited with code ${raw.exitCode} using ${describeResolution(resolution)}: ${raw.stderr || raw.stdout || "no output"}`, {
        exitCode: raw.exitCode,
        stdoutTail: raw.stdout.slice(-2000),
        stderrTail: sanitizeCommandOutput(raw.stderr.slice(-2000))
      });
    }
    const parsed = parseOpenCodeJson(raw.stdout);
    if (!parsed) {
      const parseError = commandError(`OpenCode output JSON parsing failed using ${describeResolution(resolution)}: ${(raw.stdout || raw.stderr || "no output").slice(0, 2000)}`, {
        parseFailure: true,
        stdoutTail: raw.stdout.slice(-2000),
        stderrTail: sanitizeCommandOutput(raw.stderr.slice(-2000))
      });
      const recovered = recoverOpenCodeFilesystemArtifacts(input, startedAt, completedAt, prompt, parseError);
      if (recovered) return recovered;
      throw parseError;
    }

    return this.fromParsed(input, parsed, startedAt, completedAt, raw.stderr);
  }

  private buildArgs(input: OpenCodeRunInput, settings: AppSettings, prompt = this.buildPrompt(input)): string[] {
    const args = ["run", "--format", "json"];
    const model = formatOpenCodeModel(settings);
    if (model) {
      args.push("--model", model);
    }
    args.push(prompt);
    return args;
  }

  private buildPrompt(input: OpenCodeRunInput): string {
    const optimizationRequired = hasOptimizationIntent(input);
    if (optimizationRequired) return this.buildOptimizationPrompt(input);
    return [
      "You are the execution engine for AetherOps.",
      "Return a single JSON object matching this schema:",
      JSON.stringify({
        summary: "string",
        toolPlan: ["string"],
        artifacts: [{ title: "string", relativePath: "string", mimeType: "string", content: "string", summary: "string" }],
        claims: [{ title: "string", content: "string", sourceUri: "string", citation: "string" }],
        observations: [{ title: "string", content: "string", sourceUri: "string", citation: "string" }],
        sourceCandidates: [{ title: "string", url: "string", doi: "string", snippet: "string" }],
        nextActions: ["string"],
        needsMoreEvidence: true,
        needsMoreAnalysis: true
      }),
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

  private buildOptimizationPrompt(input: OpenCodeRunInput): string {
    const outputDir = `artifacts/iteration-${input.iteration}/opencode-optimization`;
    return [
      "You are the OpenCode execution engine for AetherOps optimization work.",
      "Return one JSON object matching this schema after writing the requested files:",
      JSON.stringify({
        summary: "string",
        toolPlan: ["OpenCodeTool"],
        artifacts: [{ title: "Optimization Code", relativePath: `${outputDir}/optimize.py`, mimeType: "text/x-python", content: "string", summary: "string" }],
        claims: [],
        observations: [{ title: "OpenCode optimization result", content: "string", sourceUri: "string", citation: "string" }],
        sourceCandidates: [],
        nextActions: ["string"],
        needsMoreEvidence: false,
        needsMoreAnalysis: false
      }),
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

  private fromParsed(
    input: OpenCodeRunInput,
    parsed: OpenCodeSchema,
    startedAt: string,
    completedAt: string,
    stderr: string
  ): OpenCodeRunOutput {
    const downgraded = downgradeLegacyEvidence(parsed);
    const artifacts = normalizeArtifacts(input, parsed, completedAt);
    const claims = normalizeClaimLike(parsed.claims);
    claims.push(...downgraded.claims);
    const observations = normalizeClaimLike(parsed.observations);
    observations.push(...downgraded.observations);
    const sourceCandidates = mergeSourceCandidateRecords(parsed.sourceCandidates, downgraded.sourceCandidates);
    const sources = normalizeSourceCandidates(input, sourceCandidates, completedAt);
    const toolRuns = normalizeStructuredOutputToolRuns(input, claims, observations, sources, startedAt, completedAt);
    return {
      run: {
        id: input.openCodeRunId ?? createId("opencode"),
        projectId: input.project.id,
        iteration: input.iteration,
        prompt: this.buildPrompt(input),
        toolPlan: parsed.toolPlan?.length ? parsed.toolPlan : ["opencode-cli"],
        status: "completed",
        logs: [
          parsed.summary || "OpenCode CLI execution completed.",
          "OpenCode CLI was resolved from AetherOps bundled dependencies when available.",
          downgraded.downgradedCount ? `Downgraded ${downgraded.downgradedCount} legacy evidence items to non-support claims/source candidates.` : "No legacy evidence items were returned.",
          stderr ? `stderr: ${stderr.slice(0, 2000)}` : "stderr: empty"
        ],
        artifactIds: collectIds(artifacts),
        evidenceIds: [],
        startedAt,
        completedAt
      },
      artifacts,
      evidence: [],
      sources,
      sourceCandidates: sources,
      claims,
      observations,
      toolRuns,
      nextActions: collectStrings(parsed.nextActions),
      needsMoreEvidence: Boolean(parsed.needsMoreEvidence),
      needsMoreAnalysis: Boolean(parsed.needsMoreAnalysis)
    };
  }

}

interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  recoveredOutput?: OpenCodeRunOutput;
}

interface OpenCodeSchema {
  summary?: string;
  toolPlan?: string[];
  artifacts?: Array<{ title?: string; relativePath?: string; mimeType?: string; content?: string; summary?: string }>;
  claims?: Array<Record<string, unknown>>;
  observations?: Array<Record<string, unknown>>;
  sourceCandidates?: Array<Record<string, unknown>>;
  evidence?: Array<Record<string, unknown>>;
  nextActions?: string[];
  needsMoreEvidence?: boolean;
  needsMoreAnalysis?: boolean;
}

interface FilesystemOptimizationValidation {
  summary: string;
  resultPath: string;
  codePath: string;
  selected: Record<string, unknown>;
  provenance: Record<string, unknown>;
}

function recoverOpenCodeFilesystemArtifacts(
  input: OpenCodeRunInput,
  startedAt: string,
  completedAt: string,
  prompt: string,
  error: unknown
): OpenCodeRunOutput | undefined {
  if (!hasOptimizationIntent(input) || !isOpenCodeOutputContractError(error)) return undefined;
  const artifacts = collectOpenCodeFilesystemArtifacts(input, startedAt, completedAt);
  const validation = validateFilesystemOptimizationArtifacts(artifacts);
  if (!validation) return undefined;
  const observations: OpenCodeObservation[] = [{
    title: "OpenCode optimization result",
    content: formatOptimizationObservation(validation),
    metadata: {
      traceabilityKind: "tool_observation",
      canSupportHypothesis: false,
      filesystemArtifactsValidated: true,
      resultPath: validation.resultPath,
      codePath: validation.codePath
    }
  }];
  const toolRuns = normalizeStructuredOutputToolRuns(input, [], observations, [], startedAt, completedAt);
  return {
    run: {
      id: input.openCodeRunId ?? createId("opencode"),
      projectId: input.project.id,
      iteration: input.iteration,
      prompt,
      toolPlan: ["OpenCodeTool", "OpenCodeFilesystemArtifactValidation"],
      status: "completed",
      logs: [
        `OpenCode CLI output contract was not completed: ${formatError(error)}`,
        `Validated ${artifacts.length} real OpenCode filesystem artifact(s) available for iteration ${input.iteration}.`,
        validation.summary
      ],
      artifactIds: collectIds(artifacts),
      evidenceIds: [],
      metadata: {
        completionSource: "opencode-filesystem-artifacts",
        commandError: formatError(error),
        commandErrorMetadata: errorMetadata(error),
        resultPath: validation.resultPath,
        codePath: validation.codePath
      },
      startedAt,
      completedAt
    },
    artifacts,
    evidence: [],
    sources: [],
    sourceCandidates: [],
    claims: [],
    observations,
    toolRuns,
    nextActions: [],
    needsMoreEvidence: false,
    needsMoreAnalysis: false
  };
}

function collectOpenCodeFilesystemArtifacts(
  input: OpenCodeRunInput,
  startedAt: string,
  createdAt: string
): ResearchArtifact[] {
  const projectRoot = input.project.projectRoot?.trim();
  if (!projectRoot) return [];
  const outputDir = join(projectRoot, "artifacts", `iteration-${input.iteration}`, "opencode-optimization");
  if (!existsSync(outputDir)) return [];
  const startedMs = Date.parse(startedAt);
  const fileEntries: Array<{ filePath: string; mtimeMs: number; mtimeIso: string }> = [];
  for (const filePath of listFiles(outputDir)) {
    try {
      const stat = statSync(filePath);
      fileEntries.push({ filePath, mtimeMs: Number(stat.mtimeMs), mtimeIso: stat.mtime.toISOString() });
    } catch {
      continue;
    }
  }
  const validResultEntries = fileEntries.filter(({ filePath }) =>
    isOptimizationResultPath(filePath) &&
    validateOptimizationResultJson(readTextFile(filePath))
  );
  const freshResultExists = validResultEntries.some(({ mtimeMs }) => isFreshFilesystemArtifact(mtimeMs, startedMs));
  const recentResultExists = validResultEntries.some(({ mtimeMs }) => isRecentFilesystemArtifact(mtimeMs));
  const artifacts: ResearchArtifact[] = [];
  for (const { filePath, mtimeMs, mtimeIso } of fileEntries.slice(0, 24)) {
    const usableOptimizationArtifact =
      (freshResultExists || recentResultExists) &&
      (isOptimizationCodePath(filePath) || isOptimizationResultPath(filePath));
    if (!isFreshFilesystemArtifact(mtimeMs, startedMs) && !usableOptimizationArtifact) {
      continue;
    }
    const content = readTextFile(filePath);
    if (!content) continue;
    const relativePath = normalizeRelativePath(projectRoot, filePath);
    artifacts.push({
      id: createId("artifact"),
      projectId: input.project.id,
      category: "generated_artifact",
      title: inferFilesystemArtifactTitle(relativePath, content),
      relativePath,
      mimeType: mimeTypeForPath(filePath),
      summary: summarizeFilesystemArtifact(relativePath, content),
      content,
      rawPath: filePath,
      metadata: {
        provider: "opencode",
        completionSource: "opencode-filesystem-artifacts",
        fileMtime: mtimeIso
      },
      createdAt
    });
  }
  return artifacts.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
}

function isFreshFilesystemArtifact(mtimeMs: number, startedMs: number): boolean {
  return !Number.isFinite(startedMs) || mtimeMs >= startedMs - 5_000;
}

function isRecentFilesystemArtifact(mtimeMs: number): boolean {
  return Number.isFinite(mtimeMs) && Date.now() - mtimeMs <= 30 * 60_000;
}

function isOptimizationCodePath(filePath: string): boolean {
  return /optimization/i.test(filePath) && /\.(py|ts|js|mjs|cjs)$/i.test(filePath);
}

function isOptimizationResultPath(filePath: string): boolean {
  return /optimization/i.test(filePath) && /\.json$/i.test(filePath);
}

function listFiles(root: string): string[] {
  const files: string[] = [];
  const entries = readdirSync(root, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...listFiles(fullPath));
    } else if (entry.isFile()) {
      files.push(fullPath);
    }
  }
  return files;
}

function readTextFile(filePath: string): string | undefined {
  try {
    return readFileSync(filePath, "utf8");
  } catch {
    return undefined;
  }
}

function normalizeRelativePath(projectRoot: string, filePath: string): string {
  return relative(projectRoot, filePath).replace(/\\/g, "/");
}

function inferFilesystemArtifactTitle(relativePath: string, content: string): string {
  const lower = relativePath.toLowerCase();
  if (lower.includes("optimization") && lower.endsWith(".json")) {
    const parsed = parseJsonObject(content);
    const title = parsed ? cleanString(parsed.title) : "";
    return title || "Optimization Result";
  }
  if (lower.includes("optimization")) return "Optimization Code";
  return `OpenCode artifact ${relativePath.split("/").pop() ?? ""}`.trim();
}

function summarizeFilesystemArtifact(relativePath: string, content: string): string {
  const lower = relativePath.toLowerCase();
  if (lower.endsWith(".json")) {
    const parsed = parseJsonObject(content);
    const objective = parsed ? cleanString(parsed.objective) : "";
    const selected = parsed && typeof parsed.selectedOptimum === "object" ? parsed.selectedOptimum as Record<string, unknown> : undefined;
    if (objective && selected) {
      return `OpenCode optimization result for ${objective}; selected ${formatSelectedOptimum(selected)}.`;
    }
  }
  return textExcerpt(content, 500) || "OpenCode generated artifact.";
}

function mimeTypeForPath(filePath: string): string {
  const extension = extname(filePath).toLowerCase();
  if (extension === ".json") return "application/json";
  if (extension === ".py") return "text/x-python";
  if (extension === ".ts") return "text/typescript";
  if (extension === ".js" || extension === ".mjs" || extension === ".cjs") return "text/javascript";
  if (extension === ".md") return "text/markdown";
  return "text/plain";
}

function validateFilesystemOptimizationArtifacts(artifacts: ResearchArtifact[]): FilesystemOptimizationValidation | undefined {
  const codeArtifact = artifacts.find((artifact) =>
    /optimization/i.test(`${artifact.title}\n${artifact.relativePath}`) &&
    /\.(py|ts|js|mjs|cjs)$/i.test(artifact.relativePath)
  );
  const resultArtifact = artifacts.find((artifact) =>
    /optimization/i.test(`${artifact.title}\n${artifact.relativePath}`) &&
    /\.json$/i.test(artifact.relativePath) &&
    validateOptimizationResultJson(artifact.content)
  );
  if (!codeArtifact || !resultArtifact) return undefined;
  const parsed = parseJsonObject(resultArtifact.content);
  if (!parsed) return undefined;
  const selected = optimizationSelectedRecord(parsed);
  if (!selected) return undefined;
  const provenance = parsed.inputDataProvenance as Record<string, unknown>;
  return {
    summary: `OpenCode optimization files are valid: ${codeArtifact.relativePath} and ${resultArtifact.relativePath}.`,
    resultPath: resultArtifact.relativePath,
    codePath: codeArtifact.relativePath,
    selected,
    provenance
  };
}

function validateOptimizationResultJson(content: string | undefined): boolean {
  const parsed = parseJsonObject(content);
  if (!parsed) return false;
  if (!cleanString(parsed.objective)) return false;
  const candidates = optimizationCandidateRows(parsed);
  if (!candidates.length) return false;
  const selected = optimizationSelectedRecord(parsed);
  if (!selected) return false;
  if (!hasFiniteNumber(selectedAlphaValue(selected)) || !hasFiniteNumber(optimizationScoreValue(parsed, selected))) return false;
  const provenance = parsed.inputDataProvenance;
  if (!provenance || typeof provenance !== "object") return false;
  const provenanceRecord = provenance as Record<string, unknown>;
  const provenanceTool = provenanceToolName(provenanceRecord);
  const provenanceArtifact = provenanceArtifactPath(provenanceRecord);
  return /EngineeringProgramTool/i.test(provenanceTool) || /engineering-program/i.test(provenanceArtifact);
}

function optimizationCandidateRows(parsed: Record<string, unknown>): unknown[] {
  const rows = parsed.candidates ?? parsed.comparedCandidates ?? parsed.evaluatedCandidates ?? parsed.rows;
  return Array.isArray(rows) ? rows : [];
}

function optimizationSelectedRecord(parsed: Record<string, unknown>): Record<string, unknown> | undefined {
  const selected = parsed.selectedOptimum ?? parsed.optimum ?? parsed.bestCandidate ?? parsed.selected;
  return selected && typeof selected === "object" && !Array.isArray(selected) ? selected as Record<string, unknown> : undefined;
}

function formatOptimizationObservation(validation: FilesystemOptimizationValidation): string {
  const selected = formatSelectedOptimum(validation.selected);
  const provenanceArtifact = provenanceArtifactPath(validation.provenance);
  const provenanceRuntime = cleanString(validation.provenance.runtime);
  const provenanceSource = cleanString(validation.provenance.sourceUrl);
  return [
    `Validated OpenCode optimization output from ${validation.resultPath}.`,
    `Selected optimum: ${selected}.`,
    provenanceArtifact ? `Input artifact: ${provenanceArtifact}.` : "",
    provenanceRuntime ? `Runtime: ${provenanceRuntime}.` : "",
    provenanceSource ? `Source URL: ${provenanceSource}.` : ""
  ].filter(Boolean).join(" ");
}

function provenanceToolName(provenance: Record<string, unknown>): string {
  return (
    cleanString(provenance.tool) ||
    cleanString(provenance.toolContext) ||
    cleanString(provenance.sourceTool) ||
    cleanString(provenance.generatedBy)
  );
}

function provenanceArtifactPath(provenance: Record<string, unknown>): string {
  return (
    cleanString(provenance.artifact) ||
    cleanString(provenance.artifactPath) ||
    cleanString(provenance.sourceArtifact) ||
    cleanString(provenance.sourceArtifactPath) ||
    cleanString(provenance.sourceArtifactRelativePath) ||
    cleanString(provenance.engineeringArtifact) ||
    cleanString(provenance.inputArtifact) ||
    cleanString(provenance.artifactRelativePath)
  );
}

function formatSelectedOptimum(selected: Record<string, unknown>): string {
  const parts = [
    numericPart("alpha", selectedAlphaValue(selected)),
    numericPart("CL", selectedCoefficientValue(selected, "cl")),
    numericPart("CD", selectedCoefficientValue(selected, "cd")),
    numericPart("L/D", optimizationScoreValue(undefined, selected))
  ].filter(Boolean);
  return parts.length ? parts.join(", ") : JSON.stringify(boundedObject(selected, 8, 300));
}

function optimizationScoreValue(parsed: Record<string, unknown> | undefined, selected: Record<string, unknown>): unknown {
  return selected.liftToDrag ?? selected.ld ?? selected.lOverD ?? selected.l_d ?? selected.score ?? selected.objectiveValue ?? parsed?.score;
}

function selectedAlphaValue(selected: Record<string, unknown>): unknown {
  if (selected.alpha !== undefined) return selected.alpha;
  const variables = selected.variables;
  return variables && typeof variables === "object" && !Array.isArray(variables)
    ? (variables as Record<string, unknown>).alpha
    : undefined;
}

function selectedCoefficientValue(selected: Record<string, unknown>, key: "cl" | "cd"): unknown {
  if (selected[key] !== undefined) return selected[key];
  const coefficients = selected.coefficients;
  return coefficients && typeof coefficients === "object" && !Array.isArray(coefficients)
    ? (coefficients as Record<string, unknown>)[key]
    : undefined;
}

function numericPart(label: string, value: unknown): string | undefined {
  return typeof value === "number" && Number.isFinite(value) ? `${label}=${value}` : undefined;
}

function hasFiniteNumber(value: unknown): boolean {
  return typeof value === "number" && Number.isFinite(value);
}

function parseJsonObject(content: unknown): Record<string, unknown> | undefined {
  const text = cleanString(content);
  if (!text) return undefined;
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : undefined;
  } catch {
    return undefined;
  }
}

function isOpenCodeOutputContractError(error: unknown): boolean {
  const metadata = errorMetadata(error);
  return metadata?.timeout === true || metadata?.parseFailure === true || metadata?.artifactCompletion === true;
}

function errorMetadata(error: unknown): Record<string, unknown> | undefined {
  return error && typeof error === "object" && "metadata" in error
    ? (error as { metadata?: Record<string, unknown> }).metadata
    : undefined;
}

function runCommand(
  command: string,
  args: string[],
  timeoutMs: number,
  artifactProbe?: () => OpenCodeRunOutput | undefined
): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const child = spawn(command, args, {
      windowsHide: true,
      shell: isWindowsShellCommand(command),
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        PYTHONIOENCODING: "utf-8",
        LANG: process.env.LANG ?? "C.UTF-8",
        LC_ALL: process.env.LC_ALL ?? "C.UTF-8"
      }
    });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    const clearTimers = () => {
      clearTimeout(timer);
      if (probeTimer) clearInterval(probeTimer);
    };
    const settleResolve = (result: CommandResult) => {
      if (settled) return;
      settled = true;
      clearTimers();
      resolve(result);
    };
    const settleReject = (error: unknown) => {
      if (settled) return;
      settled = true;
      clearTimers();
      reject(error);
    };
    const timer = setTimeout(() => {
      child.kill();
      settleReject(commandError(`OpenCode CLI timeout after ${timeoutMs}ms`, {
        timeout: true,
        timeoutMs,
        stdoutTail: decodeCommandTail(stdoutChunks),
        stderrTail: sanitizeCommandOutput(decodeCommandTail(stderrChunks))
      }));
    }, timeoutMs);
    const probeTimer = artifactProbe ? setInterval(() => {
      let recoveredOutput: OpenCodeRunOutput | undefined;
      try {
        recoveredOutput = artifactProbe();
      } catch {
        recoveredOutput = undefined;
      }
      if (!recoveredOutput) return;
      child.kill();
      settleResolve({
        stdout: decodeCommandTail(stdoutChunks),
        stderr: sanitizeCommandOutput(decodeCommandTail(stderrChunks)),
        exitCode: 0,
        recoveredOutput
      });
    }, 2_000) : undefined;
    child.stdout.on("data", (chunk: Buffer) => {
      stdoutChunks.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderrChunks.push(chunk);
    });
    child.on("error", (error) => {
      settleReject(error);
    });
    child.on("close", (exitCode) => {
      if (settled) return;
      try {
        settleResolve({
          stdout: decodeStrictUtf8Chunks(stdoutChunks, "OpenCode stdout"),
          stderr: decodeStrictUtf8Chunks(stderrChunks, "OpenCode stderr"),
          exitCode: exitCode ?? 0
        });
      } catch (error) {
        settleReject(error);
      }
    });
  });
}

function describeResolution(resolution: ReturnType<typeof resolveOpenCodeCommand>): string {
  if (resolution.source === "bundled") {
    return `bundled OpenCode (${resolution.command})`;
  }
  if (resolution.source === "configured") {
    return `configured OpenCode (${resolution.command})`;
  }
  const checked = resolution.checkedPaths.length ? `; checked bundled paths: ${resolution.checkedPaths.join(", ")}` : "";
  return `system OpenCode (${resolution.command})${checked}`;
}

function commandError(message: string, metadata: Record<string, unknown>): Error {
  const error = new Error(message) as Error & { metadata?: Record<string, unknown> };
  error.metadata = metadata;
  return error;
}

function decodeCommandTail(chunks: Buffer[]): string {
  if (!chunks.length) return "";
  const decoded = Buffer.concat(chunks).toString("utf8").replace(/\uFFFD/g, "");
  return decoded.slice(-2000);
}

function sanitizeCommandOutput(text: string): string {
  return text.replace(/(access_token|refresh_token|id_token)["'=:\s]+[A-Za-z0-9._-]+/gi, "$1=<redacted>");
}

function parseOpenCodeJson(stdout: string): OpenCodeSchema | undefined {
  const trimmed = stdout.trim();
  if (!trimmed) {
    return undefined;
  }
  try {
    return schemaFromParsed(JSON.parse(trimmed));
  } catch {
    const lines = trimmed.split(/\r?\n/);
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      const line = lines[index].trim();
      if (!line) continue;
      try {
        const schema = schemaFromParsed(JSON.parse(line));
        if (schema) {
          return schema;
        }
      } catch {
        const extracted = extractJsonObject(line);
        const schema = schemaFromParsed(extracted);
        if (schema) {
          return schema;
        }
      }
    }
    return schemaFromParsed(extractJsonObject(trimmed));
  }
}

function schemaFromParsed(parsed: unknown): OpenCodeSchema | undefined {
  if (!parsed || typeof parsed !== "object") {
    return undefined;
  }
  if ("summary" in parsed || "artifacts" in parsed || "evidence" in parsed || "sourceCandidates" in parsed || "claims" in parsed || "observations" in parsed) {
    return parsed as OpenCodeSchema;
  }
  const content = (parsed as { message?: { content?: string } }).message?.content;
  if (content) {
    return schemaFromParsed(extractJsonObject(content));
  }
  const textEvent = (parsed as { part?: { text?: string } }).part?.text;
  if (textEvent) {
    return schemaFromParsed(extractJsonObject(textEvent));
  }
  return undefined;
}

function extractJsonObject(text: string): unknown {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) {
    return undefined;
  }
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return undefined;
  }
}

function normalizeArtifacts(input: OpenCodeRunInput, parsed: OpenCodeSchema, createdAt: string): ResearchArtifact[] {
  const artifacts: ResearchArtifact[] = [];
  const items = parsed.artifacts ?? [];
  const maxItems = Math.min(items.length, 12);
  for (let index = 0; index < maxItems; index += 1) {
    const artifact = items[index];
    artifacts.push({
      id: createId("artifact"),
      projectId: input.project.id,
      category: "generated_artifact",
      title: cleanString(artifact.title) || `OpenCode artifact ${index + 1}`,
      relativePath: cleanString(artifact.relativePath) || `artifacts/iteration-${input.iteration}/opencode-artifact-${index + 1}.md`,
      mimeType: cleanString(artifact.mimeType) || "text/markdown",
      summary: cleanString(artifact.summary) || "OpenCode generated artifact.",
      content: cleanString(artifact.content) || cleanString(artifact.summary),
      createdAt
    });
  }
  return artifacts;
}

function normalizeClaimLike(items: Array<Record<string, unknown>> | undefined): OpenCodeClaim[] {
  const normalized: OpenCodeClaim[] = [];
  const maxItems = Math.min(items?.length ?? 0, 24);
  for (let index = 0; index < maxItems; index += 1) {
    const item = items?.[index];
    if (!item) continue;
    const content = cleanString(item.content) || cleanString(item.summary) || cleanString(item.quote);
    const sourceUri = cleanString(item.sourceUri) || cleanString(item.url) || undefined;
    const citation = cleanString(item.citation) || undefined;
    if (!content && !sourceUri && !citation) continue;
    normalized.push({
      title: cleanString(item.title) || `OpenCode claim ${index + 1}`,
      content,
      sourceUri,
      citation,
      metadata: {
        traceabilityKind: "tool_observation",
        canSupportHypothesis: false,
        downgradedFromEvidence: item.downgradedFromEvidence === true
      }
    });
  }
  return normalized;
}

function normalizeSourceCandidates(input: OpenCodeRunInput, candidates: Array<Record<string, unknown>>, createdAt: string): ResearchSource[] {
  const sources: ResearchSource[] = [];
  const maxItems = Math.min(candidates.length, 24);
  for (let index = 0; index < maxItems; index += 1) {
    const item = candidates[index];
    const url = cleanString(item.url) || cleanString(item.sourceUri);
    const doi = cleanString(item.doi);
    if (!url && !doi) continue;
    sources.push({
      id: createId("source"),
      projectId: input.project.id,
      kind: doi && !url ? "paper" as const : "web" as const,
      title: cleanString(item.title) || cleanString(item.citation) || `OpenCode source candidate ${index + 1}`,
      url: url || undefined,
      doi: doi || undefined,
      retrievedAt: createdAt,
      metadata: {
        provider: "opencode",
        snippet: cleanString(item.snippet) || cleanString(item.summary) || cleanString(item.quote),
        citation: cleanString(item.citation) || undefined,
        traceabilityKind: "external_source",
        canSupportHypothesis: false,
        sourceCandidateOnly: true
      },
      createdAt
    });
  }
  return sources;
}

function normalizeStructuredOutputToolRuns(
  input: OpenCodeRunInput,
  claims: OpenCodeClaim[],
  observations: OpenCodeObservation[],
  sources: ResearchSource[],
  startedAt: string,
  completedAt: string
): ToolRun[] {
  if (!claims.length && !observations.length && !sources.length) return [];
  const sourceCandidateIds: string[] = [];
  for (const source of sources) sourceCandidateIds.push(source.id);
  return [{
    id: createId("tool"),
    projectId: input.project.id,
    iteration: input.iteration,
    toolName: "OpenCodeStructuredOutput",
    input: { iteration: input.iteration },
    output: { claims, observations, sourceCandidateIds },
    status: "completed",
    startedAt,
    completedAt
  }];
}

function hasOptimizationIntent(input: OpenCodeRunInput): boolean {
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

function optimizationExecutionContract(input: OpenCodeRunInput): string {
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

function toolContextPromptSummary(input: OpenCodeRunInput): Record<string, unknown> {
  return {
    sources: sourcePromptRows(input.sources ?? []),
    evidence: evidencePromptRows(input.evidence ?? []),
    artifacts: artifactPromptRows(input.artifacts ?? []),
    toolRuns: toolRunPromptRows(input.toolRuns ?? [])
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
  const record = output && typeof output === "object" ? output as Record<string, unknown> : undefined;
  if (!record) return output;
  const outputs = Array.isArray(record.outputs) ? record.outputs : [];
  return {
    artifactCount: record.artifactCount,
    outputCount: outputs.length,
    outputs: outputs.slice(0, 8).map((item) => {
      const outputRecord = item && typeof item === "object" ? item as Record<string, unknown> : {};
      const summary = outputRecord.summary && typeof outputRecord.summary === "object" ? outputRecord.summary as Record<string, unknown> : undefined;
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

function boundedObject(value: unknown, maxKeys: number, maxTextLength: number): unknown {
  if (value === undefined || value === null) return value;
  if (typeof value === "string") return textExcerpt(value, maxTextLength);
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.slice(0, maxKeys).map((item) => boundedObject(item, maxKeys, maxTextLength));
  if (typeof value !== "object") return String(value);
  const output: Record<string, unknown> = {};
  let count = 0;
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (count >= maxKeys) break;
    if (/stdout|stderr|rawText|prompt/i.test(key)) {
      output[key] = textExcerpt(cleanString(item), Math.min(maxTextLength, 500));
    } else {
      output[key] = boundedObject(item, maxKeys, maxTextLength);
    }
    count += 1;
  }
  return output;
}

function textExcerpt(value: unknown, limit: number): string | undefined {
  const text = cleanString(value);
  if (!text) return undefined;
  return text.length > limit ? `${text.slice(0, limit)}...` : text;
}

function projectContextPromptSummary(input: OpenCodeRunInput): {
  id: string;
  iteration: number;
  citations: string[];
  selectedSourceIds: string[];
} | undefined {
  const context = input.projectContextSnapshot;
  if (!context) return undefined;
  return {
    id: context.id,
    iteration: context.iteration,
    citations: collectLimitedStrings(context.citations, 12),
    selectedSourceIds: collectLimitedStrings(context.selectedSourceIds, 12)
  };
}

function mergeSourceCandidateRecords(
  parsedCandidates: Array<Record<string, unknown>> | undefined,
  downgradedCandidates: Array<Record<string, unknown>>
): Array<Record<string, unknown>> {
  if (!parsedCandidates?.length) return downgradedCandidates;
  const merged: Array<Record<string, unknown>> = [];
  for (const candidate of parsedCandidates) merged.push(candidate);
  for (const candidate of downgradedCandidates) merged.push(candidate);
  return merged;
}

function collectIds(items: Array<{ id: string }>): string[] {
  const ids: string[] = [];
  for (const item of items) ids.push(item.id);
  return ids;
}

function collectStrings(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const strings: string[] = [];
  for (const item of value) {
    if (typeof item === "string") strings.push(item);
  }
  return strings;
}

function collectLimitedStrings(values: string[], limit: number): string[] {
  const output: string[] = [];
  const count = Math.min(values.length, limit);
  for (let index = 0; index < count; index += 1) {
    output.push(values[index]);
  }
  return output;
}

function downgradeLegacyEvidence(parsed: OpenCodeSchema): {
  claims: OpenCodeClaim[];
  observations: OpenCodeObservation[];
  sourceCandidates: Array<Record<string, unknown>>;
  downgradedCount: number;
} {
  const claims: OpenCodeClaim[] = [];
  const observations: OpenCodeObservation[] = [];
  const sourceCandidates: Array<Record<string, unknown>> = [];
  const evidence = parsed.evidence ?? [];
  const maxItems = Math.min(evidence.length, 24);
  for (let index = 0; index < maxItems; index += 1) {
    const item = evidence[index];
    const title = cleanString(item.title) || "Downgraded OpenCode claim";
    const content = cleanString(item.summary) || cleanString(item.quote) || cleanString(item.citation) || cleanString(item.sourceUri);
    const sourceUri = cleanString(item.sourceUri);
    const citation = cleanString(item.citation);
    const downgraded = { title, content, sourceUri: sourceUri || undefined, citation: citation || undefined, metadata: { downgradedFromEvidence: true, canSupportHypothesis: false } };
    if (normalizeCategory(item.category) === "generated_artifact") {
      observations.push(downgraded);
    } else {
      claims.push(downgraded);
    }
    if (sourceUri || cleanString(item.doi)) {
      sourceCandidates.push({
        title,
        url: sourceUri,
        doi: cleanString(item.doi),
        citation,
        snippet: content,
        downgradedFromEvidence: true
      });
    }
  }
  return { claims, observations, sourceCandidates, downgradedCount: claims.length + observations.length };
}

function formatOpenCodeModel(settings: AppSettings): string | undefined {
  const model = settings.openCode.model || (settings.openCodeLlm.source === "api" ? settings.openCodeLlm.model : undefined);
  const provider = settings.openCode.provider || (settings.openCodeLlm.source === "api" ? settings.openCodeLlm.provider : undefined);
  if (!model) {
    return undefined;
  }
  return model.includes("/") || !provider ? model : `${provider}/${model}`;
}

function normalizeCategory(value: unknown): EvidenceItem["category"] {
  const allowed: EvidenceItem["category"][] = ["generated_artifact", "paper_reference", "web_source", "experiment_log", "conversation_memo"];
  return allowed.includes(value as EvidenceItem["category"]) ? (value as EvidenceItem["category"]) : "experiment_log";
}

function cleanString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
