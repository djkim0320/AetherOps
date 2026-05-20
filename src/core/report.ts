import { createId, nowIso } from "./ids.js";
import type { EvidenceItem, ResearchReport, ResearchSnapshot, ValidationResult } from "./types.js";

export function buildResearchReport(snapshot: ResearchSnapshot): ResearchReport {
  const latestResult = snapshot.results.at(-1);
  const latestHybrid = snapshot.hybridContexts.at(-1);
  const latestDecision = snapshot.continuationDecisions.at(-1);
  const createdAt = nowIso();
  const hypothesisVerification = snapshot.hypotheses
    .map((hypothesis) => {
      const validations = snapshot.validationResults.filter((validation) => validation.hypothesisId === hypothesis.id);
      const validationText = validations.length ? validations.map(formatValidation).join("; ") : "not_tested";
      return `- ${hypothesis.statement} | 상태: ${hypothesis.status} | 신뢰도: ${hypothesis.confidence.toFixed(2)} | 검증: ${validationText}`;
    })
    .join("\n");
  const quantitative = latestResult?.quantitativeResults.length
    ? latestResult.quantitativeResults.map((item) => `- ${item}`).join("\n")
    : "- 정량 결과가 아직 충분하지 않습니다.";
  const qualitative = latestResult?.qualitativeResults.length
    ? latestResult.qualitativeResults.map((item) => `- ${item}`).join("\n")
    : "- 정성 결과가 아직 충분하지 않습니다.";
  const limitations = [
    ...new Set([
      ...snapshot.evidence.flatMap((item) => item.limitations ?? []),
      ...snapshot.validationResults.flatMap((item) => item.limitations),
      ...snapshot.validationResults.flatMap((item) => item.evidenceGaps.map((gap) => `Evidence gap: ${gap}`)),
      ...(snapshot.evidence.some((item) => !item.citation && !item.sourceUri && !item.sourceId)
        ? ["citation/sourceUri/sourceId가 없는 근거는 낮은 신뢰도로 처리했습니다."]
        : [])
    ])
  ];
  const reusableKnowledge = [
    "# 재사용 가능한 지식 자산",
    "",
    `- 프로젝트 주제: ${snapshot.project.topic}`,
    `- 연구 질문: ${snapshot.questions.length}`,
    `- 가설: ${snapshot.hypotheses.length}`,
    `- 근거: ${snapshot.evidence.length}`,
    `- 정규화 레코드: ${snapshot.normalizedRecords.length}`,
    `- Vector chunk: ${snapshot.chunks.length}`,
    `- Ontology entity/relation: ${snapshot.ontologyEntities.length}/${snapshot.ontologyRelations.length}`,
    "",
    "## 재사용 가능한 근거",
    ...snapshot.evidence.slice(-12).map((item) => `- ${item.title}: ${item.summary}`),
    "",
    "## 재사용 가능한 그래프 관찰",
    ...snapshot.ontologyEntities.slice(-12).map((entity) => `- ${entity.type}: ${entity.label}`)
  ].join("\n");
  const markdown = [
    "# 연구 요약",
    snapshot.project.goal,
    "",
    "# 연구 질문",
    ...snapshot.questions.map((item, index) => `${index + 1}. ${item.text}`),
    "",
    "# 가설 및 검증 결과",
    hypothesisVerification || "- 가설이 없습니다.",
    "",
    "# 연구 방법",
    "- 도구 실행 결과를 Source / Artifact / Claim / Evidence / Observation / Citation 단위로 정규화했습니다.",
    "- 정규화된 데이터를 Vector Index와 Ontology Graph에 병렬로 적재했습니다.",
    "- Hybrid Retrieval 결과와 Evidence Ledger를 사용해 가설을 평가했습니다.",
    "",
    "# 사용한 도구",
    ...toolRows(snapshot),
    "",
    "# 근거 요약표",
    "|분류|제목|출처|신뢰도|강도|한계|",
    "|---|---|---|---:|---|---|",
    evidenceRows(snapshot.evidence) || "|-|-|-|-|-|-|",
    "",
    "# 지식 그래프 요약",
    `- Entities: ${snapshot.ontologyEntities.length}`,
    `- Relations: ${snapshot.ontologyRelations.length}`,
    latestHybrid?.graphSummary ?? "- 그래프 요약이 없습니다.",
    "",
    "# 추론 및 검증 결과",
    ...snapshot.validationResults.map(formatValidationBlock),
    "",
    "# 정량 결과",
    quantitative,
    "",
    "# 정성 결과",
    qualitative,
    "",
    "# 최종 답변",
    latestResult?.answer ?? "최종 답변을 만들 만큼 충분한 결과가 아직 없습니다.",
    "",
    "# 한계 및 Evidence Gap",
    limitations.length ? limitations.map((item) => `- ${item}`).join("\n") : "- 명시된 한계가 없습니다.",
    "",
    "# 추가 연구 질문",
    latestResult?.nextQuestions.length ? latestResult.nextQuestions.map((item) => `- ${item}`).join("\n") : "- 추가 연구 질문이 없습니다.",
    "",
    "# 계속 연구 판단",
    latestDecision ? `- shouldContinue: ${latestDecision.shouldContinue}\n- reason: ${latestDecision.reason}` : "- 판단 기록이 없습니다.",
    "",
    "# 재사용 가능한 지식 자산",
    reusableKnowledge.replace("# 재사용 가능한 지식 자산\n\n", ""),
    "",
    "# 참고 자료 / 출처",
    ...references(snapshot)
  ].join("\n");

  return {
    id: createId("report"),
    projectId: snapshot.project.id,
    answer: latestResult?.answer ?? `${snapshot.project.topic} 연구는 완료되었지만 근거 수준이 제한적입니다.`,
    hypothesisVerification,
    quantitativeQualitativeResults: [quantitative, "", qualitative].join("\n"),
    comprehensiveReport: markdown,
    reusableKnowledgeAsset: reusableKnowledge,
    markdown,
    createdAt
  };
}

