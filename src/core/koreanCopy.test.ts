import { describe, expect, it } from "vitest";
import { buildResearchReport } from "./report.js";
import { createDefaultSessions, seedResearchPlan } from "./researchSeed.js";
import { ResearchLoopStep, type ResearchProject, type ResearchSnapshot } from "./types.js";

const forbiddenMojibake = /(?:�|[?]{3,}|梨|꾪|똿|몄|뀡|곌|붿|빟|媛|寃|利|吏|㏃)/;

describe("Korean user-facing copy", () => {
  it("keeps default sessions and seed research records readable", () => {
    const sessions = createDefaultSessions(project);
    const seed = seedResearchPlan(project);
    const text = JSON.stringify({ sessions, seed });

    expect(sessions[0]?.title).toBe("채팅 세션 1");
    expect(seed.questions[0]?.text).toContain("핵심 질문");
    expect(seed.evidence[0]?.limitations?.[0]).toContain("외부 검증 근거가 아닙니다");
    expect(text).not.toMatch(forbiddenMojibake);
  });

  it("keeps generated report headings and error copy readable", () => {
    const report = buildResearchReport(snapshot);

    expect(report.comprehensiveReport).toContain("# 연구 요약");
    expect(report.comprehensiveReport).toContain("# 가설 및 검증 결과");
    expect(report.comprehensiveReport).toContain("# 재사용 가능한 지식 자산");
    expect(report.reusableKnowledgeAsset).toContain("프로젝트 주제");
    expect(report.comprehensiveReport).not.toMatch(forbiddenMojibake);
    expect(report.reusableKnowledgeAsset).not.toMatch(forbiddenMojibake);
  });
});

const project: ResearchProject = {
  id: "project-korean-copy",
  goal: "대학생의 2시간 공부 세션에서 집중 유지와 피로도를 비교한다.",
  topic: "대학생 공부 방식 비교",
  scope: "공개 근거와 미니 실험 설계",
  budget: "짧은 연구",
  autonomyPolicy: {
    toolApproval: "suggested",
    allowExternalSearch: false,
    allowCodeExecution: false
  },
  createdAt: "2026-05-20T00:00:00.000Z",
  updatedAt: "2026-05-20T00:00:00.000Z",
  currentStep: ResearchLoopStep.CreateResearchDb,
  status: "idle",
  projectRoot: ".aetherops/projects/korean-copy"
};

const seed = seedResearchPlan(project);
const snapshot: ResearchSnapshot = {
  project,
  sessions: createDefaultSessions(project),
  questions: seed.questions,
  hypotheses: seed.hypotheses,
  evidence: seed.evidence,
  researchInputs: [],
  artifacts: [],
  sources: [],
  chunks: [],
  toolRuns: [],
  agentPlans: [],
  researchPlans: [],
  specifications: [],
  normalizedRecords: [],
  ontologyEntities: [],
  ontologyRelations: [],
  ontologyConstraints: [],
  projectContextSnapshots: [],
  hybridContexts: [],
  validationResults: [],
  continuationDecisions: [],
  finalOutputs: [],
  runAuditOutputs: [],
  benchmarkPlans: [],
  runtimeBlockers: [],
  stepErrors: [],
  openCodeRuns: [],
  ragContexts: [],
  results: [],
  iterations: []
};
