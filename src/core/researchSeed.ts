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
      title: "채팅 세션 1",
      focus: `${project.topic}에 대한 기본 연구 채팅 세션입니다.`,
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
  const questions: ResearchQuestion[] = [
    {
      id: createId("question"),
      projectId: project.id,
      text: `${project.topic}에서 최종 목표를 답하기 위해 가장 먼저 검증해야 할 핵심 비교 기준은 무엇인가?`,
      status: "open",
      createdAt
    },
    {
      id: createId("question"),
      projectId: project.id,
      text: `${project.scope} 범위 안에서 신뢰할 수 있는 공개 근거 또는 산출물은 어떤 형태로 확보할 수 있는가?`,
      status: "open",
      createdAt
    },
    {
      id: createId("question"),
      projectId: project.id,
      text: "근거가 부족한 경우 어떤 evidence_gap과 추가 연구 질문을 남겨야 과장 없는 결론을 만들 수 있는가?",
      status: "open",
      createdAt
    }
  ];

  const hypotheses: Hypothesis[] = [
    {
      id: createId("hypothesis"),
      projectId: project.id,
      questionId: questions[0].id,
      statement: "초기 자료 수집과 실행 로그를 결합하면 가설 검증에 필요한 최소 근거 세트를 식별할 수 있다.",
      status: "untested",
      confidence: 0.35,
      createdAt
    },
    {
      id: createId("hypothesis"),
      projectId: project.id,
      questionId: questions[1].id,
      statement: "반복 루프에서 산출물과 RAG context를 함께 저장하면 다음 연구에서 재사용 가능한 지식 자산을 만들 수 있다.",
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
      reliabilityScore: 0.4,
      relevanceScore: 0.8,
      evidenceStrength: "weak",
      limitations: ["사용자 입력 기반 seed evidence이며 외부 검증 근거가 아닙니다."],
      createdAt
    },
    {
      id: createId("evidence"),
      projectId: project.id,
      category: "experiment_log",
      title: "자율성 정책",
      summary: `도구 승인: ${project.autonomyPolicy.toolApproval}, 최대 반복: ${project.autonomyPolicy.maxLoopIterations}, 외부 검색: ${project.autonomyPolicy.allowExternalSearch}, 코드 실행: ${project.autonomyPolicy.allowCodeExecution}`,
      keywords: ["autonomy", "policy", "loop"],
      linkedHypothesisIds: [hypotheses[0].id],
      reliabilityScore: 0.6,
      relevanceScore: 0.65,
      evidenceStrength: "medium",
      limitations: ["정책 기록이며 연구 결론을 직접 지지하는 외부 근거는 아닙니다."],
      createdAt
    }
  ];

  return {
    questions,
    hypotheses,
    evidence
  };
}
