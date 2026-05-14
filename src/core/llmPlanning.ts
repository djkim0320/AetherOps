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
      "Return JSON with keys: questions, hypotheses, evidence.",
      "questions: array of { text }.",
      "hypotheses: array of { questionIndex, statement, confidence } using zero-based questionIndex.",
      "evidence: array of { category, title, summary, keywords, hypothesisIndexes }.",
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

  if (!questions.length) {
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
      keywords: normalizeArray(item.keywords).map(cleanText).filter(Boolean).slice(0, 8),
      linkedHypothesisIds: normalizeArray(item.hypothesisIndexes)
        .map((index) => hypotheses[index]?.id)
        .filter((id): id is string => Boolean(id)),
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
      "Return JSON with keys: answer, hypothesisUpdates, quantitativeResults, qualitativeResults, nextQuestions, needsMoreEvidence, needsMoreAnalysis.",
      "hypothesisUpdates uses zero-based hypothesisIndex and status among supported, rejected, needs_more_evidence, untested.",
      forceStop ? "This is the final allowed iteration, so set needsMoreEvidence=false, needsMoreAnalysis=false, nextQuestions=[]." : "",
      "",
      `Project: ${JSON.stringify(snapshot.project)}`,
      `Questions: ${JSON.stringify(snapshot.questions)}`,
      `Hypotheses: ${JSON.stringify(snapshot.hypotheses)}`,
      `Evidence: ${JSON.stringify(snapshot.evidence.slice(-12))}`,
      `Artifacts: ${JSON.stringify(snapshot.artifacts.slice(-8))}`,
      `RAG Context: ${JSON.stringify(snapshot.ragContexts.at(-1))}`,
      `OpenCode Runs: ${JSON.stringify(snapshot.openCodeRuns.map((run) => ({ iteration: run.iteration, logs: run.logs, toolPlan: run.toolPlan })))}`
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
            rationale: cleanText(update.rationale) || "LLM derived update."
          }
        : undefined;
    })
    .filter((update): update is NonNullable<typeof update> => Boolean(update));

  return {
    id: createId("result"),
    projectId: snapshot.project.id,
    iteration,
    answer: cleanText(response.answer) || "LLM이 결과를 생성했지만 요약 문장이 비어 있습니다.",
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

function normalizeStatus(value: unknown): HypothesisStatus {
  const allowed: HypothesisStatus[] = ["untested", "supported", "rejected", "needs_more_evidence"];
  return allowed.includes(value as HypothesisStatus) ? (value as HypothesisStatus) : "needs_more_evidence";
}
