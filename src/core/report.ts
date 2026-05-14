import { createId, nowIso } from "./ids.js";
import type { ResearchReport, ResearchSnapshot } from "./types.js";

export function buildResearchReport(snapshot: ResearchSnapshot): ResearchReport {
  const latestResult = snapshot.results.at(-1);
  const supported = snapshot.hypotheses.filter((item) => item.status === "supported");
  const pending = snapshot.hypotheses.filter((item) => item.status !== "supported");

  return {
    id: createId("report"),
    projectId: snapshot.project.id,
    answer:
      latestResult?.answer ??
      `${snapshot.project.topic} 연구는 초기 루프를 완료했으며 추가 검증 결과를 기다리고 있습니다.`,
    hypothesisVerification: [
      `지원된 가설: ${supported.length}`,
      `추가 검증 필요: ${pending.length}`,
      ...snapshot.hypotheses.map((item) => `${item.statement} (${item.status}, ${item.confidence})`)
    ].join("\n"),
    quantitativeQualitativeResults:
      latestResult
        ? [...latestResult.quantitativeResults, ...latestResult.qualitativeResults].join("\n")
        : "정량/정성 결과가 아직 생성되지 않았습니다.",
    comprehensiveReport: [
      `연구 목표: ${snapshot.project.goal}`,
      `주제: ${snapshot.project.topic}`,
      `범위: ${snapshot.project.scope}`,
      `누적 근거: ${snapshot.evidence.length}개`,
      `산출물: ${snapshot.artifacts.length}개`,
      `OpenCode 실행: ${snapshot.openCodeRuns.length}회`
    ].join("\n"),
    reusableKnowledgeAsset: [
      "재사용 가능한 지식 자산:",
      ...snapshot.evidence.slice(-5).map((item) => `- ${item.title}: ${item.summary}`)
    ].join("\n"),
    createdAt: nowIso()
  };
}
