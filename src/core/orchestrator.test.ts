import { describe, expect, it } from "vitest";
import { InMemoryResearchStore } from "./memoryStore.js";
import { MockOpenCodeAdapter } from "./mockOpenCodeAdapter.js";
import { AetherOpsOrchestrator } from "./orchestrator.js";
import { ResearchLoopStep, type CreateProjectInput } from "./types.js";

const input: CreateProjectInput = {
  goal: "자동 연구 루프 검증",
  topic: "AetherOps loop",
  scope: "mock OpenCode와 로컬 RAG",
  budget: "MVP",
  autonomyPolicy: {
    toolApproval: "suggested",
    maxLoopIterations: 2,
    allowExternalSearch: true,
    allowCodeExecution: true
  }
};

describe("AetherOpsOrchestrator", () => {
  it("runs the exact initialization and research loop into final outputs", async () => {
    const orchestrator = new AetherOpsOrchestrator(new InMemoryResearchStore(), new MockOpenCodeAdapter());
    let snapshot = await orchestrator.createProject(input);
    snapshot = await orchestrator.createSubSessions(snapshot.project.id);
    snapshot = await orchestrator.createResearchDb(snapshot.project.id);
    snapshot = await orchestrator.seedQuestions(snapshot.project.id);
    snapshot = await orchestrator.startLoop(snapshot.project.id);

    expect(snapshot.project.currentStep).toBe(ResearchLoopStep.FinalizeOutputs);
    expect(snapshot.project.status).toBe("completed");
    expect(snapshot.sessions).toHaveLength(1);
    expect(snapshot.sessions[0]?.title).toBe("채팅 세션 1");
    expect(snapshot.database).toBeDefined();
    expect(snapshot.questions.length).toBeGreaterThan(0);
    expect(snapshot.hypotheses.every((item) => item.status === "supported" || item.status === "needs_more_evidence")).toBe(true);
    expect(snapshot.openCodeRuns).toHaveLength(2);
    expect(snapshot.ragContexts.length).toBeGreaterThanOrEqual(2);
    expect(snapshot.specifications.length).toBeGreaterThan(0);
    expect(snapshot.researchPlans.length).toBeGreaterThan(0);
    expect(snapshot.normalizedRecords.length).toBeGreaterThan(0);
    expect(snapshot.ontologyEntities.length).toBeGreaterThan(0);
    expect(snapshot.validationResults.length).toBeGreaterThan(0);
    expect(snapshot.finalOutputs.length).toBeGreaterThan(0);
    expect(snapshot.report?.answer).toContain("AetherOps loop");
    const loopReports = snapshot.artifacts.filter((artifact) => artifact.title === "채팅 세션 1 루프 보고");
    expect(loopReports.some((artifact) => artifact.content?.includes("4. 연구 계획 수립"))).toBe(true);
    expect(loopReports.some((artifact) => artifact.content?.includes("12. 최종 결과 도출"))).toBe(true);
  });

  it("stores every planned research DB category through the MVP loop", async () => {
    const orchestrator = new AetherOpsOrchestrator(new InMemoryResearchStore(), new MockOpenCodeAdapter());
    let snapshot = await orchestrator.createProject(input);
    snapshot = await orchestrator.startLoop(snapshot.project.id);

    const categories = new Set([
      ...snapshot.evidence.map((item) => item.category),
      ...snapshot.artifacts.map((item) => item.category)
    ]);

    expect(categories.has("generated_artifact")).toBe(true);
    expect(categories.has("experiment_log")).toBe(true);
    expect(categories.has("conversation_memo")).toBe(true);
  });

  it("deletes chat sessions without removing project progress", async () => {
    const orchestrator = new AetherOpsOrchestrator(new InMemoryResearchStore());
    let snapshot = await orchestrator.createProject(input);
    snapshot = await orchestrator.createSubSessions(snapshot.project.id);
    const firstSessionId = snapshot.sessions[0]?.id;
    snapshot = await orchestrator.createChatSession(snapshot.project.id);

    expect(snapshot.sessions).toHaveLength(2);
    expect(firstSessionId).toBeDefined();

    snapshot = await orchestrator.deleteChatSession(snapshot.project.id, firstSessionId ?? "");

    expect(snapshot.sessions).toHaveLength(1);
    expect(snapshot.sessions[0]?.title).toBe("채팅 세션 2");
    expect(snapshot.iterations.at(-1)?.message).toContain("삭제");
  });
});
