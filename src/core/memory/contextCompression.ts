import { extractKeywords } from "../retrieval/chunking.js";
import { createStableId, nowIso } from "../shared/ids.js";
import { tagMemoryScope } from "./researchMemory.js";
import type { NormalizedResearchRecord, ResearchSnapshot, ToolRun } from "../shared/types.js";

const minimumContextChars = 8_000;
const minimumRecords = 24;
const compressionBudgetChars = 6_000;
const compressionRecordLimit = 64;

export class ContextCompressionEngine {
  build(snapshot: ResearchSnapshot, iteration: number): NormalizedResearchRecord[] {
    const sourceRecords = compressionSourceRecords(snapshot);
    const sourceRecordChars = sumChars(sourceRecords.map((record) => record.content));
    const sourceToolRuns = lastItems(snapshot.toolRuns, 16);
    const contextCharEstimate =
      sourceRecordChars +
      sumChars(snapshot.evidence.map((item) => `${item.title}\n${item.summary}\n${item.quote ?? ""}`)) +
      sumChars(snapshot.artifacts.map((item) => `${item.title}\n${item.summary}\n${item.content ?? ""}`)) +
      sumChars(sourceToolRuns.map(toolRunText)) +
      sumChars(snapshot.results.map((item) => `${item.answer}\n${item.quantitativeResults.join("\n")}\n${item.qualitativeResults.join("\n")}`)) +
      sumChars(snapshot.validationResults.map((item) => `${item.reasoningSummary}\n${item.evidenceGaps.join("\n")}`));

    if (!shouldCompress(snapshot, iteration, sourceRecords.length, contextCharEstimate)) {
      return [];
    }

    const content = buildCompressionContent(snapshot, iteration, sourceRecords, sourceToolRuns, compressionBudgetChars);
    if (!content.trim()) return [];

    const sourceRecordIds = sourceRecords.slice(0, compressionRecordLimit).map((record) => record.id);
    const sourceEvidenceIds = uniqueStrings([
      ...sourceRecords.map((record) => record.evidenceId).filter(isString),
      ...lastItems(snapshot.evidence, 24).map((item) => item.id)
    ]);
    const sourceArtifactIds = uniqueStrings([
      ...sourceRecords.map((record) => record.artifactId).filter(isString),
      ...lastItems(snapshot.artifacts, 16).map((item) => item.id)
    ]);
    const sourceToolRunIds = uniqueStrings([
      ...sourceRecords.map((record) => stringMetadata(record.metadata.toolRunId)).filter(isString),
      ...sourceToolRuns.map((item) => item.id)
    ]);
    const sourceResultIds = lastItems(snapshot.results, 8).map((item) => item.id);
    const sourceValidationResultIds = lastItems(snapshot.validationResults, 12).map((item) => item.id);
    const latestInput = snapshot.researchInputs.at(-1);
    const createdAt = nowIso();
    const compressedCharCount = content.length;

    return [
      tagMemoryScope(
        {
          id: createStableId("record", `${snapshot.project.id}:${latestInput?.id ?? "no-input"}:context-compression:${iteration}`),
          projectId: snapshot.project.id,
          iteration,
          kind: "observation",
          title: `Context compression for iteration ${iteration}`,
          content,
          sourceUri: `project://context-compression/${snapshot.project.id}/${iteration}`,
          metadata: {
            traceabilityKind: "project_provenance",
            canSupportHypothesis: false,
            sourceKind: "context_compression",
            contextCompression: true,
            compressionKind: "codex_like_project_context",
            compressedIteration: iteration,
            compressedAt: createdAt,
            sourceRecordIds,
            sourceEvidenceIds,
            sourceArtifactIds,
            sourceToolRunIds,
            sourceResultIds,
            sourceValidationResultIds,
            sourceCounts: {
              records: sourceRecords.length,
              evidence: snapshot.evidence.length,
              artifacts: snapshot.artifacts.length,
              toolRuns: snapshot.toolRuns.length,
              results: snapshot.results.length,
              validationResults: snapshot.validationResults.length,
              projectContextSnapshots: snapshot.projectContextSnapshots.length
            },
            originalCharEstimate: contextCharEstimate,
            compressedCharCount,
            compressionRatio: Number((compressedCharCount / Math.max(contextCharEstimate, 1)).toFixed(4)),
            keywords: extractKeywords(content),
            inferredKeywords: extractKeywords(content, 12),
            domainTags: extractKeywords(`${snapshot.project.topic}\n${snapshot.project.goal}\n${content}`, 8)
          },
          confidence: 0.62,
          validationStatus: "normalized",
          createdAt
        },
        "project_only"
      )
    ];
  }
}

export function isContextCompressionRecord(record: Pick<NormalizedResearchRecord, "metadata">): boolean {
  return record.metadata.contextCompression === true || record.metadata.sourceKind === "context_compression";
}

function shouldCompress(snapshot: ResearchSnapshot, iteration: number, sourceRecordCount: number, contextCharEstimate: number): boolean {
  return (
    iteration > 1 ||
    sourceRecordCount >= minimumRecords ||
    contextCharEstimate >= minimumContextChars ||
    snapshot.toolRuns.length >= 8 ||
    snapshot.evidence.length >= 12 ||
    snapshot.results.length >= 2
  );
}

function compressionSourceRecords(snapshot: ResearchSnapshot): NormalizedResearchRecord[] {
  const candidates: NormalizedResearchRecord[] = [];
  for (let index = snapshot.normalizedRecords.length - 1; index >= 0; index -= 1) {
    const record = snapshot.normalizedRecords[index];
    if (!record || isContextCompressionRecord(record)) continue;
    if (record.kind === "error" || record.validationStatus === "rejected") continue;
    candidates.push(record);
    if (candidates.length >= compressionRecordLimit) break;
  }
  return candidates;
}

