import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildResearchReport } from "../output/report.js";
import { createDefaultSessions, seedResearchPlan } from "../input/researchSeed.js";
import { ResearchLoopStep, type ResearchProject, type ResearchSnapshot } from "../shared/types.js";

const forbiddenMojibake = new RegExp(
  [
    "\\uFFFD",
    "[?]{3,}",
    "[\\uF900-\\uFAFF]",
    "[\\u0080-\\u009F]",
    "\\?[\\uAC00-\\uD7AF]"
  ].join("|"),
  "u"
);

const forbiddenUtf8DecodeArtifacts = [
  "\uACF8\uBEC4",
  "\uC6D0\u0080",
  "\uF9DD",
  "\uAFBE\uC758",
  "\uC3F5\uC801",
  "\uC785\uC815"
];

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

  it("does not keep mojibake artifacts in tracked source and docs", () => {
    const hits: string[] = [];
    for (const file of scanTextFiles(["src", "scripts", "README.md", "docs"])) {
      const text = readFileSync(file, "utf8");
      if (forbiddenMojibake.test(text) || forbiddenUtf8DecodeArtifacts.some((artifact) => text.includes(artifact))) {
        hits.push(file);
      }
    }

    expect(hits).toEqual([]);
  });

  it("sends browser RPC payloads as explicit UTF-8 JSON", () => {
    const clientSource = readFileSync(join("src", "renderer", "aetherClient.ts"), "utf8");
    const serverSource = readFileSync(join("src", "server", "webServer.ts"), "utf8");

    expect(clientSource).toContain('"Content-Type": "application/json; charset=utf-8"');
    expect(serverSource).toContain("decodeStrictUtf8Chunks");
    expect(serverSource).not.toContain('request.setEncoding("utf8")');
  });

  it("keeps self-test Korean sentinel payloads readable", () => {
    const selftestSource = readFileSync(join("scripts", "selftest.mjs"), "utf8");

    expect(selftestSource).toContain("한글 질문");
    expect(selftestSource).toContain("근거 추적성");
    expect(selftestSource).toContain("설정 부족");
    expect(selftestSource).toContain("검색 snippet은 evidence가 아님");
    expect(selftestSource).toContain("fatal UTF-8 decode");
  });

  it("serves generated text-like static files with UTF-8 charset", () => {
    const serverSource = readFileSync(join("src", "server", "webServer.ts"), "utf8");

    expect(serverSource).toContain('return "text/markdown; charset=utf-8"');
    expect(serverSource).toContain('return "text/plain; charset=utf-8"');
    expect(serverSource).toContain('return "application/json; charset=utf-8"');
  });
});

function scanTextFiles(entries: string[]): string[] {
  const files: string[] = [];
  for (const entry of entries) {
    if (!existsSync(entry)) continue;
    const stats = statSync(entry);
    if (stats.isDirectory()) {
      for (const child of readdirSync(entry)) {
        files.push(...scanTextFiles([join(entry, child)]));
      }
    } else if (/\.(ts|tsx|js|mjs|md|json)$/.test(entry)) {
      files.push(entry);
    }
  }
  return files;
}

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
