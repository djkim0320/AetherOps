import { describe, expect, it } from "vitest";
import { createId, nowIso } from "./ids.js";
import { InMemoryResearchStore } from "./memoryStore.js";
import { AetherOpsOrchestrator } from "./orchestrator.js";
import { SimpleRagEngine } from "./simpleRagEngine.js";
import type { OpenCodeAdapter, OpenCodeRunInput, OpenCodeRunOutput, ResearchProjectInput } from "./types.js";

const input: ResearchProjectInput = {
  goal: "RAG connection check",
  topic: "vector search context",
  scope: "Reuse stored evidence as retrieval context.",
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
    const orchestrator = new AetherOpsOrchestrator(store, new DeterministicOpenCodeAdapter(), new SimpleRagEngine());
    let snapshot = await orchestrator.createProject(input);
    snapshot = await orchestrator.startLoop(snapshot.project.id);

    const context = snapshot.ragContexts.at(-1);
    expect(context).toBeDefined();
    expect(context?.evidenceIds.length).toBeGreaterThan(0);
    expect(context?.artifactIds.length).toBeGreaterThan(0);
    expect(context?.summary).toContain("RAG");
  });
});

class DeterministicOpenCodeAdapter implements OpenCodeAdapter {
  async run(input: OpenCodeRunInput): Promise<OpenCodeRunOutput> {
    const createdAt = nowIso();
    const artifact = {
      id: createId("artifact"),
      projectId: input.project.id,
      category: "generated_artifact" as const,
      title: "Deterministic RAG artifact",
      relativePath: `artifacts/iteration-${input.iteration}/rag.md`,
      mimeType: "text/markdown",
      summary: "Stored artifact for retrieval",
      content: "Stored artifact for retrieval context.",
      createdAt
    };
    const evidence = {
      id: createId("evidence"),
      projectId: input.project.id,
      category: "experiment_log" as const,
      title: "Deterministic RAG evidence",
      summary: "Stored evidence for retrieval context.",
      keywords: ["rag", "retrieval"],
      linkedHypothesisIds: input.hypotheses.map((item) => item.id),
      createdAt
    };
    return {
      run: {
        id: createId("opencode"),
        projectId: input.project.id,
        iteration: input.iteration,
        prompt: "deterministic rag run",
        toolPlan: ["deterministic-rag"],
        status: "completed",
        logs: ["deterministic rag run"],
        artifactIds: [artifact.id],
        evidenceIds: [evidence.id],
        startedAt: createdAt,
        completedAt: createdAt
      },
      artifacts: [artifact],
      evidence: [evidence]
    };
  }
}
