import type { EvidenceItem, ResearchSnapshot } from "../../shared/types.js";

export function truncateText(value: string, limit: number): string {
  return value.length > limit ? `${value.slice(0, limit)}...` : value;
}

export function translateStatus(status: string): string {
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

export function translateEvidenceStrength(strength: string | undefined): string {
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

export function formatDecisionReason(reason: string): string {
  if (/Internal loop safety cap reached/i.test(reason)) {
    return "내부 반복 안전 한도에 도달했으므로, 남은 한계를 명시한 상태에서 최종 산출물 작성을 진행했습니다.";
  }
  if (/More research is needed/i.test(reason)) {
    return reason.replace(/More research is needed\.?/i, "추가 연구가 필요합니다.");
  }
  return reason;
}

export function appendToolRows(lines: string[], snapshot: ResearchSnapshot): void {
  if (!snapshot.toolRuns.length) {
    lines.push("- 사용한 도구 로그가 없습니다.");
    return;
  }
  for (const toolRun of snapshot.toolRuns) {
    lines.push(`- [${translateStatus(toolRun.status)}] ${toolRun.toolName}${toolRun.error ? `: ${toolRun.error}` : ""}`);
  }
}

export function appendReferences(lines: string[], snapshot: ResearchSnapshot): void {
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

export function appendRecentEvidence(lines: string[], evidence: EvidenceItem[], limit: number): void {
  const start = Math.max(0, evidence.length - limit);
  for (let index = start; index < evidence.length; index += 1) {
    const item = evidence[index];
    if (item) lines.push(`- ${item.title}: ${item.summary}`);
  }
}

export function appendRecentEntities(lines: string[], entities: ResearchSnapshot["ontologyEntities"], limit: number): void {
  const start = Math.max(0, entities.length - limit);
  for (let index = start; index < entities.length; index += 1) {
    const entity = entities[index];
    if (entity) lines.push(`- ${entity.type}: ${entity.label}`);
  }
}

export function collectLimitations(snapshot: ResearchSnapshot): string[] {
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
