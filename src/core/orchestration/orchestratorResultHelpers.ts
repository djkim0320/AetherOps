import { LlmTimeoutError } from "../providers/llm.js";
import { createStableId } from "../shared/ids.js";
import type { EvidenceBasedResult, EvidenceItem, ResearchLoopStep, ResearchSnapshot, ResearchSource } from "../shared/types.js";
import { ToolRunnerError } from "../tools/toolRunner.js";
import { copyItems } from "./executionBundles.js";

export function sourceFromEvidence(evidence: EvidenceItem, sourceId: string): ResearchSource {
  return {
    id: sourceId,
    projectId: evidence.projectId,
    kind: kindFromEvidence(evidence),
    title: evidence.title,
    url: evidence.sourceUri,
    doi: evidence.doi,
    retrievedAt: evidence.createdAt,
    metadata: {
      evidenceId: evidence.id,
      category: evidence.category,
      citation: evidence.citation,
      quote: evidence.quote,
      reliabilityScore: evidence.reliabilityScore,
      relevanceScore: evidence.relevanceScore,
      evidenceStrength: evidence.evidenceStrength,
      limitations: evidence.limitations
    },
    createdAt: evidence.createdAt
  };
}

function kindFromEvidence(evidence: EvidenceItem): ResearchSource["kind"] {
  if (evidence.category === "web_source") return "web";
  if (evidence.category === "paper_reference") return "paper";
  if (evidence.category === "generated_artifact") return "artifact";
  if (evidence.category === "conversation_memo") return "conversation";
  return "log";
}

export function hypothesisUpdateMap(updates: EvidenceBasedResult["hypothesisUpdates"]): Map<string, EvidenceBasedResult["hypothesisUpdates"][number]> {
  const byHypothesisId = new Map<string, EvidenceBasedResult["hypothesisUpdates"][number]>();
  for (const update of updates) byHypothesisId.set(update.hypothesisId, update);
  return byHypothesisId;
}

export function mergeHypothesisUpdates(
  hypotheses: ResearchSnapshot["hypotheses"],
  updates: Map<string, EvidenceBasedResult["hypothesisUpdates"][number]>
): ResearchSnapshot["hypotheses"] {
  const merged: ResearchSnapshot["hypotheses"] = [];
  for (const hypothesis of hypotheses) {
    const update = updates.get(hypothesis.id);
    merged.push(update ? { ...hypothesis, status: update.status, confidence: update.confidence } : hypothesis);
  }
  return merged;
}

export function withCitationPreservationLine(qualitativeResults: string[], citations: string[]): string[] {
  const output = copyItems(qualitativeResults);
  if (!citations.length) return output;
  const preserved: string[] = [];
  const count = Math.min(citations.length, 5);
  for (let index = 0; index < count; index += 1) {
    preserved.push(citations[index]);
  }
  output.push(`Citations preserved: ${preserved.join("; ")}`);
  return output;
}

export function assertCitationPreservingResult(result: EvidenceBasedResult, hybridContext: import("../shared/types.js").HybridContext): void {
  if (!result.validationResultIds?.length) {
    throw new Error("Result synthesis omitted validationResultIds.");
  }
  if (result.hybridContextId !== hybridContext.id) {
    throw new Error("Result synthesis omitted the active HybridContext reference.");
  }
  if (!hybridContext.citations.length) {
    return;
  }
  const resultText = resultCitationText(result);
  const citesKnownContext = citesAnyKnownContext(resultText, hybridContext.citations);
  if (!citesKnownContext && result.needsMoreEvidence === false) {
    throw new Error("LLM synthesis did not preserve any ProjectContextSnapshot citation.");
  }
}

function resultCitationText(result: EvidenceBasedResult): string {
  const lines = [result.answer];
  for (const item of result.quantitativeResults) lines.push(item);
  for (const item of result.qualitativeResults) lines.push(item);
  for (const update of result.hypothesisUpdates) lines.push(update.rationale);
  return lines.join("\n");
}

function citesAnyKnownContext(resultText: string, citations: string[]): boolean {
  for (const citation of citations) {
    if (resultText.includes(citation) || resultText.includes(citation.slice(0, 40))) return true;
  }
  return false;
}

export function slugify(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 70);
  return slug || createStableId("project", value);
}

export function formatError(error: unknown): string {
  if (error instanceof ToolRunnerError) return "TOOL_EXECUTION_FAILED";
  return error instanceof Error ? error.message : String(error);
}

export function errorMetadata(error: unknown, step: ResearchLoopStep): Record<string, unknown> {
  if (error instanceof LlmTimeoutError) {
    return {
      ...error.metadata,
      step,
      timeout: true
    };
  }
  return {};
}
