import { createId, nowIso } from "./ids.js";
import type { LlmProvider } from "./llm.js";
import { seedResearchPlan } from "./researchSeed.js";
import type {
  EvidenceItem,
  Hypothesis,
  ResearchProject,
  ResearchQuestion,
  ResearchSpecification
} from "./types.js";

interface SpecificationLlmResponse {
  researchQuestions?: string[];
  refinedHypotheses?: string[];
  assumptions?: string[];
  constraints?: string[];
  successCriteria?: string[];
  requiredEvidenceTypes?: string[];
  competencyQuestions?: string[];
  evaluationMetrics?: string[];
}

export class ResearchSpecificationBuilder {
  constructor(private readonly llm?: LlmProvider) {}

  async build(input: {
    project: ResearchProject;
    questions: ResearchQuestion[];
    hypotheses: Hypothesis[];
    evidence: EvidenceItem[];
  }): Promise<ResearchSpecification> {
    const defaultSpecification = this.buildDefaultSpecification(input);
    if (!this.llm || !(await this.llm.isAvailable())) {
      return defaultSpecification;
    }

    try {
      const response = await this.llm.completeJson<SpecificationLlmResponse>({
        schemaName: "AetherOpsResearchSpecification",
        system: [
          "You create cautious, citation-aware research specifications.",
          "Do not invent facts, URLs, papers, DOI values, or real evidence.",
          "Seed evidence is only a planning signal; mark uncertainty as assumptions or constraints.",
          "Return only JSON."
        ].join("\n"),
        user: [
          `Project: ${JSON.stringify(input.project)}`,
          `Current questions: ${JSON.stringify(input.questions)}`,
          `Current hypotheses: ${JSON.stringify(input.hypotheses)}`,
          `Seed evidence: ${JSON.stringify(input.evidence.map((item) => ({
            title: item.title,
            summary: item.summary,
            citation: item.citation,
            sourceUri: item.sourceUri,
            limitations: item.limitations
          })))}`,
          "Return keys: researchQuestions, refinedHypotheses, assumptions, constraints, successCriteria, requiredEvidenceTypes, competencyQuestions, evaluationMetrics."
        ].join("\n\n"),
        timeoutMs: 120_000
      });

      return {
        ...defaultSpecification,
        researchQuestions: take(response.researchQuestions, defaultSpecification.researchQuestions, 5, 3),
        refinedHypotheses: take(response.refinedHypotheses, defaultSpecification.refinedHypotheses, 5, 2),
        assumptions: take(response.assumptions, defaultSpecification.assumptions, 8, 1),
        constraints: take(response.constraints, defaultSpecification.constraints, 8, 1),
        successCriteria: take(response.successCriteria, defaultSpecification.successCriteria, 8, 2),
        requiredEvidenceTypes: take(response.requiredEvidenceTypes, defaultSpecification.requiredEvidenceTypes, 8, 2),
        competencyQuestions: take(response.competencyQuestions, defaultSpecification.competencyQuestions, 8, 2),
        evaluationMetrics: take(response.evaluationMetrics, defaultSpecification.evaluationMetrics, 8, 2)
      };
    } catch {
      return defaultSpecification;
    }
  }

  private buildDefaultSpecification(input: {
    project: ResearchProject;
    questions: ResearchQuestion[];
    hypotheses: Hypothesis[];
    evidence: EvidenceItem[];
  }): ResearchSpecification {
    const seeded = input.questions.length && input.hypotheses.length ? undefined : seedResearchPlan(input.project);
    const questions = input.questions.length ? input.questions : seeded?.questions ?? [];
    const hypotheses = input.hypotheses.length ? input.hypotheses : seeded?.hypotheses ?? [];
    const evidenceGaps = input.evidence.filter((item) => item.keywords.includes("evidence_gap") || item.keywords.includes("tool_unavailable"));

    return {
      id: createId("spec"),
      projectId: input.project.id,
      researchQuestions: ensureMinimum(
        questions.map((item) => item.text),
        [
          `${input.project.topic}에서 핵심 비교 기준 또는 검증 기준은 무엇인가?`,
          `${input.project.scope} 범위에서 추적 가능한 근거는 무엇인가?`,
          `근거가 부족할 때 어떤 추가 연구 계획으로 보완할 수 있는가?`
        ],
        3
      ).slice(0, 5),
      initialHypotheses: hypotheses.map((item) => item.statement),
      refinedHypotheses: ensureMinimum(
        hypotheses.map((item) => item.statement),
        [
          `${input.project.topic}의 주요 가설은 현재 근거 장부와 도구 실행 결과로 부분 검증할 수 있다.`,
          `출처가 없는 seed evidence는 실제 결론 근거가 아니라 연구 계획 보조 자료로만 사용해야 한다.`
        ],
        2
      ).slice(0, 5),
      scope: input.project.scope,
      assumptions: [
        "현재 프로젝트 입력은 연구 설계의 출발점이며 외부 출처를 대체하지 않는다.",
        evidenceGaps.length ? "일부 도구 또는 외부 검색이 사용 불가능할 수 있다." : "수집된 자료는 citation/sourceUri로 추적 가능해야 한다."
      ],
      constraints: [input.project.budget, `maxLoopIterations=${input.project.autonomyPolicy.maxLoopIterations}`].filter(Boolean),
      successCriteria: [
        "질문별로 추적 가능한 evidence/citation을 연결한다.",
        "가설별 supported/contradicted/inconclusive 판단과 한계를 기록한다.",
        "최종 보고서와 재사용 가능한 지식 자산을 파일로 생성한다."
      ],
      requiredEvidenceTypes: ["raw source", "artifact", "tool log", "citation", "observation"],
      competencyQuestions: [
        "어떤 evidence가 어떤 hypothesis를 지지하거나 반박하는가?",
        "citation이 없는 claim은 어느 정도의 낮은 신뢰도로 처리하는가?",
        "다음 iteration에서 보완해야 할 evidence gap은 무엇인가?"
      ],
      evaluationMetrics: ["citation coverage", "evidence reliability", "hypothesis confidence", "artifact completeness"],
      createdAt: nowIso()
    };
  }
}

function take(value: unknown, defaultValue: string[], max: number, min: number): string[] {
  return ensureMinimum(
    Array.isArray(value) ? value.map((item) => (typeof item === "string" ? item.trim() : "")).filter(Boolean) : [],
    defaultValue,
    min
  ).slice(0, max);
}

function ensureMinimum(value: string[], defaultValue: string[], min: number): string[] {
  const merged = [...value, ...defaultValue].filter(Boolean);
  return [...new Set(merged)].slice(0, Math.max(min, merged.length));
}
