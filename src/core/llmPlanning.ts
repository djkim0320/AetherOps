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
  answer: string;
  hypothesisUpdates: Array<{
    hypothesisIndex: number;
    status: HypothesisStatus;
    confidence: number;
    rationale: string;
  }>;
  quantitativeResults: string[];
  qualitativeResults: string[];
  nextQuestions: string[];
  needsMoreEvidence: boolean;
  needsMoreAnalysis: boolean;
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
  const questions = normalizeArray(response.questions)
    .slice(0, 5)
    .map((question) => ({
      id: createId("question"),
      projectId: project.id,
      text: cleanText(question.text),
      status: "open" as const,
      createdAt
    }))
    .filter((question) => question.text.length > 0);

  if (questions.length < 3) {
    return undefined;
  }

  const hypotheses = normalizeArray(response.hypotheses)
    .slice(0, 8)
    .map((hypothesis) => ({
      id: createId("hypothesis"),
      projectId: project.id,
      questionId: questions[Math.max(0, Math.min(hypothesis.questionIndex ?? 0, questions.length - 1))].id,
      statement: cleanText(hypothesis.statement),
      status: "untested" as const,
      confidence: clampConfidence(hypothesis.confidence ?? 0.35),
      createdAt
    }))
    .filter((hypothesis) => hypothesis.statement.length > 0);

  const evidence = normalizeArray(response.evidence)
    .slice(0, 8)
    .map((item) => ({
      id: createId("evidence"),
      projectId: project.id,
      category: normalizeCategory(item.category),
      title: cleanText(item.title) || "LLM seed evidence",
      summary: cleanText(item.summary),
      sourceUri: cleanText(item.sourceUri) || undefined,
      citation: cleanText(item.citation) || undefined,
      quote: cleanText(item.quote) || undefined,
      keywords: normalizeArray(item.keywords).map(cleanText).filter(Boolean).slice(0, 8),
      linkedHypothesisIds: normalizeArray(item.hypothesisIndexes)
        .map((index) => hypotheses[index]?.id)
        .filter((id): id is string => Boolean(id)),
      reliabilityScore: clampConfidence(item.reliabilityScore ?? (item.citation || item.sourceUri ? 0.55 : 0.25)),
      relevanceScore: clampConfidence(item.relevanceScore ?? 0.5),
      evidenceStrength: normalizeStrength(item.evidenceStrength),
      limitations: normalizeArray(item.limitations).map(cleanText).filter(Boolean),
      createdAt
    }))
    .filter((item) => item.summary.length > 0);

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

  const response = await llm.completeJson<LlmResultResponse>({
    schemaName: "AetherOpsEvidenceBasedResult",
    system: "You are AetherOps, a Korean autonomous research agent. Return only valid JSON.",
    user: [
      "Derive an evidence-based research result from the current project state.",
      "Use only evidence and RAG context. Treat evidence without citation/sourceUri/sourceId as low reliability.",
      "Every hypothesis update must include a concrete rationale grounded in evidence or an explicit evidence_gap.",
      "Separate quantitativeResults and qualitativeResults.",
      "If this is the final iteration, do not force certainty; state limitations and additional research needs.",
      "Return JSON with keys: answer, hypothesisUpdates, quantitativeResults, qualitativeResults, nextQuestions, needsMoreEvidence, needsMoreAnalysis.",
      "hypothesisUpdates uses zero-based hypothesisIndex and status among supported, rejected, needs_more_evidence, untested.",
      forceStop ? "This is the final allowed iteration, so set needsMoreEvidence=false, needsMoreAnalysis=false, nextQuestions=[]." : "",
      "",
      `Project: ${JSON.stringify(snapshot.project)}`,
      `Questions: ${JSON.stringify(snapshot.questions)}`,
      `Hypotheses: ${JSON.stringify(snapshot.hypotheses)}`,
      `Evidence: ${JSON.stringify(snapshot.evidence.slice(-18))}`,
      `Artifacts: ${JSON.stringify(snapshot.artifacts.slice(-8))}`,
      `RAG Context: ${JSON.stringify(snapshot.ragContexts.at(-1))}`,
      `Sources: ${JSON.stringify(snapshot.sources.slice(-12))}`,
      `Chunks: ${JSON.stringify(snapshot.chunks.slice(-12).map((chunk) => ({ id: chunk.id, sourceId: chunk.sourceId, text: chunk.text.slice(0, 500) })))}`,
      `OpenCode Runs: ${JSON.stringify(snapshot.openCodeRuns.map((run) => ({ iteration: run.iteration, logs: run.logs, toolPlan: run.toolPlan })))}`,
      `Tool Runs: ${JSON.stringify(snapshot.toolRuns.slice(-12))}`
    ].join("\n"),
    timeoutMs: 180_000
  });

  const createdAt = nowIso();
  const hypothesisUpdates = normalizeArray(response.hypothesisUpdates)
    .map((update) => {
      const hypothesis = snapshot.hypotheses[update.hypothesisIndex];
      return hypothesis
        ? {
            hypothesisId: hypothesis.id,
            status: normalizeStatus(update.status),
            confidence: clampConfidence(update.confidence),
            rationale: cleanText(update.rationale) || "LLM derived update without detailed rationale."
          }
        : undefined;
    })
    .filter((update): update is NonNullable<typeof update> => Boolean(update));

  return {
    id: createId("result"),
    projectId: snapshot.project.id,
    iteration,
    answer: cleanText(response.answer) || "LLM이 빈 답변을 반환했습니다. 확보된 근거와 RAG context를 기준으로 추가 검토가 필요합니다.",
    hypothesisUpdates,
    quantitativeResults: normalizeArray(response.quantitativeResults).map(cleanText).filter(Boolean),
    qualitativeResults: normalizeArray(response.qualitativeResults).map(cleanText).filter(Boolean),
    nextQuestions: forceStop ? [] : normalizeArray(response.nextQuestions).map(cleanText).filter(Boolean).slice(0, 5),
    needsMoreEvidence: forceStop ? false : Boolean(response.needsMoreEvidence),
    needsMoreAnalysis: forceStop ? false : Boolean(response.needsMoreAnalysis),
    createdAt
  };
}

function normalizeArray<T>(value: T[] | undefined | null): T[] {
  return Array.isArray(value) ? value : [];
}

function cleanText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function clampConfidence(value: unknown): number {
  const number = typeof value === "number" && Number.isFinite(value) ? value : 0.5;
  return Math.max(0, Math.min(1, number));
}

function normalizeCategory(value: unknown): EvidenceItem["category"] {
  const allowed: EvidenceItem["category"][] = [
    "generated_artifact",
    "paper_reference",
    "web_source",
    "experiment_log",
    "conversation_memo"
  ];
  return allowed.includes(value as EvidenceItem["category"]) ? (value as EvidenceItem["category"]) : "conversation_memo";
}

function normalizeStrength(value: unknown): EvidenceItem["evidenceStrength"] {
  return value === "medium" || value === "strong" || value === "weak" ? value : "weak";
}

function normalizeStatus(value: unknown): HypothesisStatus {
  const allowed: HypothesisStatus[] = ["untested", "supported", "rejected", "needs_more_evidence"];
  return allowed.includes(value as HypothesisStatus) ? (value as HypothesisStatus) : "needs_more_evidence";
}
