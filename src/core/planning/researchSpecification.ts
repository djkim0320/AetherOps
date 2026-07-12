import { createId, nowIso } from "../shared/ids.js";
import type { EvidenceItem, Hypothesis, ResearchProject, ResearchQuestion, ResearchSpecification } from "../shared/types.js";

export class ResearchSpecificationBuilder {
  build(input: { project: ResearchProject; questions: ResearchQuestion[]; hypotheses: Hypothesis[]; evidence: EvidenceItem[] }): ResearchSpecification {
    return this.buildSpecification(input);
  }

  private buildSpecification(input: {
    project: ResearchProject;
    questions: ResearchQuestion[];
    hypotheses: Hypothesis[];
    evidence: EvidenceItem[];
  }): ResearchSpecification {
    const hasErrorSignals = hasErrorEvidenceSignal(input.evidence);
    const hypothesisStatements = collectHypothesisStatements(input.hypotheses);

    return {
      id: createId("spec"),
      projectId: input.project.id,
      researchQuestions: collectLimited(
        ensureMinimum(
          collectQuestionTexts(input.questions),
          [
            `${input.project.topic}에서 검증해야 할 핵심 질문은 무엇인가?`,
            `${input.project.scope} 범위에서 추적 가능한 근거는 무엇인가?`,
            "근거가 부족할 때 다음 연구 계획에서 무엇을 보완해야 하는가?"
          ],
          3
        ),
        5
      ),
      initialHypotheses: hypothesisStatements,
      refinedHypotheses: collectLimited(
        ensureMinimum(
          hypothesisStatements,
          [
            `${input.project.topic}의 주요 가설은 citation이 있는 근거로만 검증 가능하다.`,
            "출처가 없는 주장은 결론 근거가 아니라 검증 대상 또는 한계로 분리해야 한다."
          ],
          2
        ),
        5
      ),
      scope: input.project.scope,
      assumptions: [
        "현재 프로젝트 입력은 연구 명세의 출발점이며 외부 출처를 대체하지 않는다.",
        hasErrorSignals ? "일부 도구 또는 런타임 요구사항이 충족되지 않을 수 있다." : "수집 자료는 citation/sourceUri로 추적 가능해야 한다."
      ],
      constraints: compactStrings([input.project.budget, "루프 반복 여부는 11단계 계속 연구 판단이 근거 공백과 분석 필요성을 보고 자율 결정한다."]),
      successCriteria: [
        "질문별로 추적 가능한 evidence/citation을 연결한다.",
        "가설별 supported/contradicted/inconclusive 판단과 한계를 기록한다.",
        "최종 보고서와 재사용 가능한 지식 자산을 파일로 생성한다."
      ],
      requiredEvidenceTypes: ["raw source", "artifact", "tool log", "citation", "observation"],
      competencyQuestions: [
        "어떤 evidence가 어떤 hypothesis를 지지하거나 반박하는가?",
        "citation이 없는 claim은 어떤 신뢰도로 처리해야 하는가?",
        "다음 iteration에서 보완해야 할 근거 공백은 무엇인가?"
      ],
      evaluationMetrics: ["citation coverage", "evidence reliability", "hypothesis confidence", "artifact completeness"],
      createdAt: nowIso()
    };
  }
}

function ensureMinimum(value: string[], defaultValue: string[], min: number): string[] {
  const output: string[] = [];
  const seen = new Set<string>();
  for (const item of value) pushUniqueString(output, seen, item);
  for (const item of defaultValue) pushUniqueString(output, seen, item);
  return collectLimited(output, Math.max(min, output.length));
}

function hasErrorEvidenceSignal(evidence: EvidenceItem[]): boolean {
  for (const item of evidence) {
    if (item.keywords.includes("error") || item.keywords.includes("tool_unavailable")) return true;
  }
  return false;
}

function collectQuestionTexts(questions: ResearchQuestion[]): string[] {
  const texts: string[] = [];
  for (const question of questions) texts.push(question.text);
  return texts;
}

function collectHypothesisStatements(hypotheses: Hypothesis[]): string[] {
  const statements: string[] = [];
  for (const hypothesis of hypotheses) statements.push(hypothesis.statement);
  return statements;
}

function compactStrings(values: string[]): string[] {
  const output: string[] = [];
  for (const value of values) {
    if (value) output.push(value);
  }
  return output;
}

function collectLimited(values: string[], limit: number): string[] {
  const output: string[] = [];
  const count = Math.min(values.length, limit);
  for (let index = 0; index < count; index += 1) {
    output.push(values[index]);
  }
  return output;
}

function pushUniqueString(output: string[], seen: Set<string>, value: string | undefined): void {
  if (!value || seen.has(value)) return;
  seen.add(value);
  output.push(value);
}
