import { createId, nowIso } from "../shared/ids.js";
import type { EvidenceItem, ResearchReport, ResearchSnapshot, ValidationResult } from "../shared/types.js";

interface EngineeringPolarReport {
  airfoil: string;
  runtime: string;
  runtimeVersion?: string;
  runtimeLicense?: string;
  sourceUrl?: string;
  coordinateFormat?: string;
  reynolds?: number;
  mach?: number;
  alphaStart?: number;
  alphaEnd?: number;
  alphaStep?: number;
  rowCount: number;
  convergence?: Record<string, unknown>;
  rows: Array<{
    alpha: number;
    cl: number;
    cd: number;
    ld: number;
    cm?: number;
    cdp?: number;
    topXtr?: number;
  }>;
}

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
  const quantitative = quantitativeItems.length
    ? bulletLines(quantitativeItems)
    : "- 정량 결과가 아직 충분하지 않습니다.";
  const qualitative = qualitativeItems.length
    ? bulletLines(qualitativeItems)
    : "- 정성 결과가 아직 충분하지 않습니다.";
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
  markdownLines.push(
    "",
    "# 근거 요약"
  );
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
    "# 한계 및 근거 공백",
    limitations.length ? bulletLines(limitations) : "- 명시된 한계가 없습니다.",
    "",
    "# 추가 연구 질문",
    latestResult?.nextQuestions.length ? bulletLines(latestResult.nextQuestions) : "- 추가 연구 질문이 없습니다.",
    "",
    "# 계속 연구 판단",
    latestDecision ? `- 계속 연구 여부: ${latestDecision.shouldContinue ? "계속" : "최종 산출"}\n- 판단 근거: ${formatDecisionReason(latestDecision.reason)}` : "- 판단 기록이 없습니다.",
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

function collectEngineeringPolars(snapshot: ResearchSnapshot): EngineeringPolarReport[] {
  const polars: EngineeringPolarReport[] = [];
  for (const toolRun of snapshot.toolRuns) {
    if (toolRun.toolName !== "EngineeringProgramTool" || toolRun.status !== "completed") continue;
    const output = toolRun.output && typeof toolRun.output === "object" ? toolRun.output as Record<string, unknown> : undefined;
    const outputs = Array.isArray(output?.outputs) ? output.outputs : [];
    for (const item of outputs) {
      const record = item && typeof item === "object" ? item as Record<string, unknown> : undefined;
      if (!record) continue;
      const kind = typeof record?.kind === "string" ? record.kind : "";
      if (!kind.includes("polar")) continue;
      const summary = record.summary && typeof record.summary === "object" ? record.summary as Record<string, unknown> : undefined;
      const polar = summary ? engineeringPolarFromSummary(summary) : undefined;
      if (polar) polars.push(polar);
    }
  }
  return polars;
}

function engineeringPolarFromSummary(summary: Record<string, unknown>): EngineeringPolarReport | undefined {
  const rawRows = Array.isArray(summary.rows) ? summary.rows : [];
  const rows: EngineeringPolarReport["rows"] = [];
  for (const item of rawRows) {
    const row = item && typeof item === "object" ? item as Record<string, unknown> : undefined;
    const alpha = numberValue(row?.alpha);
    const cl = numberValue(row?.cl);
    const cd = numberValue(row?.cd);
    if (alpha === undefined || cl === undefined || cd === undefined || cd === 0) continue;
    rows.push({
      alpha,
      cl,
      cd,
      ld: cl / cd,
      cm: numberValue(row?.cm),
      cdp: numberValue(row?.cdp),
      topXtr: numberValue(row?.topXtr)
    });
  }
  if (!rows.length) return undefined;
  return {
    airfoil: stringValue(summary.airfoil) || "airfoil",
    runtime: stringValue(summary.runtime) || "engineering-runtime",
    runtimeVersion: stringValue(summary.runtimeVersion),
    runtimeLicense: stringValue(summary.runtimeLicense),
    sourceUrl: stringValue(summary.sourceUrl),
    coordinateFormat: stringValue(summary.coordinateFormat),
    reynolds: numberValue(summary.reynolds),
    mach: numberValue(summary.mach),
    alphaStart: numberValue(summary.alphaStart),
    alphaEnd: numberValue(summary.alphaEnd),
    alphaStep: numberValue(summary.alphaStep),
    rowCount: numberValue(summary.rowCount) ?? rows.length,
    convergence: summary.convergence && typeof summary.convergence === "object" ? summary.convergence as Record<string, unknown> : undefined,
    rows
  };
}

