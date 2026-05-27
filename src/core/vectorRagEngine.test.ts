import { describe, expect, it } from "vitest";
import { chunkResearchSource } from "./chunking.js";
import { DeterministicEmbeddingProvider } from "./orchestratorTestHarness.test.js";
import { VectorRagEngine } from "./vectorRagEngine.js";
import { ResearchLoopStep, type ResearchSnapshot, type ResearchSource } from "./types.js";

describe("VectorRagEngine", () => {
  it("retrieves related chunks with citations", async () => {
    const provider = new DeterministicEmbeddingProvider(64);
    const source: ResearchSource = {
      id: "source-pomodoro",
      projectId: "project-1",
      kind: "web",
      title: "Pomodoro study note",
      url: "https://example.com/pomodoro",
      retrievedAt: "2026-05-14T00:00:00.000Z",
      metadata: {},
      createdAt: "2026-05-14T00:00:00.000Z"
    };
    const chunks = await Promise.all(
      chunkResearchSource(source, "Pomodoro 25 minute focus and 5 minute breaks can reduce fatigue in study sessions.").map(async (chunk) => ({
        ...chunk,
        embedding: await provider.embed(chunk.text)
      }))
    );
    const snapshot: ResearchSnapshot = {
      project: {
        id: "project-1",
        goal: "Compare Pomodoro study sessions",
        topic: "Pomodoro 25/5 vs 50/10",
        scope: "focus fatigue completion",
        budget: "test",
        autonomyPolicy: {
          toolApproval: "suggested",
          allowExternalSearch: false,
          allowCodeExecution: false
        },
        createdAt: "2026-05-14T00:00:00.000Z",
        updatedAt: "2026-05-14T00:00:00.000Z",
        currentStep: ResearchLoopStep.BuildVectorIndex,
        status: "running",
        projectRoot: ".aetherops/test"
      },
      sessions: [],
      questions: [{ id: "q1", projectId: "project-1", text: "Does Pomodoro reduce fatigue?", status: "open", createdAt: "2026-05-14T00:00:00.000Z" }],
      hypotheses: [],
      evidence: [],
      artifacts: [],
      sources: [source],
      researchInputs: [],
      chunks,
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

    const context = await new VectorRagEngine(provider).buildContext(snapshot);
    expect(context.chunkIds?.length).toBeGreaterThan(0);
    expect(context.citations?.at(0)).toContain("https://example.com/pomodoro");
    expect(Object.keys(context.retrievalScores ?? {})).toContain(chunks[0].id);
    expect(context.contextText).toContain("Pomodoro");
  });
});
