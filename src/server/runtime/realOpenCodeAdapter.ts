import { spawn } from "node:child_process";
import { createId, nowIso } from "../../core/ids.js";
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
    const downgraded = downgradeLegacyEvidence(parsed);
    const claims = [...normalizeClaimLike(parsed.claims), ...downgraded.claims];
    const observations = [...normalizeClaimLike(parsed.observations), ...downgraded.observations];
    const sources = normalizeSourceCandidates(input, [...(parsed.sourceCandidates ?? []), ...downgraded.sourceCandidates], completedAt);
    const toolRuns = normalizeStructuredOutputToolRuns(input, claims, observations, sources, startedAt, completedAt);
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
          downgraded.downgradedCount ? `Downgraded ${downgraded.downgradedCount} legacy evidence items to non-support claims/source candidates.` : "No legacy evidence items were returned.",
          stderr ? `stderr: ${stderr.slice(0, 2000)}` : "stderr: empty"
        ],
        artifactIds: artifacts.map((item) => item.id),
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
  claims?: Array<Record<string, unknown>>;
  observations?: Array<Record<string, unknown>>;
  sourceCandidates?: Array<Record<string, unknown>>;
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

function normalizeClaimLike(items: Array<Record<string, unknown>> | undefined): OpenCodeClaim[] {
  return (items ?? []).slice(0, 24).map((item, index) => ({
    title: cleanString(item.title) || `OpenCode claim ${index + 1}`,
    content: cleanString(item.content) || cleanString(item.summary) || cleanString(item.quote),
    sourceUri: cleanString(item.sourceUri) || cleanString(item.url) || undefined,
    citation: cleanString(item.citation) || undefined,
    metadata: {
      traceabilityKind: "tool_observation",
      canSupportHypothesis: false,
      downgradedFromEvidence: item.downgradedFromEvidence === true
    }
  })).filter((item) => item.content || item.sourceUri || item.citation);
}

function normalizeSourceCandidates(input: OpenCodeRunInput, candidates: Array<Record<string, unknown>>, createdAt: string): ResearchSource[] {
  return candidates.slice(0, 24).flatMap((item, index) => {
    const url = cleanString(item.url) || cleanString(item.sourceUri);
    const doi = cleanString(item.doi);
    if (!url && !doi) return [];
    return [{
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
    }];
  });
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
  return [{
    id: createId("tool"),
    projectId: input.project.id,
    iteration: input.iteration,
    toolName: "OpenCodeStructuredOutput",
    input: { iteration: input.iteration },
    output: { claims, observations, sourceCandidateIds: sources.map((source) => source.id) },
    status: "completed",
    startedAt,
    completedAt
  }];
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
  for (const item of (parsed.evidence ?? []).slice(0, 24)) {
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
