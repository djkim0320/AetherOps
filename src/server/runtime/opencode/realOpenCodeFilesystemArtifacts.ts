import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join, relative } from "node:path";
import { createId } from "../../../core/shared/ids.js";
import type { OpenCodeObservation, OpenCodeRunInput, OpenCodeRunOutput, ResearchArtifact } from "../../../core/shared/types.js";
import { cleanString, formatError, parseJsonObject, textExcerpt } from "./realOpenCodeCommon.js";
import { hasOpenCodeOptimizationIntent } from "./realOpenCodePromptBuilder.js";
import { buildOpenCodeStructuredOutputToolRuns } from "./realOpenCodeNormalizer.js";
import {
  formatOptimizationObservation,
  formatSelectedOptimum,
  validateFilesystemOptimizationArtifacts,
  validateOptimizationResultJson
} from "./realOpenCodeOptimizationValidator.js";
import { getOpenCodeErrorMetadata } from "./realOpenCodeProcessRunner.js";

export function recoverOpenCodeFilesystemArtifacts(
  input: OpenCodeRunInput,
  startedAt: string,
  completedAt: string,
  prompt: string,
  error: unknown
): OpenCodeRunOutput | undefined {
  if (!hasOpenCodeOptimizationIntent(input) || !isOpenCodeOutputContractError(error)) return undefined;
  const artifacts = collectOpenCodeFilesystemArtifacts(input, startedAt, completedAt);
  const validation = validateFilesystemOptimizationArtifacts(artifacts);
  if (!validation) return undefined;
  const observations: OpenCodeObservation[] = [
    {
      title: "OpenCode optimization result",
      content: formatOptimizationObservation(validation),
      metadata: {
        traceabilityKind: "tool_observation",
        canSupportHypothesis: false,
        filesystemArtifactsValidated: true,
        resultPath: validation.resultPath,
        codePath: validation.codePath
      }
    }
  ];
  const toolRuns = buildOpenCodeStructuredOutputToolRuns(input, [], observations, [], startedAt, completedAt);
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
      artifactIds: artifacts.map((artifact) => artifact.id),
      evidenceIds: [],
      metadata: {
        completionSource: "opencode-filesystem-artifacts",
        commandError: formatError(error),
        commandErrorMetadata: getOpenCodeErrorMetadata(error),
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

export function collectOpenCodeFilesystemArtifacts(input: OpenCodeRunInput, startedAt: string, createdAt: string): ResearchArtifact[] {
  const projectRoot = input.project.projectRoot?.trim();
  if (!projectRoot) return [];
  const outputDir = join(projectRoot, "artifacts", `iteration-${input.iteration}`, "opencode-optimization");
  if (!existsSync(outputDir)) return [];
  const startedMs = Date.parse(startedAt);
  const fileEntries: Array<{ filePath: string; mtimeMs: number; mtimeIso: string; content: string }> = [];
  for (const filePath of listFiles(outputDir)) {
    try {
      const stat = statSync(filePath);
      const content = readTextFile(filePath);
      if (content === undefined) continue;
      fileEntries.push({ filePath, mtimeMs: Number(stat.mtimeMs), mtimeIso: stat.mtime.toISOString(), content });
    } catch {
      continue;
    }
  }
  const validResultEntries = fileEntries.filter(({ filePath, content }) => isOptimizationResultPath(filePath) && validateOptimizationResultJson(content));
  const freshResultExists = validResultEntries.some(({ mtimeMs }) => isFreshFilesystemArtifact(mtimeMs, startedMs));
  const recentResultExists = validResultEntries.some(({ mtimeMs }) => isRecentFilesystemArtifact(mtimeMs));
  const artifacts: ResearchArtifact[] = [];
  for (const { filePath, mtimeMs, mtimeIso, content } of fileEntries.slice(0, 24)) {
    const usableOptimizationArtifact = (freshResultExists || recentResultExists) && (isOptimizationCodePath(filePath) || isOptimizationResultPath(filePath));
    if (!isFreshFilesystemArtifact(mtimeMs, startedMs) && !usableOptimizationArtifact) {
      continue;
    }
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

function isOpenCodeOutputContractError(error: unknown): boolean {
  const metadata = getOpenCodeErrorMetadata(error);
  return Boolean(metadata && (metadata.timeout === true || metadata.parseFailure === true || metadata.artifactCompletion === true));
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
    const selected =
      parsed && typeof parsed.selectedOptimum === "object" && !Array.isArray(parsed.selectedOptimum)
        ? (parsed.selectedOptimum as Record<string, unknown>)
        : undefined;
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
