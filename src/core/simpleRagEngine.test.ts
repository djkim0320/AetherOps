import { describe, expect, it } from "vitest";
import { createInputProject, createStrictTestOrchestrator } from "./orchestratorTestHarness.test.js";
import { SimpleRagEngine } from "./simpleRagEngine.js";
import type { ResearchProjectInput } from "./types.js";

const input: ResearchProjectInput = {
  goal: "RAG connection check",
  topic: "vector search context",
  scope: "Reuse stored evidence as retrieval context.",
  budget: "MVP",
  autonomyPolicy: {
    toolApproval: "suggested",
    allowExternalSearch: false,
    allowCodeExecution: false
  }
};

describe("SimpleRagEngine", () => {
  it("connects stored evidence and artifacts to the next context", async () => {
    const orchestrator = createStrictTestOrchestrator({ ragEngine: new SimpleRagEngine() });
    let snapshot = await createInputProject(orchestrator, input);
    snapshot = await orchestrator.startLoop(snapshot.project.id);

    const context = snapshot.ragContexts.at(-1);
    expect(context).toBeDefined();
    expect(context?.evidenceIds.length).toBeGreaterThan(0);
    expect(context?.artifactIds.length).toBeGreaterThan(0);
    expect(context?.summary).toContain("evidence");
  });
});