function buildCompressionContent(
  snapshot: ResearchSnapshot,
  iteration: number,
  sourceRecords: NormalizedResearchRecord[],
  sourceToolRuns: ToolRun[],
  budgetChars: number
): string {
  const lines: string[] = [];
  const append = (line: string | undefined) => appendBudgetedLine(lines, line, budgetChars);
  const latestPlan = snapshot.researchPlans.at(-1);
  const latestResult = snapshot.results.at(-1);
  const latestDecision = snapshot.continuationDecisions.at(-1);
  const latestContext = snapshot.projectContextSnapshots.at(-1);

  append(`# Project Context Compression`);
  append(`Project: ${snapshot.project.topic}`);
  append(`Goal: ${snapshot.project.goal}`);
  append(`Scope: ${snapshot.project.scope}`);
  append(`Status: ${snapshot.project.status} at ${snapshot.project.currentStep}; compressed iteration ${iteration}.`);
  if (latestPlan) {
    append(`Latest plan: ${latestPlan.objective}`);
    append(`Required tools: ${latestPlan.requiredTools.join(", ") || "none recorded"}.`);
    append(`Execution steps: ${latestPlan.executionSteps.slice(0, 6).join(" / ")}`);
    if (latestPlan.fetchCandidateUrls?.length) append(`Fetch candidates: ${latestPlan.fetchCandidateUrls.slice(0, 6).join(" / ")}`);
    if (latestPlan.programRequests?.length) append(`Program requests: ${latestPlan.programRequests.map((request) => `${request.kind}:${request.target ?? "unspecified"}`).join(" / ")}`);
  }
  if (latestContext) {
    append(`Latest selected context: records=${latestContext.selectedRecordIds.length}, evidence=${latestContext.selectedEvidenceIds.length}, chunks=${latestContext.selectedChunkIds.length}, citations=${latestContext.citations.length}.`);
  }
  if (latestResult) {
    append(`Latest result: ${latestResult.answer}`);
    append(`Quantitative results: ${latestResult.quantitativeResults.slice(0, 6).join(" / ")}`);
    append(`Qualitative results: ${latestResult.qualitativeResults.slice(0, 6).join(" / ")}`);
    append(`Next questions: ${latestResult.nextQuestions.slice(0, 6).join(" / ")}`);
  }
  if (latestDecision) {
    append(`Continuation: shouldContinue=${latestDecision.shouldContinue}; ${latestDecision.reason}`);
    append(`Evidence gaps: ${latestDecision.evidenceGaps.slice(0, 8).join(" / ")}`);
    append(`Plan revision hints: ${latestDecision.planRevisionHints.slice(0, 8).join(" / ")}`);
  }

  append(`## Recent Tool Outcomes`);
  for (const toolRun of sourceToolRuns) {
    append(`- ${toolRun.toolName} ${toolRun.status} iteration=${toolRun.iteration}${toolRun.error ? ` error=${toolRun.error}` : ""}${toolRun.output ? ` output=${compactJson(toolRun.output, 260)}` : ""}`);
  }

  append(`## Evidence And Artifacts`);
  for (const evidence of lastItems(snapshot.evidence, 12)) {
    append(`- Evidence ${evidence.id}: ${evidence.title}; ${evidence.summary}; citation=${evidence.citation ?? evidence.sourceUri ?? evidence.sourceId ?? "none"}; limitations=${(evidence.limitations ?? []).slice(0, 3).join(" / ")}`);
  }
  for (const artifact of lastItems(snapshot.artifacts, 8)) {
    append(`- Artifact ${artifact.id}: ${artifact.title}; ${artifact.summary}; path=${artifact.relativePath}`);
  }

  append(`## Compressed Memory Records`);
  for (const record of sourceRecords.slice(0, 24)) {
    append(`- ${record.kind}:${record.title}; status=${record.validationStatus}; scope=${record.memoryScope}; ${record.content.slice(0, 360)}`);
  }

  return lines.join("\n");
}

function appendBudgetedLine(lines: string[], line: string | undefined, budgetChars: number): void {
  const value = line?.replace(/\s+/g, " ").trim();
  if (!value) return;
  const current = lines.join("\n").length;
  if (current >= budgetChars) return;
  const remaining = budgetChars - current - 1;
  if (value.length <= remaining) {
    lines.push(value);
    return;
  }
  if (remaining > 40) lines.push(`${value.slice(0, remaining - 1).trim()}…`);
}

function toolRunText(toolRun: ToolRun): string {
  return `${toolRun.toolName}\n${toolRun.status}\n${compactJson(toolRun.input, 1_000)}\n${compactJson(toolRun.output, 1_000)}\n${toolRun.error ?? ""}`;
}

function compactJson(value: unknown, limit: number): string {
  if (value === undefined) return "";
  let text: string;
  try {
    text = JSON.stringify(value);
  } catch {
    text = String(value);
  }
  return text.length > limit ? `${text.slice(0, limit).trim()}…` : text;
}

function lastItems<T>(items: T[], limit: number): T[] {
  return items.slice(Math.max(0, items.length - limit));
}

function sumChars(values: string[]): number {
  let total = 0;
  for (const value of values) total += value.length;
  return total;
}

function uniqueStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const output: string[] = [];
  for (const value of values) {
    if (!value || seen.has(value)) continue;
    seen.add(value);
    output.push(value);
  }
  return output;
}

function stringMetadata(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function isString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}
