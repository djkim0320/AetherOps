import { createId, nowIso } from "./ids.js";
import type { LlmProvider } from "./llm.js";
import type {
  EvidenceBasedResult,
  EvidenceItem,
  Hypothesis,
  HypothesisStatus,
  ResearchProject,
  ResearchQuestion,
  ResearchSnapshot
} from "./types.js";

interface LlmSeedResponse {
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

interface LlmResultResponse {
  answer?: string;
  finalAnswer?: string;
  summary?: string;
  hypothesisUpdates?: Array<{
    hypothesisIndex: number;
    status: HypothesisStatus;
    confidence: number;
    rationale: string;
  }>;
  quantitativeResults?: string[];
  qualitativeResults?: string[];
  nextQuestions?: string[];
  needsMoreEvidence?: boolean;
  needsMoreAnalysis?: boolean;
}

export async function generateSeedPlanWithLlm(
  llm: LlmProvider,
  project: ResearchProject
): Promise<
  | {
      questions: ResearchQuestion[];
      hypotheses: Hypothesis[];
      evidence: EvidenceItem[];
    }
  | undefined
> {
  if (!(await llm.isAvailable())) {
    return undefined;
  }

  const response = await llm.completeJson<LlmSeedResponse>({
    schemaName: "AetherOpsSeedResearchPlan",
    system: "You are AetherOps, a Korean autonomous research planning agent. Return only valid JSON.",
    user: [
      "Create initial research questions, hypotheses, and seed evidence for this project.",
      "Create 3 to 5 focused questions.",
      "Hypotheses must be testable and tied to a question.",
      "Seed evidence is only a planning memo unless it has citation/sourceUri. Do not pretend it is a paper or external source.",
      "For uncertain claims, include limitations and low reliabilityScore.",
      "Return JSON with keys: questions, hypotheses, evidence.",
      "questions: array of { text }.",
      "hypotheses: array of { questionIndex, statement, confidence } using zero-based questionIndex.",
      "evidence: array of { category, title, summary, sourceUri, citation, quote, reliabilityScore, relevanceScore, evidenceStrength, limitations, keywords, hypothesisIndexes }.",
      "Allowed categories: generated_artifact, paper_reference, web_source, experiment_log, conversation_memo.",
      "",
      `Goal: ${project.goal}`,
      `Topic: ${project.topic}`,
      `Scope: ${project.scope}`,
      `Budget: ${project.budget}`,
      `Autonomy: ${JSON.stringify(project.autonomyPolicy)}`
    ].join("\n"),
    timeoutMs: 180_000
  });

  const createdAt = nowIso();
  const questions = buildSeedQuestions(response.questions, project, createdAt);

  if (questions.length < 3) {
    return undefined;
  }

  const hypotheses = buildSeedHypotheses(response.hypotheses, project, questions, createdAt);
  const evidence = buildSeedEvidence(response.evidence, project, hypotheses, createdAt);

  return {
    questions,
    hypotheses,
    evidence
  };
}

export async function deriveResultWithLlm(
  llm: LlmProvider,
  snapshot: ResearchSnapshot,
  iteration: number,
  forceStop: boolean
): Promise<EvidenceBasedResult | undefined> {
  if (!(await llm.isAvailable())) {
    return undefined;
  }

  let response = await requestResultJson(llm, snapshot, iteration, forceStop);
  let answer = cleanText(response.answer ?? response.finalAnswer ?? response.summary);
  if (!answer) {
    response = await requestResultJson(llm, snapshot, iteration, forceStop, true);
    answer = cleanText(response.answer ?? response.finalAnswer ?? response.summary);
  }

  const createdAt = nowIso();
  if (!answer) {
    return undefined;
  }
  const hypothesisUpdates: EvidenceBasedResult["hypothesisUpdates"] = [];
  for (const update of normalizeArray(response.hypothesisUpdates)) {
    const hypothesis = snapshot.hypotheses[update.hypothesisIndex];
    if (!hypothesis) continue;
    hypothesisUpdates.push({
      hypothesisId: hypothesis.id,
      status: normalizeStatus(update.status),
      confidence: clampConfidence(update.confidence),
      rationale: cleanText(update.rationale) || "LLM derived update without detailed rationale."
    });
  }

  return {
    id: createId("result"),
    projectId: snapshot.project.id,
    iteration,
    answer,
    hypothesisUpdates,
    quantitativeResults: collectCleanStrings(response.quantitativeResults),
    qualitativeResults: collectCleanStrings(response.qualitativeResults),
    nextQuestions: forceStop ? [] : collectCleanStrings(response.nextQuestions, 5),
    needsMoreEvidence: forceStop ? false : Boolean(response.needsMoreEvidence),
    needsMoreAnalysis: forceStop ? false : Boolean(response.needsMoreAnalysis),
    createdAt
  };
}

function requestResultJson(
  llm: LlmProvider,
  snapshot: ResearchSnapshot,
  iteration: number,
  forceStop: boolean,
  repair = false
): Promise<LlmResultResponse> {
  const user = repair
    ? [
        "The previous response omitted a non-empty answer. Produce a concise evidence-based JSON result now.",
        "Return JSON with keys: answer, hypothesisUpdates, quantitativeResults, qualitativeResults, nextQuestions, needsMoreEvidence, needsMoreAnalysis.",
        "answer is required and must be a non-empty Korean string.",
        "hypothesisUpdates uses zero-based hypothesisIndex and status among supported, rejected, needs_more_evidence, untested.",
        forceStop ? "The internal runaway-prevention safety cap has been reached; synthesize cautiously, set needsMoreEvidence=false, needsMoreAnalysis=false, and list unresolved limits instead of requesting another loop." : "",
        `Project: ${JSON.stringify({
          topic: snapshot.project.topic,
          goal: snapshot.project.goal.slice(0, 1_200)
        })}`,
        `Hypotheses: ${JSON.stringify(hypothesisPromptRows(snapshot.hypotheses))}`,
        `ValidationResults: ${JSON.stringify(latestValidationPromptRows(snapshot.validationResults, 8))}`,
        `EvidenceCitations: ${JSON.stringify(latestEvidenceCitationRows(snapshot.evidence, 12))}`,
        `HybridCitations: ${JSON.stringify(limitedStrings(snapshot.hybridContexts.at(-1)?.citations, 12))}`
      ].join("\n")
    : [
        "Derive an evidence-based research result from the current project state.",
        "Use only evidence and RAG context. Treat evidence without citation/sourceUri/sourceId as low reliability.",
        "Every hypothesis update must include a concrete rationale grounded in evidence or an explicit evidence_gap.",
        "Separate quantitativeResults and qualitativeResults.",
        "If this is the final iteration, do not force certainty; state limitations and additional research needs.",
        "Return JSON with keys: answer, hypothesisUpdates, quantitativeResults, qualitativeResults, nextQuestions, needsMoreEvidence, needsMoreAnalysis.",
        "hypothesisUpdates uses zero-based hypothesisIndex and status among supported, rejected, needs_more_evidence, untested.",
        forceStop ? "The internal runaway-prevention safety cap has been reached; synthesize cautiously, set needsMoreEvidence=false, needsMoreAnalysis=false, and list unresolved limits instead of requesting another loop." : "",
        "",
        `Project: ${JSON.stringify(snapshot.project)}`,
        `Questions: ${JSON.stringify(snapshot.questions)}`,
        `Hypotheses: ${JSON.stringify(snapshot.hypotheses)}`,
        `ProjectContextSnapshot: ${JSON.stringify(snapshot.projectContextSnapshots.at(-1))}`,
        `ValidationResults: ${JSON.stringify(validationResultsForIteration(snapshot.validationResults, iteration))}`,
        `Hybrid Context: ${JSON.stringify(snapshot.hybridContexts.at(-1))}`,
        `Selected Evidence: ${JSON.stringify(selectedEvidencePromptRows(snapshot))}`,
        `Selected Chunks: ${JSON.stringify(selectedChunkPromptRows(snapshot))}`,
        `OpenCode Runs: ${JSON.stringify(openCodeRunPromptRows(snapshot.openCodeRuns))}`,
        `Tool Runs: ${JSON.stringify(lastItems(snapshot.toolRuns, 12))}`
      ].join("\n");
  return llm.completeJson<LlmResultResponse>({
    schemaName: "AetherOpsEvidenceBasedResult",
    system: "You are AetherOps, a Korean autonomous research agent. Return only valid JSON.",
    user,
    timeoutMs: 180_000
  });
}

function normalizeArray<T>(value: T[] | undefined | null): T[] {
  return Array.isArray(value) ? value : [];
}

function hypothesisPromptRows(hypotheses: Hypothesis[]): Array<{ index: number; statement: string; status: HypothesisStatus; confidence: number }> {
  const rows: Array<{ index: number; statement: string; status: HypothesisStatus; confidence: number }> = [];
  for (let index = 0; index < hypotheses.length; index += 1) {
    const hypothesis = hypotheses[index];
    rows.push({
      index,
      statement: hypothesis.statement,
      status: hypothesis.status,
      confidence: hypothesis.confidence
    });
  }
  return rows;
}

function latestValidationPromptRows(
  validations: ResearchSnapshot["validationResults"],
  limit: number
): Array<{
  hypothesisId?: string;
  status: string;
  confidence: number;
  reasoningSummary: string;
  limitations: string[];
  evidenceGaps: string[];
}> {
  const rows: Array<{
    hypothesisId?: string;
    status: string;
    confidence: number;
    reasoningSummary: string;
    limitations: string[];
    evidenceGaps: string[];
  }> = [];
  const start = Math.max(0, validations.length - limit);
  for (let index = start; index < validations.length; index += 1) {
    const result = validations[index];
    rows.push({
      hypothesisId: result.hypothesisId,
      status: result.status,
      confidence: result.confidence,
      reasoningSummary: result.reasoningSummary,
      limitations: limitedStrings(result.limitations, 4),
      evidenceGaps: limitedStrings(result.evidenceGaps, 4)
    });
  }
  return rows;
}

function latestEvidenceCitationRows(
  evidence: EvidenceItem[],
  limit: number
): Array<{
  title: string;
  citation?: string;
  sourceUri?: string;
  reliabilityScore?: number;
  relevanceScore?: number;
  evidenceStrength?: EvidenceItem["evidenceStrength"];
  limitations?: string[];
}> {
  const rows: Array<{
    title: string;
    citation?: string;
    sourceUri?: string;
    reliabilityScore?: number;
    relevanceScore?: number;
    evidenceStrength?: EvidenceItem["evidenceStrength"];
    limitations?: string[];
  }> = [];
  const start = Math.max(0, evidence.length - limit);
  for (let index = start; index < evidence.length; index += 1) {
    const item = evidence[index];
    rows.push({
      title: item.title,
      citation: item.citation,
      sourceUri: item.sourceUri,
      reliabilityScore: item.reliabilityScore,
      relevanceScore: item.relevanceScore,
      evidenceStrength: item.evidenceStrength,
      limitations: optionalLimitedStrings(item.limitations, 3)
    });
  }
  return rows;
}

function validationResultsForIteration(
  validations: ResearchSnapshot["validationResults"],
  iteration: number
): ResearchSnapshot["validationResults"] {
  const rows: ResearchSnapshot["validationResults"] = [];
  for (const result of validations) {
    if (result.iteration === iteration) rows.push(result);
  }
  return rows;
}

function selectedEvidencePromptRows(snapshot: ResearchSnapshot): Array<{
  title: string;
  citation?: string;
  sourceUri?: string;
  reliabilityScore?: number;
  relevanceScore?: number;
  evidenceStrength?: EvidenceItem["evidenceStrength"];
  limitations?: string[];
}> {
  const latestContext = snapshot.projectContextSnapshots.at(-1);
  if (!latestContext) return [];
  if (!latestContext.selectedEvidenceIds.length) return [];
  const selectedEvidenceIds = new Set(latestContext.selectedEvidenceIds);
  const rows: Array<{
    title: string;
    citation?: string;
    sourceUri?: string;
    reliabilityScore?: number;
    relevanceScore?: number;
    evidenceStrength?: EvidenceItem["evidenceStrength"];
    limitations?: string[];
  }> = [];
  for (const item of snapshot.evidence) {
    if (!selectedEvidenceIds.has(item.id)) continue;
    rows.push({
      title: item.title,
      citation: item.citation,
      sourceUri: item.sourceUri,
      reliabilityScore: item.reliabilityScore,
      relevanceScore: item.relevanceScore,
      evidenceStrength: item.evidenceStrength,
      limitations: optionalLimitedStrings(item.limitations, 3)
    });
  }
  return rows;
}

function selectedChunkPromptRows(snapshot: ResearchSnapshot): Array<{ id: string; sourceId?: string; text: string; citation?: string }> {
  const latestContext = snapshot.projectContextSnapshots.at(-1);
  if (!latestContext) return [];
  if (!latestContext.selectedChunkIds.length) return [];
  const selectedChunkIds = new Set(latestContext.selectedChunkIds);
  const rows: Array<{ id: string; sourceId?: string; text: string; citation?: string }> = [];
  for (const chunk of snapshot.chunks) {
    if (!selectedChunkIds.has(chunk.id)) continue;
    rows.push({
      id: chunk.id,
      sourceId: chunk.sourceId,
      text: chunk.text.slice(0, 500),
      citation: chunk.citation
    });
  }
  return rows;
}

function openCodeRunPromptRows(openCodeRuns: ResearchSnapshot["openCodeRuns"]): Array<{ iteration: number; logs: string[]; toolPlan: string[] }> {
  const rows: Array<{ iteration: number; logs: string[]; toolPlan: string[] }> = [];
  for (const run of openCodeRuns) {
    rows.push({ iteration: run.iteration, logs: run.logs, toolPlan: run.toolPlan });
  }
  return rows;
}

function lastItems<T>(items: T[], limit: number): T[] {
  const output: T[] = [];
  const start = Math.max(0, items.length - limit);
  for (let index = start; index < items.length; index += 1) {
    output.push(items[index]);
  }
  return output;
}

function limitedStrings(values: string[] | undefined, limit: number): string[] {
  const output: string[] = [];
  if (!values) return output;
  const count = Math.min(values.length, limit);
  for (let index = 0; index < count; index += 1) {
    output.push(values[index]);
  }
  return output;
}

function optionalLimitedStrings(values: string[] | undefined, limit: number): string[] | undefined {
  return values ? limitedStrings(values, limit) : undefined;
}

function buildSeedQuestions(
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

function buildSeedHypotheses(
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

function buildSeedEvidence(
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

function cleanText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function clampConfidence(value: unknown): number {
  const number = typeof value === "number" && Number.isFinite(value) ? value : 0.5;
  return Math.max(0, Math.min(1, number));
}

function normalizeCategory(value: unknown): EvidenceItem["category"] {
  return allowedEvidenceCategories.has(value as EvidenceItem["category"]) ? (value as EvidenceItem["category"]) : "conversation_memo";
}

function normalizeStrength(value: unknown): EvidenceItem["evidenceStrength"] {
  return value === "medium" || value === "strong" || value === "weak" ? value : "weak";
}

function normalizeStatus(value: unknown): HypothesisStatus {
  return allowedHypothesisStatuses.has(value as HypothesisStatus) ? (value as HypothesisStatus) : "needs_more_evidence";
}

function collectCleanStrings(value: string[] | undefined, limit = Number.POSITIVE_INFINITY): string[] {
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
