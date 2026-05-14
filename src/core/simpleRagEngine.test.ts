import { describe, expect, it } from "vitest";
import { InMemoryResearchStore } from "./memoryStore.js";
import { AetherOpsOrchestrator } from "./orchestrator.js";
import { SimpleRagEngine } from "./simpleRagEngine.js";
import type { CreateProjectInput } from "./types.js";

const input: CreateProjectInput = {
  goal: "RAG 연결 검증",
  topic: "vector search context",
  scope: "저장된 근거를 검색 컨텍스트로 재사용",
  budget: "MVP",
  autonomyPolicy: {
    toolApproval: "suggested",
    maxLoopIterations: 1,
    allowExternalSearch: true,
    allowCodeExecution: true
  }
};

describe("SimpleRagEngine", () => {
  it("connects stored evidence and artifacts to the next context", async () => {
    const store = new InMemoryResearchStore();
    const orchestrator = new AetherOpsOrchestrator(store, undefined, new SimpleRagEngine());
    let snapshot = await orchestrator.createProject(input);
    snapshot = await orchestrator.startLoop(snapshot.project.id);

    const context = snapshot.ragContexts.at(-1);
    expect(context).toBeDefined();
    expect(context?.evidenceIds.length).toBeGreaterThan(0);
    expect(context?.artifactIds.length).toBeGreaterThan(0);
    expect(context?.summary).toContain("RAG");
  });
});
