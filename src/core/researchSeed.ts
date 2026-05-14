import { createId, nowIso } from "./ids.js";
import type {
  EvidenceItem,
  Hypothesis,
  ResearchProject,
  ResearchQuestion,
  ResearchSession
} from "./types.js";

export function createDefaultSessions(project: ResearchProject): ResearchSession[] {
  const createdAt = nowIso();
  return [
    {
      id: createId("session"),
      projectId: project.id,
      title: "질문/가설 세션",
      focus: `${project.topic}의 핵심 연구 질문과 검증 가능한 가설을 관리합니다.`,
      createdAt
    },
    {
      id: createId("session"),
      projectId: project.id,
      title: "근거/RAG 세션",
      focus: "논문, 웹 자료, 실행 로그, 산출물을 검색 가능한 근거로 정리합니다.",
      createdAt
    },
    {
      id: createId("session"),
      projectId: project.id,
      title: "실행/분석 세션",
      focus: "OpenCode를 통해 분석, 스크립트, 외부 도구 실행을 조율합니다.",
      createdAt
    }
  ];
}

export function seedResearchPlan(project: ResearchProject): {
  questions: ResearchQuestion[];
  hypotheses: Hypothesis[];
  evidence: EvidenceItem[];
} {
  const createdAt = nowIso();
  const primaryQuestion: ResearchQuestion = {
    id: createId("question"),
    projectId: project.id,
    text: `${project.goal}를 달성하기 위해 ${project.topic}에서 가장 먼저 검증해야 할 핵심 조건은 무엇인가?`,
    status: "open",
    createdAt
  };
  const validationQuestion: ResearchQuestion = {
    id: createId("question"),
    projectId: project.id,
    text: `${project.scope} 범위 안에서 재사용 가능한 연구 자산으로 남길 수 있는 결과물은 무엇인가?`,
    status: "open",
    createdAt
  };

  const hypotheses: Hypothesis[] = [
    {
      id: createId("hypothesis"),
      projectId: project.id,
      questionId: primaryQuestion.id,
      statement: "초기 자료 수집과 실행 로그를 결합하면 가설 검증에 필요한 최소 근거 세트를 만들 수 있다.",
      status: "untested",
      confidence: 0.35,
      createdAt
    },
    {
      id: createId("hypothesis"),
      projectId: project.id,
      questionId: validationQuestion.id,
      statement: "반복 루프의 산출물과 RAG 컨텍스트를 함께 저장하면 후속 연구에서 재사용 가능한 지식 자산이 된다.",
      status: "untested",
      confidence: 0.4,
      createdAt
    }
  ];

  const evidence: EvidenceItem[] = [
    {
      id: createId("evidence"),
      projectId: project.id,
      category: "conversation_memo",
      title: "초기 연구 목표",
      summary: project.goal,
      keywords: [project.topic, "goal", "initial-plan"],
      linkedHypothesisIds: hypotheses.map((item) => item.id),
      createdAt
    },
    {
      id: createId("evidence"),
      projectId: project.id,
      category: "experiment_log",
      title: "자율성 정책",
      summary: `도구 승인: ${project.autonomyPolicy.toolApproval}, 최대 반복: ${project.autonomyPolicy.maxLoopIterations}`,
      keywords: ["autonomy", "policy", "loop"],
      linkedHypothesisIds: [hypotheses[0].id],
      createdAt
    }
  ];

  return {
    questions: [primaryQuestion, validationQuestion],
    hypotheses,
    evidence
  };
}