function formatEngineeringPolarSection(polars: EngineeringPolarReport[]): string {
  const lines: string[] = [];
  for (const polar of polars) {
    lines.push(
      `## ${polar.airfoil} (${polar.runtime}${polar.runtimeVersion ? ` ${polar.runtimeVersion}` : ""})`,
      `- 출처: ${polar.sourceUrl ?? "기록 없음"}`,
      `- 해석 조건: Re=${polar.reynolds ?? "n/a"}, Mach=${polar.mach ?? "n/a"}, alpha=${polar.alphaStart ?? polar.rows[0]?.alpha}..${polar.alphaEnd ?? polar.rows.at(-1)?.alpha}, step=${polar.alphaStep ?? "n/a"}`,
      `- 데이터 행: ${polar.rowCount}; 좌표 형식=${polar.coordinateFormat ?? "unknown"}; 라이선스=${polar.runtimeLicense ?? "unknown"}`,
      `- 수렴 정보: ${polar.convergence ? JSON.stringify(polar.convergence) : "기록 없음"}`,
      "",
      "|alpha|CL|CD|L/D|CM|CDp|topXtr|",
      "|---:|---:|---:|---:|---:|---:|---:|"
    );
    for (const row of polar.rows) {
      lines.push(`|${formatNumber(row.alpha, 2)}|${formatNumber(row.cl, 4)}|${formatNumber(row.cd, 5)}|${formatNumber(row.ld, 2)}|${formatOptionalNumber(row.cm, 4)}|${formatOptionalNumber(row.cdp, 5)}|${formatOptionalNumber(row.topXtr, 4)}|`);
    }
    lines.push("");
  }
  return lines.join("\n").trim();
}

function engineeringQuantitativeLines(polars: EngineeringPolarReport[]): string[] {
  const lines: string[] = [];
  for (const polar of polars) {
    const bestLd = maxBy(polar.rows, (row) => row.ld);
    const minCd = minBy(polar.rows, (row) => row.cd);
    const first = polar.rows[0];
    const last = polar.rows.at(-1);
    lines.push(`공력 polar: ${polar.airfoil}, ${polar.rowCount}개 행, 런타임=${polar.runtime}, Re=${polar.reynolds ?? "n/a"}, Mach=${polar.mach ?? "n/a"}`);
    if (first && last) lines.push(`CL 변화: alpha=${formatNumber(first.alpha, 2)}에서 ${formatNumber(first.cl, 4)}, alpha=${formatNumber(last.alpha, 2)}에서 ${formatNumber(last.cl, 4)}.`);
    if (minCd) lines.push(`계산 구간의 최소 CD: alpha=${formatNumber(minCd.alpha, 2)}에서 ${formatNumber(minCd.cd, 5)}.`);
    if (bestLd) lines.push(`계산 구간의 최대 L/D: alpha=${formatNumber(bestLd.alpha, 2)}에서 ${formatNumber(bestLd.ld, 2)}.`);
  }
  return lines;
}

function engineeringFinalAnswer(polars: EngineeringPolarReport[]): string | undefined {
  const polar = polars[0];
  if (!polar) return undefined;
  const first = polar.rows[0];
  const last = polar.rows.at(-1);
  const bestLd = maxBy(polar.rows, (row) => row.ld);
  const minCd = minBy(polar.rows, (row) => row.cd);
  return [
    `${polar.airfoil} 공력 해석은 ${polar.runtime}로 실제 실행되었고, ${polar.rowCount}개의 alpha 행이 저장되었습니다.`,
    `조건은 Re=${polar.reynolds ?? "n/a"}, Mach=${polar.mach ?? "n/a"}, alpha ${polar.alphaStart ?? first?.alpha}..${polar.alphaEnd ?? last?.alpha}, step=${polar.alphaStep ?? "n/a"}입니다.`,
    first && last ? `CL은 alpha ${formatNumber(first.alpha, 2)}에서 ${formatNumber(first.cl, 4)}, alpha ${formatNumber(last.alpha, 2)}에서 ${formatNumber(last.cl, 4)}로 증가했습니다.` : "",
    minCd ? `계산 구간의 최소 CD는 alpha ${formatNumber(minCd.alpha, 2)}에서 ${formatNumber(minCd.cd, 5)}입니다.` : "",
    bestLd ? `최대 L/D는 alpha ${formatNumber(bestLd.alpha, 2)}에서 ${formatNumber(bestLd.ld, 2)}입니다.` : "",
    "해석은 WebXFOIL/XFOIL 기반 2D airfoil polar이므로 고받음각 박리와 실제 풍동 stall 판단에는 한계가 있습니다."
  ].filter(Boolean).join(" ");
}

