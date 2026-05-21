import { spawn } from "node:child_process";
import { createId, nowIso } from "../../core/ids.js";
import type {
  AppSettings,
  EvidenceItem,
  OpenCodeAdapter,
  OpenCodeRunInput,
  OpenCodeRunOutput,
  ResearchArtifact
} from "../../core/types.js";
import { isWindowsShellCommand, resolveOpenCodeCommand, type OpenCodeCommandOptions } from "./opencodeResolver.js";

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
    const raw = await runCommand(resolution.command, ["--version"], Math.min(settings.openCode.timeoutMs, 10_000));
    if (raw.exitCode !== 0) {
      throw new Error(
        `OpenCode CLI preflight failed with code ${raw.exitCode} using ${describeResolution(resolution)}: ${
          raw.stderr || raw.stdout || "no output"
        }`
      );
    }
  }

  async run(input: OpenCodeRunInput): Promise<OpenCodeRunOutput> {
    const settings = await this.getSettings();
    const startedAt = nowIso();
    if (!settings.openCode.enabled) {
      throw new Error("OpenCode execution engine is disabled in settings.");
    }

    const resolution = resolveOpenCodeCommand(settings.openCode.command, this.commandOptions);
    const raw = await runCommand(resolution.command, this.buildArgs(input, settings), settings.openCode.timeoutMs);
    const completedAt = nowIso();
    if (raw.exitCode !== 0) {
      throw new Error(`OpenCode CLI exited with code ${raw.exitCode} using ${describeResolution(resolution)}: ${raw.stderr || raw.stdout || "no output"}`);
    }
    const parsed = parseOpenCodeJson(raw.stdout);
    if (!parsed) {
      throw new Error(`OpenCode output JSON parsing failed using ${describeResolution(resolution)}: ${(raw.stdout || raw.stderr || "no output").slice(0, 2000)}`);
    }

    return this.fromParsed(input, parsed, startedAt, completedAt, raw.stderr);
  }

  private buildArgs(input: OpenCodeRunInput, settings: AppSettings): string[] {
    const args = ["run", "--format", "json"];
    const model = formatOpenCodeModel(settings);
    if (model) {
      args.push("--model", model);
    }
    args.push(this.buildPrompt(input));
    return args;
  }

  private buildPrompt(input: OpenCodeRunInput): string {
    return [
      "You are the execution engine for AetherOps.",
      "Return a single JSON object matching this schema:",
      JSON.stringify({
        summary: "string",
        toolPlan: ["string"],
        artifacts: [{ title: "string", relativePath: "string", mimeType: "string", content: "string", summary: "string" }],
        evidence: [
          {
            category: "generated_artifact|paper_reference|web_source|experiment_log|conversation_memo",
            title: "string",
            summary: "string",
            sourceUri: "string",
            citation: "string",
            quote: "string",
            keywords: ["string"],
            linkedHypothesisIds: ["string"],
            reliabilityScore: 0.5,
            relevanceScore: 0.5,
            evidenceStrength: "weak|medium|strong",
            limitations: ["string"]
          }
        ],
        nextActions: ["string"],
        needsMoreEvidence: true,
        needsMoreAnalysis: true
      }),
      "Never invent paper citations or URLs. If a tool/source is unavailable, report the problem in the summary and do not present it as evidence.",
      "",
      `Project: ${JSON.stringify(input.project)}`,
      `Questions: ${JSON.stringify(input.questions)}`,
      `Hypotheses: ${JSON.stringify(input.hypotheses)}`,
      `RAG Context: ${JSON.stringify(input.ragContext)}`,
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
    const artifacts = normalizeArtifacts(input, parsed, completedAt);
    const evidence = normalizeEvidence(input, parsed, completedAt);
    return {
      run: {
        id: createId("opencode"),
        projectId: input.project.id,
        iteration: input.iteration,
        prompt: this.buildPrompt(input),
        toolPlan: parsed.toolPlan?.length ? parsed.toolPlan : ["opencode-cli"],
        status: "completed",
        logs: [
          parsed.summary || "OpenCode CLI execution completed.",
          "OpenCode CLI was resolved from AetherOps bundled dependencies when available.",
          stderr ? `stderr: ${stderr.slice(0, 2000)}` : "stderr: empty"
        ],
        artifactIds: artifacts.map((item) => item.id),
        evidenceIds: evidence.map((item) => item.id),
        startedAt,
        completedAt
      },
      artifacts,
      evidence,
      nextActions: Array.isArray(parsed.nextActions) ? parsed.nextActions.filter((item): item is string => typeof item === "string") : [],
      needsMoreEvidence: Boolean(parsed.needsMoreEvidence),
      needsMoreAnalysis: Boolean(parsed.needsMoreAnalysis)
    };
  }

}

interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

interface OpenCodeSchema {
  summary?: string;
  toolPlan?: string[];
  artifacts?: Array<{ title?: string; relativePath?: string; mimeType?: string; content?: string; summary?: string }>;
  evidence?: Array<Record<string, unknown>>;
  nextActions?: string[];
  needsMoreEvidence?: boolean;
  needsMoreAnalysis?: boolean;
}

function runCommand(command: string, args: string[], timeoutMs: number): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      windowsHide: true,
      shell: isWindowsShellCommand(command),
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`OpenCode CLI timeout after ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (exitCode) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, exitCode: exitCode ?? 0 });
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

function parseOpenCodeJson(stdout: string): OpenCodeSchema | undefined {
  const trimmed = stdout.trim();
  if (!trimmed) {
    return undefined;
  }
  try {
    return schemaFromParsed(JSON.parse(trimmed));
  } catch {
    const lines = trimmed.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    for (const line of [...lines].reverse()) {
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
  if ("summary" in parsed || "artifacts" in parsed || "evidence" in parsed) {
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
  return (parsed.artifacts ?? []).slice(0, 12).map((artifact, index) => ({
    id: createId("artifact"),
    projectId: input.project.id,
    category: "generated_artifact",
    title: cleanString(artifact.title) || `OpenCode artifact ${index + 1}`,
    relativePath: cleanString(artifact.relativePath) || `artifacts/iteration-${input.iteration}/opencode-artifact-${index + 1}.md`,
    mimeType: cleanString(artifact.mimeType) || "text/markdown",
    summary: cleanString(artifact.summary) || "OpenCode generated artifact.",
    content: cleanString(artifact.content) || cleanString(artifact.summary),
    createdAt
  }));
}

function normalizeEvidence(input: OpenCodeRunInput, parsed: OpenCodeSchema, createdAt: string): EvidenceItem[] {
  return (parsed.evidence ?? [])
    .slice(0, 24)
    .filter((item) => cleanString(item.sourceUri) || cleanString(item.citation))
    .filter((item) => normalizeCategory(item.category) !== "generated_artifact")
    .map((item) => ({
      id: createId("evidence"),
      projectId: input.project.id,
      category: normalizeCategory(item.category),
      title: cleanString(item.title) || "OpenCode evidence",
      summary: cleanString(item.summary),
      sourceUri: cleanString(item.sourceUri) || undefined,
      citation: cleanString(item.citation) || undefined,
      quote: cleanString(item.quote) || undefined,
      keywords: normalizeStringArray(item.keywords),
      linkedHypothesisIds: normalizeStringArray(item.linkedHypothesisIds).filter((id) => input.hypotheses.some((hypothesis) => hypothesis.id === id)),
      reliabilityScore: normalizeScore(item.reliabilityScore),
      relevanceScore: normalizeScore(item.relevanceScore),
      evidenceStrength: normalizeStrength(item.evidenceStrength),
      limitations: normalizeStringArray(item.limitations),
      createdAt
    }));
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

function normalizeStrength(value: unknown): EvidenceItem["evidenceStrength"] {
  return value === "medium" || value === "strong" || value === "weak" ? value : "weak";
}

function normalizeScore(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : undefined;
}

function normalizeStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map(cleanString).filter(Boolean).slice(0, 12) : [];
}

function cleanString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