function evidenceRows(evidence: EvidenceItem[]): string {
  return evidence.map(formatEvidenceRow).join("\n");
}

function formatEvidenceRow(item: EvidenceItem): string {
  const source = item.citation || item.sourceUri || item.sourceId || "추적 가능한 출처 없음";
  const reliability = typeof item.reliabilityScore === "number" ? item.reliabilityScore.toFixed(2) : "n/a";
  const limitations = item.limitations?.join("; ") || "";
  return `|${item.category}|${escapeCell(item.title)}|${escapeCell(source)}|${reliability}|${item.evidenceStrength ?? "weak"}|${escapeCell(limitations)}|`;
}

function formatValidation(result: ValidationResult): string {
  return `${result.status} (${result.confidence.toFixed(2)})`;
}

function formatValidationBlock(result: ValidationResult): string {
  return [
    `- ${result.hypothesisId ?? "project"}: ${result.status} (${result.confidence.toFixed(2)})`,
    `  - ${result.reasoningSummary}`,
    result.evidenceGaps.length ? `  - gaps: ${result.evidenceGaps.join("; ")}` : ""
  ].filter(Boolean).join("\n");
}

function toolRows(snapshot: ResearchSnapshot): string[] {
  return snapshot.toolRuns.length
    ? snapshot.toolRuns.map((toolRun) => `- [${toolRun.status}] ${toolRun.toolName}${toolRun.error ? `: ${toolRun.error}` : ""}`)
    : ["- 사용한 도구 로그가 없습니다."];
}

function references(snapshot: ResearchSnapshot): string[] {
  const refs = snapshot.evidence
    .map((item) => item.citation || item.sourceUri || item.doi || item.sourceId)
    .filter((item): item is string => Boolean(item));
  return refs.length ? [...new Set(refs)].map((item) => `- ${item}`) : ["- 추적 가능한 외부 출처가 없습니다."];
}

function escapeCell(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\n/g, " ");
}
