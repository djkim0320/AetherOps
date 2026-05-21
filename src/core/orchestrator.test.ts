import { describe, expect, it } from "vitest";
import { InMemoryResearchStore } from "./memoryStore.js";
import { createInputProject, createStrictTestOrchestrator } from "./orchestratorTestHarness.test.js";
import { ResearchLoopStep, type ResearchProjectInput } from "./types.js";

const input: ResearchProjectInput = {
  goal: "Verify that the autonomous research loop follows the 12-step structure.",
  topic: "AetherOps loop",
  scope: "Check tool execution, normalization, Vector Index, Ontology Graph, validation, and final output.",
  budget: "MVP",
  autonomyPolicy: {
    toolApproval: "suggested",
    maxLoopIterations: 2,
    allowExternalSearch: false,
    allowCodeExecution: false
  }
};

describe("AetherOpsOrchestrator", () => {
  it("runs the 1-12 architecture into final outputs", async () => {
    const orchestrator = createStrictTestOrchestrator();
    let snapshot = await createInputProject(orchestrator, input);
    snapshot = await orchestrator.createSubSessions(snapshot.project.id);
    snapshot = await orchestrator.createResearchDb(snapshot.project.id);
    snapshot = await orchestrator.startLoop(snapshot.project.id);

    const steps = snapshot.iterations.map((iteration) => iteration.step);

    expect(snapshot.project.currentStep).toBe(ResearchLoopStep.FinalizeOutputs);
    expect(snapshot.project.status).toBe("completed");
    expect(snapshot.sessions).toHaveLength(1);
    expect(snapshot.database).toBeDefined();
    expect(snapshot.researchInputs).toHaveLength(1);
    expect(snapshot.questions.length).toBeGreaterThan(0);
    expect(snapshot.hypotheses.every((item) => item.status === "supported" || item.status === "needs_more_evidence")).toBe(true);
    expect(snapshot.openCodeRuns).toHaveLength(2);
    expect(snapshot.ragContexts.length).toBeGreaterThanOrEqual(2);
    expect(snapshot.specifications.length).toBeGreaterThan(0);
    expect(snapshot.researchPlans.length).toBeGreaterThanOrEqual(2);
    expect(snapshot.normalizedRecords.length).toBeGreaterThan(0);
    expect(snapshot.chunks.length).toBeGreaterThan(0);
    expect(snapshot.ontologyEntities.length).toBeGreaterThan(0);
    expect(snapshot.ontologyRelations.length).toBeGreaterThan(0);
    expect(snapshot.validationResults.length).toBeGreaterThan(0);
    expect(snapshot.continuationDecisions.length).toBeGreaterThan(0);
    expect(snapshot.finalOutputs.length).toBeGreaterThan(0);
    expect(snapshot.report?.answer).toContain("AetherOps");

    expect(steps).toContain(ResearchLoopStep.CreateResearchDb);
    expect(steps).toContain(ResearchLoopStep.InputResearchQuestionHypothesis);
    expect(steps).toContain(ResearchLoopStep.BuildResearchSpecification);
    expect(steps).toContain(ResearchLoopStep.PlanResearch);
    expect(steps).toContain(ResearchLoopStep.ExecuteTools);
    expect(steps).toContain(ResearchLoopStep.NormalizeData);
    expect(steps).toContain(ResearchLoopStep.BuildVectorIndex);
    expect(steps).toContain(ResearchLoopStep.BuildOntologyGraph);
    expect(steps).toContain(ResearchLoopStep.ReasonAndValidate);
    expect(steps).toContain(ResearchLoopStep.SynthesizeAndEvaluate);
    expect(steps).toContain(ResearchLoopStep.DecideContinuation);
    expect(steps.at(-1)).toBe(ResearchLoopStep.FinalizeOutputs);
  });

  it("returns from step 11 to step 4 before the next tool execution when continuing", async () => {
    const orchestrator = createStrictTestOrchestrator();
    let snapshot = await createInputProject(orchestrator, input);
    snapshot = await orchestrator.startLoop(snapshot.project.id);

    const steps = snapshot.iterations.map((iteration) => iteration.step);
    const firstDecisionIndex = steps.findIndex((step) => step === ResearchLoopStep.DecideContinuation);
    const firstContinueDecision = snapshot.continuationDecisions[0];

    expect(firstContinueDecision?.shouldContinue).toBe(true);
    expect(firstDecisionIndex).toBeGreaterThan(-1);
    expect(steps[firstDecisionIndex + 1]).toBe(ResearchLoopStep.PlanResearch);
    expect(steps[firstDecisionIndex + 2]).toBe(ResearchLoopStep.ExecuteTools);
  });

  it("stores every persistent memory category through the strict loop", async () => {
    const orchestrator = createStrictTestOrchestrator();
    let snapshot = await createInputProject(orchestrator, input);
    snapshot = await orchestrator.startLoop(snapshot.project.id);

    const categories = new Set([
      ...snapshot.evidence.map((item) => item.category),
      ...snapshot.artifacts.map((item) => item.category)
    ]);

    expect(categories.has("generated_artifact")).toBe(true);
    expect(categories.has("experiment_log")).toBe(true);
    expect(snapshot.sources.length).toBeGreaterThan(0);
    expect(snapshot.chunks.length).toBeGreaterThan(0);
    expect(snapshot.ontologyEntities.length).toBeGreaterThan(0);
  });

  it("deletes chat sessions without removing project progress", async () => {
    const orchestrator = createStrictTestOrchestrator({ store: new InMemoryResearchStore() });
    let snapshot = await orchestrator.createProject(input);
    snapshot = await orchestrator.createSubSessions(snapshot.project.id);
    const firstSessionId = snapshot.sessions[0]?.id;
    snapshot = await orchestrator.createChatSession(snapshot.project.id);

    expect(snapshot.sessions).toHaveLength(2);
    expect(firstSessionId).toBeDefined();

    snapshot = await orchestrator.deleteChatSession(snapshot.project.id, firstSessionId ?? "");

    expect(snapshot.sessions).toHaveLength(1);
    expect(snapshot.iterations.at(-1)?.message).toBeTruthy();
  });
});
