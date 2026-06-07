import { spawn } from "node:child_process";
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
    const raw = await runCommand(resolution.command, this.buildArgs(input, settings), settings.openCode.timeoutMs);
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
      throw commandError(`OpenCode output JSON parsing failed using ${describeResolution(resolution)}: ${(raw.stdout || raw.stderr || "no output").slice(0, 2000)}`, {
        parseFailure: true,
        stdoutTail: raw.stdout.slice(-2000),
        stderrTail: sanitizeCommandOutput(raw.stderr.slice(-2000))
      });
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
      `ResearchPlan: ${JSON.stringify(input.researchPlan)}`,
      `ProjectContextSnapshot: ${JSON.stringify(projectContextPromptSummary(input))}`,
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
    const timer = setTimeout(() => {
      child.kill();
      reject(commandError(`OpenCode CLI timeout after ${timeoutMs}ms`, {
        timeout: true,
        timeoutMs,
        stdoutTail: decodeCommandTail(stdoutChunks),
        stderrTail: sanitizeCommandOutput(decodeCommandTail(stderrChunks))
      }));
    }, timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => {
      stdoutChunks.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderrChunks.push(chunk);
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (exitCode) => {
      clearTimeout(timer);
      try {
        resolve({
          stdout: decodeStrictUtf8Chunks(stdoutChunks, "OpenCode stdout"),
          stderr: decodeStrictUtf8Chunks(stderrChunks, "OpenCode stderr"),
          exitCode: exitCode ?? 0
        });
      } catch (error) {
        reject(error);
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
