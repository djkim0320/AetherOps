import { createId, nowIso } from "./ids.js";
import type { Hypothesis, ResearchInput, ResearchProject, ResearchQuestion } from "./types.js";

export interface ResearchInputPayload {
  researchQuestion?: string;
  initialHypotheses?: string[];
  constraints?: string[];
  expectedOutputs?: string[];
}

export function createResearchInput(project: ResearchProject, payload: ResearchInputPayload): {
  input: ResearchInput;
  questions: ResearchQuestion[];
  hypotheses: Hypothesis[];
} {
  const researchQuestion = clean(payload.researchQuestion);
  const initialHypotheses = cleanArray(payload.initialHypotheses);
  if (!researchQuestion) {
    throw new Error("연구 질문을 입력해야 합니다.");
  }
  if (!initialHypotheses.length) {
    throw new Error("초기 가설을 1개 이상 입력해야 합니다.");
  }

  const createdAt = nowIso();
  const input: ResearchInput = {
    id: createId("input"),
    projectId: project.id,
    researchQuestion,
    initialHypotheses,
    constraints: cleanArray(payload.constraints),
    expectedOutputs: cleanArray(payload.expectedOutputs),
    createdAt
  };
  const question: ResearchQuestion = {
    id: createId("question"),
    projectId: project.id,
    text: researchQuestion,
    status: "open",
    createdAt
  };
  const hypotheses = initialHypotheses.map((statement) => ({
    id: createId("hypothesis"),
    projectId: project.id,
    questionId: question.id,
    statement,
    status: "untested" as const,
    confidence: 0.2,
    createdAt
  }));

  return { input, questions: [question], hypotheses };
}

function clean(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function cleanArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map(clean).filter(Boolean) : [];
}
