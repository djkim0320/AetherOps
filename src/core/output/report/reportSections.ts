import type { EvidenceItem, EvidenceScorecard, ResearchSnapshot, ValidationResult } from "../../shared/types.js";
import { appendRecentEntities, appendRecentEvidence, translateEvidenceStrength, translateStatus, truncateText } from "./reportLocalization.js";

export function appendEvidenceBlocks(lines: string[], evidence: EvidenceItem[]): void {
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

export function formatHypothesisVerification(snapshot: ResearchSnapshot, validationsByHypothesisId: Map<string | undefined, ValidationResult[]>): string {
  const rows: string[] = [];
  for (const hypothesis of snapshot.hypotheses) {
    const validations = validationsByHypothesisId.get(hypothesis.id);
    const validationText = validations?.length ? validationLines(validations) : "검증 전";
    rows.push(
      `- ${hypothesis.statement} | 상태: ${translateStatus(hypothesis.status)} | 신뢰도: ${hypothesis.confidence.toFixed(2)} | 검증: ${validationText}`
    );
  }
  return rows.join("\n");
}

export function validationLines(validations: ValidationResult[]): string {
  const lines: string[] = [];
  for (const validation of validations) lines.push(formatValidation(validation));
  return lines.join("; ");
}

export function bulletLines(items: string[]): string {
  const rows: string[] = [];
  for (const item of items) rows.push(`- ${item}`);
  return rows.join("\n");
}

export function buildReusableKnowledge(snapshot: ResearchSnapshot): string {
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

export function workspaceExecutionQuantitativeLines(snapshot: ResearchSnapshot): string[] {
  const artifacts = collectWorkspaceOptimizationArtifacts(snapshot);
  const completedRuns = snapshot.toolRuns.filter((run) => run.toolName === "CodexCliTool" && run.status === "completed");
  const legacyCompletedRuns = snapshot.legacyAgentRuns.filter((run) => run.status === "completed");
  if (!artifacts.length && !completedRuns.length && !legacyCompletedRuns.length) return [];
  const lines: string[] = [];
  if (completedRuns.length) lines.push(`Codex CLI completed workspace runs: ${completedRuns.length}.`);
  if (legacyCompletedRuns.length) lines.push(`Archived legacy executor runs: ${legacyCompletedRuns.length}.`);
  if (artifacts.length) lines.push(`Workspace optimization artifacts: ${artifacts.length}.`);
  return lines;
}

export function formatWorkspaceExecutionSection(snapshot: ResearchSnapshot): string {
  const lines: string[] = [];
  const codexRuns = snapshot.toolRuns.filter((run) => run.toolName === "CodexCliTool" && (run.status === "completed" || run.status === "failed"));
  for (const run of codexRuns.slice(-3)) {
    lines.push(
      `## Codex CLI run ${run.id}`,
      `- Status: ${translateStatus(run.status)}`,
      `- Started: ${run.startedAt}${run.completedAt ? `; completed: ${run.completedAt}` : ""}`
    );
    if (run.error) lines.push(`- Terminal cause: ${run.error}`);
    lines.push("");
  }

  const legacyRuns = snapshot.legacyAgentRuns.filter((run) => run.status === "completed" || run.status === "failed");
  for (const run of legacyRuns.slice(-3)) {
    lines.push(
      `## Archived legacy executor run ${run.id}`,
      `- Status: ${translateStatus(run.status)}`,
      `- Historical tool plan: ${run.toolPlan.join(" / ") || "none"}`,
      `- Started: ${run.startedAt}${run.completedAt ? `; completed: ${run.completedAt}` : ""}`
    );
    lines.push("");
  }

  const artifacts = collectWorkspaceOptimizationArtifacts(snapshot);
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

export function collectWorkspaceOptimizationArtifacts(snapshot: ResearchSnapshot): ResearchSnapshot["artifacts"] {
  const artifacts: ResearchSnapshot["artifacts"] = [];
  for (const artifact of snapshot.artifacts) {
    if (artifact.category !== "generated_artifact") continue;
    const searchable = [artifact.title, artifact.relativePath, artifact.summary, artifact.content ?? ""].join("\n");
    if (OPEN_CODE_OPTIMIZATION_PATTERN.test(searchable)) artifacts.push(artifact);
  }
  return artifacts;
}

export function excerpt(value: string | undefined, limit: number): string {
  if (!value) return "";
  return value.length > limit ? `${value.slice(0, limit)}...` : value;
}

export function groupValidationsByHypothesisId(validationResults: ValidationResult[]): Map<string | undefined, ValidationResult[]> {
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

export function formatValidation(result: ValidationResult): string {
  return `${translateStatus(result.status)} (${result.confidence.toFixed(2)})`;
}

export function formatValidationBlock(result: ValidationResult): string {
  const lines = [
    `- ${result.hypothesisId ?? "project"}: ${translateStatus(result.status)} (${result.confidence.toFixed(2)})`,
    `  - 판단 근거: ${result.reasoningSummary}`
  ];
  for (const claim of result.claimScorecard?.claims ?? []) {
    lines.push(
      `  - Claim score: ${claim.status}; correctness=${claim.correctness.status}; citation=${claim.citationFaithfulness.status}; claim=${truncateText(claim.claim, 140)}`
    );
  }
  if (result.evidenceGaps.length) lines.push(`  - 근거 공백: ${result.evidenceGaps.join("; ")}`);
  return lines.join("\n");
}

export function formatEvidenceScorecardBlock(scorecard: EvidenceScorecard | undefined): string {
  if (!scorecard?.claims.length) return "";
  const lines = [
    `- Claims: ${scorecard.claimCount}; supported=${scorecard.statusCounts.supported}, missing_evidence=${scorecard.statusCounts.missing_evidence}, contradicted=${scorecard.statusCounts.contradicted}, attribution_unfaithful=${scorecard.statusCounts.attribution_unfaithful}, unknown=${scorecard.statusCounts.unknown}`
  ];
  for (const claim of scorecard.claims) {
    const evidenceIds = uniqueStrings([...claim.correctness.supportingEvidenceIds, ...claim.correctness.contradictingEvidenceIds]);
    lines.push(
      `- Final claim score: ${claim.status}; correctness=${claim.correctness.status}; citation=${claim.citationFaithfulness.status}; claim=${truncateText(claim.claim, 160)}`
    );
    if (evidenceIds.length) lines.push(`  - Evidence: ${evidenceIds.join(", ")}`);
    if (claim.evidenceGaps.length) lines.push(`  - Evidence gaps: ${claim.evidenceGaps.join("; ")}`);
  }
  return lines.join("\n");
}

export function uniqueStrings(items: string[]): string[] {
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const item of items) {
    if (!item || seen.has(item)) continue;
    seen.add(item);
    unique.push(item);
  }
  return unique;
}
