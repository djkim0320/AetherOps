import { createId } from "../shared/ids.js";
import { normalizeArray } from "./llmResultPrompts.js";
import type { EvidenceItem, Hypothesis, HypothesisStatus, ResearchProject, ResearchQuestion } from "../shared/types.js";

export interface LlmSeedResponse {
  questions: Array<{ text: string }>;
  hypotheses: Array<{ questionIndex: number; statement: string; confidence?: number }>;
  evidence: Array<{
    category?: EvidenceItem["category"];
    title: string;
    summary: string;
    sourceUri?: string;
    citation?: string;
    quote?: string;
    reliabilityScore?: number;
    relevanceScore?: number;
    evidenceStrength?: EvidenceItem["evidenceStrength"];
    limitations?: string[];
    keywords?: string[];
    hypothesisIndexes?: number[];
  }>;
}

export function buildSeedQuestions(
  responseQuestions: LlmSeedResponse["questions"] | undefined,
  project: ResearchProject,
  createdAt: string
): ResearchQuestion[] {
  const questions: ResearchQuestion[] = [];
  const values = normalizeArray(responseQuestions);
  const limit = Math.min(values.length, 5);
  for (let index = 0; index < limit; index += 1) {
    const text = cleanText(values[index].text);
    if (!text) continue;
    questions.push({
      id: createId("question"),
      projectId: project.id,
      text,
      status: "open",
      createdAt
    });
  }
  return questions;
}

export function buildSeedHypotheses(
  responseHypotheses: LlmSeedResponse["hypotheses"] | undefined,
  project: ResearchProject,
  questions: ResearchQuestion[],
  createdAt: string
): Hypothesis[] {
  const hypotheses: Hypothesis[] = [];
  const values = normalizeArray(responseHypotheses);
  const limit = Math.min(values.length, 8);
  for (let index = 0; index < limit; index += 1) {
    const item = values[index];
    const statement = cleanText(item.statement);
    if (!statement) continue;
    hypotheses.push({
      id: createId("hypothesis"),
      projectId: project.id,
      questionId: questions[Math.max(0, Math.min(item.questionIndex ?? 0, questions.length - 1))].id,
      statement,
      status: "untested",
      confidence: clampConfidence(item.confidence ?? 0.35),
      createdAt
    });
  }
  return hypotheses;
}

export function buildSeedEvidence(
  responseEvidence: LlmSeedResponse["evidence"] | undefined,
  project: ResearchProject,
  hypotheses: Hypothesis[],
  createdAt: string
): EvidenceItem[] {
  const evidence: EvidenceItem[] = [];
  const values = normalizeArray(responseEvidence);
  const limit = Math.min(values.length, 8);
  for (let index = 0; index < limit; index += 1) {
    const item = values[index];
    const summary = cleanText(item.summary);
    if (!summary) continue;
    evidence.push({
      id: createId("evidence"),
      projectId: project.id,
      category: normalizeCategory(item.category),
      title: cleanText(item.title) || "LLM seed evidence",
      summary,
      sourceUri: cleanText(item.sourceUri) || undefined,
      citation: cleanText(item.citation) || undefined,
      quote: cleanText(item.quote) || undefined,
      keywords: collectCleanStrings(item.keywords, 8),
      linkedHypothesisIds: collectLinkedHypothesisIds(item.hypothesisIndexes, hypotheses),
      reliabilityScore: clampConfidence(item.reliabilityScore ?? (item.citation || item.sourceUri ? 0.55 : 0.25)),
      relevanceScore: clampConfidence(item.relevanceScore ?? 0.5),
      evidenceStrength: normalizeStrength(item.evidenceStrength),
      limitations: collectCleanStrings(item.limitations),
      createdAt
    });
  }
  return evidence;
}

function collectLinkedHypothesisIds(indexes: number[] | undefined, hypotheses: Hypothesis[]): string[] {
  const ids: string[] = [];
  for (const index of normalizeArray(indexes)) {
    const id = hypotheses[index]?.id;
    if (id) ids.push(id);
  }
  return ids;
}

export function cleanText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export function clampConfidence(value: unknown): number {
  const number = typeof value === "number" && Number.isFinite(value) ? value : 0.5;
  return Math.max(0, Math.min(1, number));
}

function normalizeCategory(value: unknown): EvidenceItem["category"] {
  return allowedEvidenceCategories.has(value as EvidenceItem["category"]) ? (value as EvidenceItem["category"]) : "conversation_memo";
}

function normalizeStrength(value: unknown): EvidenceItem["evidenceStrength"] {
  return value === "medium" || value === "strong" || value === "weak" ? value : "weak";
}

export function normalizeStatus(value: unknown): HypothesisStatus {
  return allowedHypothesisStatuses.has(value as HypothesisStatus) ? (value as HypothesisStatus) : "needs_more_evidence";
}

export function collectCleanStrings(value: string[] | undefined, limit = Number.POSITIVE_INFINITY): string[] {
  const output: string[] = [];
  for (const item of normalizeArray(value)) {
    const text = cleanText(item);
    if (!text) continue;
    output.push(text);
    if (output.length >= limit) break;
  }
  return output;
}

const allowedEvidenceCategories = new Set<EvidenceItem["category"]>([
  "generated_artifact",
  "paper_reference",
  "web_source",
  "experiment_log",
  "conversation_memo"
]);

const allowedHypothesisStatuses = new Set<HypothesisStatus>(["untested", "supported", "rejected", "needs_more_evidence"]);