function filterQualitativeResults(values: string[], polars: EngineeringPolarReport[]): string[] {
  if (!polars.length) return values;
  return values.filter((value) => !/polar\s*(표|table|rows?)?.*(없|제공되지|not provided|not included)|원\s*polar\s*표|AoA.*(없|제공되지|not provided)|CL.*CD.*L\/D.*(없|제공되지|not provided|not included)/i.test(value));
}

function maxBy<T>(items: T[], score: (item: T) => number): T | undefined {
  let best: T | undefined;
  let bestScore = Number.NEGATIVE_INFINITY;
  for (const item of items) {
    const value = score(item);
    if (value > bestScore) {
      best = item;
      bestScore = value;
    }
  }
  return best;
}

function minBy<T>(items: T[], score: (item: T) => number): T | undefined {
  let best: T | undefined;
  let bestScore = Number.POSITIVE_INFINITY;
  for (const item of items) {
    const value = score(item);
    if (value < bestScore) {
      best = item;
      bestScore = value;
    }
  }
  return best;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function formatNumber(value: number, digits: number): string {
  return value.toFixed(digits).replace(/\.?0+$/, "");
}

function formatOptionalNumber(value: number | undefined, digits: number): string {
  return value === undefined ? "" : formatNumber(value, digits);
}

function appendEvidenceBlocks(lines: string[], evidence: EvidenceItem[]): void {
  if (!evidence.length) {
    lines.push("- 근거가 아직 없습니다.");
    return;
  }
  for (const [index, item] of evidence.entries()) {
    const source = item.citation || item.sourceUri || item.sourceId || "추적 가능한 출처 없음";
    const reliability = typeof item.reliabilityScore === "number" ? item.reliabilityScore.toFixed(2) : "n/a";
    const limitations = item.limitations?.length ? item.limitations.join("; ") : "명시된 한계 없음";
    lines.push(
      "",
      `### 근거 ${index + 1}. ${item.title}`,
      `- 분류: ${item.category}`,
      `- 출처: ${source}`,
      `- 신뢰도: ${reliability}`,
      `- 근거 강도: ${translateEvidenceStrength(item.evidenceStrength)}`,
      `- 한계: ${limitations}`
    );
  }
}

function formatHypothesisVerification(
  snapshot: ResearchSnapshot,
  validationsByHypothesisId: Map<string | undefined, ValidationResult[]>
): string {
  const rows: string[] = [];
  for (const hypothesis of snapshot.hypotheses) {
    const validations = validationsByHypothesisId.get(hypothesis.id);
    const validationText = validations?.length ? validationLines(validations) : "검증 전";
    rows.push(`- ${hypothesis.statement} | 상태: ${translateStatus(hypothesis.status)} | 신뢰도: ${hypothesis.confidence.toFixed(2)} | 검증: ${validationText}`);
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

const OPEN_CODE_OPTIMIZATION_PATTERN =
  /\b(optimi[sz]ation|optimisation|optimizer|objective function|design variable|pareto|candidate|best score)\b|최적화|최적|목적\s*함수|설계\s*변수/i;

function openCodeOptimizationQuantitativeLines(snapshot: ResearchSnapshot): string[] {
  const artifacts = collectOpenCodeOptimizationArtifacts(snapshot);
  const completedRuns = snapshot.openCodeRuns.filter((run) => run.status === "completed");
  if (!artifacts.length && !completedRuns.length) return [];
  const lines: string[] = [];
  if (completedRuns.length) lines.push(`OpenCode 완료 실행: ${completedRuns.length}건.`);
  if (artifacts.length) lines.push(`OpenCode 최적화 산출물: ${artifacts.length}개.`);
  return lines;
}

function formatOpenCodeOptimizationSection(snapshot: ResearchSnapshot): string {
  const lines: string[] = [];
  const runs = snapshot.openCodeRuns.filter((run) => run.status === "completed" || run.status === "failed");
  for (const run of runs.slice(-3)) {
    lines.push(
      `## OpenCode 실행 ${run.id}`,
      `- 상태: ${translateStatus(run.status)}`,
      `- 도구 계획: ${run.toolPlan.join(" / ") || "없음"}`,
      `- 시작 시각: ${run.startedAt}${run.completedAt ? `; 완료 시각: ${run.completedAt}` : ""}`
    );
    for (const log of run.logs.slice(0, 4)) lines.push(`- 실행 로그: ${log}`);
    lines.push("");
  }

  const artifacts = collectOpenCodeOptimizationArtifacts(snapshot);
  if (artifacts.length) {
    lines.push("## 최적화 산출물");
    for (const [index, artifact] of artifacts.slice(-8).entries()) {
      lines.push(
        "",
        `### 산출물 ${index + 1}. ${artifact.title}`,
        `- 경로: ${artifact.relativePath}`,
        `- 요약: ${artifact.summary || "요약 없음"}`,
        artifact.content ? `- 미리보기: ${excerpt(artifact.content, 220)}` : "- 미리보기: 본문 없음"
      );
    }
  }
  return lines.join("\n").trim();
}

function collectOpenCodeOptimizationArtifacts(snapshot: ResearchSnapshot): ResearchSnapshot["artifacts"] {
  const artifacts: ResearchSnapshot["artifacts"] = [];
  for (const artifact of snapshot.artifacts) {
    if (artifact.category !== "generated_artifact") continue;
    const searchable = [artifact.title, artifact.relativePath, artifact.summary, artifact.content ?? ""].join("\n");
    if (OPEN_CODE_OPTIMIZATION_PATTERN.test(searchable)) artifacts.push(artifact);
  }
  return artifacts;
}

function excerpt(value: string | undefined, limit: number): string {
  if (!value) return "";
  return value.length > limit ? `${value.slice(0, limit)}...` : value;
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

function formatValidation(result: ValidationResult): string {
  return `${translateStatus(result.status)} (${result.confidence.toFixed(2)})`;
}

function formatValidationBlock(result: ValidationResult): string {
  const lines = [
    `- ${result.hypothesisId ?? "project"}: ${translateStatus(result.status)} (${result.confidence.toFixed(2)})`,
    `  - 판단 근거: ${result.reasoningSummary}`
  ];
  if (result.evidenceGaps.length) lines.push(`  - 근거 공백: ${result.evidenceGaps.join("; ")}`);
  return lines.join("\n");
}

function translateStatus(status: string): string {
  switch (status) {
    case "completed":
      return "완료";
    case "failed":
      return "실패";
    case "running":
      return "실행 중";
    case "blocked":
      return "차단됨";
    case "supported":
      return "지지됨";
    case "contradicted":
      return "반박됨";
    case "inconclusive":
      return "불충분";
    case "open":
      return "열림";
    case "closed":
      return "닫힘";
    case "accepted":
      return "채택됨";
    case "rejected":
      return "기각됨";
    case "not_tested":
      return "검증 전";
    default:
      return status;
  }
}

function translateEvidenceStrength(strength: string | undefined): string {
  switch (strength) {
    case "strong":
      return "강함";
    case "medium":
      return "중간";
    case "weak":
    case undefined:
      return "약함";
    default:
      return strength;
  }
}

function formatDecisionReason(reason: string): string {
  if (/Internal loop safety cap reached/i.test(reason)) {
    return "내부 반복 안전 한도에 도달했으므로, 남은 한계를 명시한 상태에서 최종 산출물 작성을 진행했습니다.";
  }
  if (/More research is needed/i.test(reason)) {
    return reason.replace(/More research is needed\.?/i, "추가 연구가 필요합니다.");
  }
  return reason;
}

function appendToolRows(lines: string[], snapshot: ResearchSnapshot): void {
  if (!snapshot.toolRuns.length) {
    lines.push("- 사용한 도구 로그가 없습니다.");
    return;
  }
  for (const toolRun of snapshot.toolRuns) {
    lines.push(`- [${translateStatus(toolRun.status)}] ${toolRun.toolName}${toolRun.error ? `: ${toolRun.error}` : ""}`);
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

function collectLimitations(snapshot: ResearchSnapshot): string[] {
  const limitations = new Set<string>();
  let hasUncitedEvidence = false;
  for (const item of snapshot.evidence) {
    for (const limitation of item.limitations ?? []) limitations.add(limitation);
    if (!item.citation && !item.sourceUri && !item.sourceId) hasUncitedEvidence = true;
  }
  for (const result of snapshot.validationResults) {
    for (const limitation of result.limitations) limitations.add(limitation);
    for (const gap of result.evidenceGaps) limitations.add(`근거 공백: ${gap}`);
  }
  if (hasUncitedEvidence) {
    limitations.add("citation/sourceUri/sourceId가 없는 항목은 낮은 신뢰도로 처리했습니다.");
  }
  return [...limitations];
}
