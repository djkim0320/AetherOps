import { createId, nowIso } from "./ids.js";
import type { EvidenceItem, ResearchReport, ResearchSnapshot } from "./types.js";

export function buildResearchReport(snapshot: ResearchSnapshot): ResearchReport {
  const latestResult = snapshot.results.at(-1);
  const createdAt = nowIso();
  const evidenceRows = snapshot.evidence.map(formatEvidenceRow).join("\n");
  const hypothesisVerification = snapshot.hypotheses
    .map((item) => `- ${item.statement} | 상태: ${item.status} | 신뢰도: ${item.confidence.toFixed(2)}`)
    .join("\n");
  const quantitative = latestResult?.quantitativeResults.length
    ? latestResult.quantitativeResults.map((item) => `- ${item}`).join("\n")
    : "- 정량 결과가 아직 충분하지 않습니다.";
  const qualitative = latestResult?.qualitativeResults.length
    ? latestResult.qualitativeResults.map((item) => `- ${item}`).join("\n")
    : "- 정성 결과가 아직 충분하지 않습니다.";
  const limitations = [
    ...new Set(snapshot.evidence.flatMap((item) => item.limitations ?? [])),
    ...(snapshot.evidence.some((item) => !item.citation && !item.sourceUri) ? ["citation/sourceUri가 없는 근거는 낮은 신뢰도로 처리했습니다."] : [])
  ];
  const reusableKnowledge = [
    "# 재사용 가능한 지식 자산",
    "",
    `- 프로젝트 주제: ${snapshot.project.topic}`,
    `- 검증 질문 수: ${snapshot.questions.length}`,
    `- 가설 수: ${snapshot.hypotheses.length}`,
    `- 근거 수: ${snapshot.evidence.length}`,
    `- RAG chunk 수: ${snapshot.chunks.length}`,
    "",
    "## 재사용 가능한 근거",
    ...snapshot.evidence.slice(-10).map((item) => `- ${item.title}: ${item.summary}`)
  ].join("\n");
  const markdown = [
    "# 연구 요약",
    snapshot.project.goal,
    "",
    "# 핵심 질문",
    ...snapshot.questions.map((item, index) => `${index + 1}. ${item.text}`),
    "",
    "# 가설 및 검증 결과",
    hypothesisVerification || "- 가설이 없습니다.",
    "",
    "# 근거 요약표",
    "|분류|제목|출처|신뢰도|강도|한계|",
    "|---|---|---|---:|---|---|",
    evidenceRows || "|-|-|-|-|-|-|",
    "",
    "# 정량 결과",
    quantitative,
    "",
    "# 정성 결과",
    qualitative,
    "",
    "# 최종 답변",
    latestResult?.answer ?? "최종 답변을 생성할 충분한 결과가 아직 없습니다.",
    "",
    "# 한계",
    limitations.length ? limitations.map((item) => `- ${item}`).join("\n") : "- 명시된 한계가 없습니다.",
    "",
    "# 추가 연구 질문",
    latestResult?.nextQuestions.length ? latestResult.nextQuestions.map((item) => `- ${item}`).join("\n") : "- 추가 연구 질문이 없습니다.",
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
    answer: latestResult?.answer ?? `${snapshot.project.topic} 연구 루프가 완료되었지만 최종 답변 근거가 제한적입니다.`,
    hypothesisVerification,
    quantitativeQualitativeResults: [quantitative, "", qualitative].join("\n"),
    comprehensiveReport: markdown,
    reusableKnowledgeAsset: reusableKnowledge,
    markdown,
    createdAt
  };
}

function formatEvidenceRow(item: EvidenceItem): string {
  const source = item.citation || item.sourceUri || item.sourceId || "추적 가능한 출처 없음";
  const reliability = typeof item.reliabilityScore === "number" ? item.reliabilityScore.toFixed(2) : "n/a";
  const limitations = item.limitations?.join("; ") || "";
  return `|${item.category}|${escapeCell(item.title)}|${escapeCell(source)}|${reliability}|${item.evidenceStrength ?? "weak"}|${escapeCell(limitations)}|`;
}

function references(snapshot: ResearchSnapshot): string[] {
  const refs = snapshot.evidence
    .map((item) => item.citation || item.sourceUri || item.doi)
    .filter((item): item is string => Boolean(item));
  return refs.length ? [...new Set(refs)].map((item) => `- ${item}`) : ["- 추적 가능한 외부 출처가 없습니다."];
}

function escapeCell(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\n/g, " ");
}
