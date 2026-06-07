import { createId, nowIso } from "./ids.js";
import type { EvidenceItem, ResearchReport, ResearchSnapshot, ValidationResult } from "./types.js";

export function buildResearchReport(snapshot: ResearchSnapshot): ResearchReport {
  const latestResult = snapshot.results.at(-1);
  const latestHybrid = snapshot.hybridContexts.at(-1);
  const latestDecision = snapshot.continuationDecisions.at(-1);
  const createdAt = nowIso();
  const validationsByHypothesisId = groupValidationsByHypothesisId(snapshot.validationResults);
  const hypothesisVerification = formatHypothesisVerification(snapshot, validationsByHypothesisId);
  const quantitative = latestResult?.quantitativeResults.length
    ? bulletLines(latestResult.quantitativeResults)
    : "- 정량 결과가 아직 충분하지 않습니다.";
  const qualitative = latestResult?.qualitativeResults.length
    ? bulletLines(latestResult.qualitativeResults)
    : "- 정성 결과가 아직 충분하지 않습니다.";
  const limitations = collectLimitations(snapshot);
  const reusableKnowledge = buildReusableKnowledge(snapshot);
  const markdownLines = [
    "# 연구 요약",
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
    "- 연구 실행 결과를 Source / Artifact / Claim / Evidence / Observation / Citation 단위로 정규화했습니다.",
    "- 정규화된 데이터를 Vector Index와 Ontology Graph에 병렬로 적재했습니다.",
    "- Hybrid Retrieval 결과와 Evidence Ledger를 사용해 가설을 평가했습니다.",
    "",
    "# 사용한 도구"
  );
  appendToolRows(markdownLines, snapshot);
  markdownLines.push(
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
    "# 추론 및 검증 결과"
  );
  for (const validation of snapshot.validationResults) markdownLines.push(formatValidationBlock(validation));
  markdownLines.push(
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
    limitations.length ? bulletLines(limitations) : "- 명시된 한계가 없습니다.",
    "",
    "# 추가 연구 질문",
    latestResult?.nextQuestions.length ? bulletLines(latestResult.nextQuestions) : "- 추가 연구 질문이 없습니다.",
    "",
    "# 계속 연구 판단",
    latestDecision ? `- shouldContinue: ${latestDecision.shouldContinue}\n- reason: ${latestDecision.reason}` : "- 판단 기록이 없습니다.",
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
    answer: latestResult?.answer ?? `${snapshot.project.topic} 연구는 완료되었지만 근거 수준은 제한적입니다.`,
    hypothesisVerification,
    quantitativeQualitativeResults: [quantitative, "", qualitative].join("\n"),
    comprehensiveReport: markdown,
    reusableKnowledgeAsset: reusableKnowledge,
    markdown,
    createdAt
  };
}

function evidenceRows(evidence: EvidenceItem[]): string {
  const rows: string[] = [];
  for (const item of evidence) rows.push(formatEvidenceRow(item));
  return rows.join("\n");
}

function formatHypothesisVerification(
  snapshot: ResearchSnapshot,
  validationsByHypothesisId: Map<string | undefined, ValidationResult[]>
): string {
  const rows: string[] = [];
  for (const hypothesis of snapshot.hypotheses) {
    const validations = validationsByHypothesisId.get(hypothesis.id);
    const validationText = validations?.length ? validationLines(validations) : "not_tested";
    rows.push(`- ${hypothesis.statement} | 상태: ${hypothesis.status} | 신뢰도: ${hypothesis.confidence.toFixed(2)} | 검증: ${validationText}`);
  }
  return rows.join("\n");
}

function validationLines(validations: ValidationResult[]): string {
  const lines: string[] = [];
  for (const validation of validations) lines.push(formatValidation(validation));
  return lines.join("; ");
}

function bulletLines(items: string[]): string {
  const rows: string[] = [];
  for (const item of items) rows.push(`- ${item}`);
  return rows.join("\n");
}

function buildReusableKnowledge(snapshot: ResearchSnapshot): string {
  const lines = [
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
    "## 재사용 가능한 근거"
  ];
  appendRecentEvidence(lines, snapshot.evidence, 12);
  lines.push("", "## 재사용 가능한 그래프 관찰");
  appendRecentEntities(lines, snapshot.ontologyEntities, 12);
  return lines.join("\n");
}

function groupValidationsByHypothesisId(validationResults: ValidationResult[]): Map<string | undefined, ValidationResult[]> {
  const grouped = new Map<string | undefined, ValidationResult[]>();
  for (const validation of validationResults) {
    const validations = grouped.get(validation.hypothesisId);
    if (validations) {
      validations.push(validation);
    } else {
      grouped.set(validation.hypothesisId, [validation]);
    }
  }
  return grouped;
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
  const lines = [
    `- ${result.hypothesisId ?? "project"}: ${result.status} (${result.confidence.toFixed(2)})`,
    `  - ${result.reasoningSummary}`
  ];
  if (result.evidenceGaps.length) lines.push(`  - gaps: ${result.evidenceGaps.join("; ")}`);
  return lines.join("\n");
}

function appendToolRows(lines: string[], snapshot: ResearchSnapshot): void {
  if (!snapshot.toolRuns.length) {
    lines.push("- 사용한 도구 로그가 없습니다.");
    return;
  }
  for (const toolRun of snapshot.toolRuns) {
    lines.push(`- [${toolRun.status}] ${toolRun.toolName}${toolRun.error ? `: ${toolRun.error}` : ""}`);
  }
}

function appendReferences(lines: string[], snapshot: ResearchSnapshot): void {
  const refs = new Set<string>();
  for (const item of snapshot.evidence) {
    const ref = item.citation || item.sourceUri || item.doi || item.sourceId;
    if (ref) refs.add(ref);
  }
  if (!refs.size) {
    lines.push("- 추적 가능한 외부 출처가 없습니다.");
    return;
  }
  for (const ref of refs) lines.push(`- ${ref}`);
}

function appendRecentEvidence(lines: string[], evidence: EvidenceItem[], limit: number): void {
  const start = Math.max(0, evidence.length - limit);
  for (let index = start; index < evidence.length; index += 1) {
    const item = evidence[index];
    if (item) lines.push(`- ${item.title}: ${item.summary}`);
  }
}

function appendRecentEntities(lines: string[], entities: ResearchSnapshot["ontologyEntities"], limit: number): void {
  const start = Math.max(0, entities.length - limit);
  for (let index = start; index < entities.length; index += 1) {
    const entity = entities[index];
    if (entity) lines.push(`- ${entity.type}: ${entity.label}`);
  }
}

function escapeCell(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\n/g, " ");
}

function collectLimitations(snapshot: ResearchSnapshot): string[] {
  const limitations = new Set<string>();
  let hasUncitedEvidence = false;
  for (const item of snapshot.evidence) {
    for (const limitation of item.limitations ?? []) limitations.add(limitation);
    if (!item.citation && !item.sourceUri && !item.sourceId) hasUncitedEvidence = true;
  }
  for (const result of snapshot.validationResults) {
    for (const limitation of result.limitations) limitations.add(limitation);
    for (const gap of result.evidenceGaps) limitations.add(`Evidence gap: ${gap}`);
  }
  if (hasUncitedEvidence) {
    limitations.add("citation/sourceUri/sourceId가 없는 항목은 낮은 신뢰도로 처리했습니다.");
  }
  return [...limitations];
}
