import { describe, expect, it } from "vitest";
import { InMemoryResearchStore } from "./memoryStore.js";
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
    const orchestrator = new AetherOpsOrchestrator(new InMemoryResearchStore());
    let snapshot = await orchestrator.createProject(input);
    snapshot = await orchestrator.createSubSessions(snapshot.project.id);
    snapshot = await orchestrator.createResearchDb(snapshot.project.id);
    snapshot = await orchestrator.seedQuestions(snapshot.project.id);
    snapshot = await orchestrator.startLoop(snapshot.project.id);

    expect(snapshot.project.currentStep).toBe(ResearchLoopStep.FinalizeResearchOutputs);
    expect(snapshot.project.status).toBe("completed");
    expect(snapshot.sessions).toHaveLength(3);
    expect(snapshot.database).toBeDefined();
    expect(snapshot.questions.length).toBeGreaterThan(0);
    expect(snapshot.hypotheses.every((item) => item.status === "supported")).toBe(true);
    expect(snapshot.openCodeRuns).toHaveLength(2);
    expect(snapshot.ragContexts.length).toBeGreaterThanOrEqual(2);
    expect(snapshot.report?.answer).toContain("AetherOps loop");
  });

  it("stores every planned research DB category through the MVP loop", async () => {
    const orchestrator = new AetherOpsOrchestrator(new InMemoryResearchStore());
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
});
