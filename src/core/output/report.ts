import { createId, nowIso } from "../shared/ids.js";
import type { ResearchReport, ResearchSnapshot } from "../shared/types.js";
import {
  collectEngineeringPolars,
  engineeringFinalAnswer,
  engineeringQuantitativeLines,
  filterQualitativeResults,
  formatEngineeringPolarSection
} from "./report/engineeringReport.js";
import {
  appendEvidenceBlocks,
  buildReusableKnowledge,
  bulletLines,
  formatEvidenceScorecardBlock,
  formatHypothesisVerification,
  formatOpenCodeOptimizationSection,
  formatValidationBlock,
  groupValidationsByHypothesisId,
  openCodeOptimizationQuantitativeLines
} from "./report/reportSections.js";
import { appendReferences, appendToolRows, collectLimitations, formatDecisionReason } from "./report/reportLocalization.js";

export function buildResearchReport(snapshot: ResearchSnapshot): ResearchReport {
  const latestResult = snapshot.results.at(-1);
  const latestHybrid = snapshot.hybridContexts.at(-1);
  const latestDecision = snapshot.continuationDecisions.at(-1);
  const createdAt = nowIso();
  const validationsByHypothesisId = groupValidationsByHypothesisId(snapshot.validationResults);
  const hypothesisVerification = formatHypothesisVerification(snapshot, validationsByHypothesisId);
  const engineeringPolars = collectEngineeringPolars(snapshot);
  const engineeringSection = formatEngineeringPolarSection(engineeringPolars);
  const openCodeOptimizationSection = formatOpenCodeOptimizationSection(snapshot);
  const quantitativeItems = [
    ...engineeringQuantitativeLines(engineeringPolars),
    ...openCodeOptimizationQuantitativeLines(snapshot),
    ...(latestResult?.quantitativeResults ?? [])
  ];
  const qualitativeItems = filterQualitativeResults(latestResult?.qualitativeResults ?? [], engineeringPolars);
  const reportAnswer = engineeringFinalAnswer(engineeringPolars) ?? latestResult?.answer;
  const quantitative = quantitativeItems.length ? bulletLines(quantitativeItems) : "- 정량 결과가 아직 충분하지 않습니다.";
  const qualitative = qualitativeItems.length ? bulletLines(qualitativeItems) : "- 정성 결과가 아직 충분하지 않습니다.";
  const limitations = collectLimitations(snapshot);
  const reusableKnowledge = buildReusableKnowledge(snapshot);
  const markdownLines = [
    "# 연구 요약",
    "이 보고서는 AetherOps 자율 연구 루프가 수집한 실제 근거, 실행 산출물, 검증 결과를 기준으로 작성되었습니다.",
    "",
    "## 연구 목표",
    snapshot.project.goal,
    "",
    "# 연구 질문"
  ];
  for (let index = 0; index < snapshot.questions.length; index += 1) {
    markdownLines.push(`${index + 1}. ${snapshot.questions[index]?.text ?? ""}`);
  }
  markdownLines.push(
    "",
    "# 가설 및 검증 결과",
    hypothesisVerification || "- 가설이 없습니다.",
    "",
    "# 연구 방법",
    "- 연구 실행 결과를 출처, 산출물, 주장, 근거, 관찰, 인용 단위로 정규화했습니다.",
    "- 정규화된 데이터를 벡터 인덱스와 온톨로지 그래프에 병렬로 적재했습니다.",
    "- 하이브리드 검색 결과와 근거 원장을 사용해 가설을 평가했습니다.",
    "",
    "# 사용한 도구"
  );
  appendToolRows(markdownLines, snapshot);
  markdownLines.push("", "# 근거 요약");
  appendEvidenceBlocks(markdownLines, snapshot.evidence);
  markdownLines.push(
    "",
    "# 지식 그래프 요약",
    `- Entities: ${snapshot.ontologyEntities.length}`,
    `- Relations: ${snapshot.ontologyRelations.length}`,
    latestHybrid?.graphSummary ?? "- 그래프 요약이 없습니다.",
    "",
    "# 추론 및 검증 결과"
  );
  for (const validation of snapshot.validationResults) markdownLines.push(formatValidationBlock(validation));
  markdownLines.push(
    "",
    "# 공력 해석 결과",
    engineeringSection || "- EngineeringProgramTool의 polar 산출물이 아직 없습니다.",
    "",
    "# OpenCode 최적화 결과",
    openCodeOptimizationSection || "- OpenCode 최적화 산출물이 아직 없습니다."
  );
  markdownLines.push(
    "",
    "# 정량 결과",
    quantitative,
    "",
    "# 정성 결과",
    qualitative,
    "",
    "# 최종 답변",
    reportAnswer ?? "최종 답변을 만들 만큼 충분한 결과가 아직 없습니다.",
    "",
    "# Evidence Claim Scorecard",
    formatEvidenceScorecardBlock(latestResult?.evidenceScorecard) || "- Final result claim scorecard is not available.",
    "",
    "# 한계 및 근거 공백",
    limitations.length ? bulletLines(limitations) : "- 명시된 한계가 없습니다.",
    "",
    "# 추가 연구 질문",
    latestResult?.nextQuestions.length ? bulletLines(latestResult.nextQuestions) : "- 추가 연구 질문이 없습니다.",
    "",
    "# 계속 연구 판단",
    latestDecision
      ? `- 계속 연구 여부: ${latestDecision.shouldContinue ? "계속" : "최종 산출"}\n- 판단 근거: ${formatDecisionReason(latestDecision.reason)}`
      : "- 판단 기록이 없습니다.",
    "",
    "# 재사용 가능한 지식 자산",
    reusableKnowledge.replace("# 재사용 가능한 지식 자산\n\n", ""),
    "",
    "# 참고 자료 / 출처"
  );
  appendReferences(markdownLines, snapshot);
  const markdown = markdownLines.join("\n");

  return {
    id: createId("report"),
    projectId: snapshot.project.id,
    answer: reportAnswer ?? `${snapshot.project.topic} 연구는 완료되었지만 근거 수준은 제한적입니다.`,
    hypothesisVerification,
    quantitativeQualitativeResults: [quantitative, "", qualitative].join("\n"),
    comprehensiveReport: markdown,
    reusableKnowledgeAsset: reusableKnowledge,
    markdown,
    createdAt
  };
}
