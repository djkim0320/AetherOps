import { describe, expect, it } from "vitest";
import type { LlmJsonRequest, LlmProvider } from "../providers/llm.js";
import { InMemoryResearchStore } from "../memory/memoryStore.js";
import { createInputProject, createStrictTestOrchestrator, DeterministicLlmProvider, strictTestSettings } from "../testing/orchestratorTestHarness.js";
import { ResearchLoopStep, type AppSettings, type ResearchProjectInput } from "../shared/types.js";

const input: ResearchProjectInput = {
  goal: "Verify that the autonomous research loop follows the 12-step structure.",
  topic: "AetherOps loop",
  scope: "Check tool execution, normalization, Vector Index, Ontology Graph, validation, and final output.",
  budget: "MVP",
  autonomyPolicy: {
    toolApproval: "suggested",
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
    expect(snapshot.projectContextSnapshots.length).toBeGreaterThan(0);
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

  it("honors optional autonomyPolicy.maxLoopIterations as the internal safety cap", async () => {
    const orchestrator = createStrictTestOrchestrator();
    let snapshot = await createInputProject(orchestrator, {
      ...input,
      autonomyPolicy: {
        ...input.autonomyPolicy,
        maxLoopIterations: 1
      }
    });
    snapshot = await orchestrator.startLoop(snapshot.project.id);

    expect(snapshot.openCodeRuns).toHaveLength(1);
    expect(snapshot.continuationDecisions.at(-1)?.forceStop).toBe(true);
    expect(snapshot.project.status).toBe("completed");
  });

  it("does not create an unused plan after the loop limit is already exhausted", async () => {
    const orchestrator = createStrictTestOrchestrator();
    let snapshot = await createInputProject(orchestrator, {
      ...input,
      autonomyPolicy: {
        ...input.autonomyPolicy,
        maxLoopIterations: 1
      }
    });
    snapshot = await orchestrator.startLoop(snapshot.project.id);
    const planCount = snapshot.researchPlans.length;

    snapshot = await orchestrator.startLoop(snapshot.project.id);

    expect(snapshot.openCodeRuns).toHaveLength(1);
    expect(snapshot.researchPlans).toHaveLength(planCount);
    expect(snapshot.project.status).toBe("completed");
  });

  it("runs registered research tools without requiring OpenCode when the LLM plan excludes OpenCodeTool", async () => {
    const settings: AppSettings = {
      ...strictTestSettings,
      openCode: { ...strictTestSettings.openCode, enabled: false },
      allowExternalSearch: false,
      allowCodeExecution: false
    };
    const llm = new ToolOnlyPlanLlmProvider();
    const orchestrator = createStrictTestOrchestrator({
      settings,
      llm,
      openCode: {
        preflight: async () => {
          throw new Error("OpenCode preflight should not run for a tool-only plan.");
        },
        run: async () => {
          throw new Error("OpenCode run should not run for a tool-only plan.");
        }
      }
    });
    let snapshot = await createInputProject(orchestrator, {
      ...input,
      autonomyPolicy: {
        ...input.autonomyPolicy,
        maxLoopIterations: 1
      }
    });

    snapshot = await orchestrator.startLoop(snapshot.project.id);

    expect(snapshot.project.status).toBe("completed");
    expect(snapshot.openCodeRuns).toHaveLength(0);
    expect(snapshot.toolRuns.map((toolRun) => toolRun.toolName)).toEqual(["ArtifactWriterTool", "DataAnalysisTool"]);
    expect(snapshot.iterations.some((iteration) => iteration.message.includes("Autonomous registered research tools completed"))).toBe(true);
  });


  it("does not synthesize without a ProjectContextSnapshot", async () => {
    const orchestrator = createStrictTestOrchestrator();
    let snapshot = await createInputProject(orchestrator, input);
    snapshot = await orchestrator.createResearchDb(snapshot.project.id);
    snapshot = await orchestrator.buildResearchSpecification(snapshot.project.id);
    snapshot = await orchestrator.planResearch(snapshot.project.id);

    await expect(orchestrator.synthesizeAndEvaluate(snapshot.project.id, 1)).rejects.toThrow(/ProjectContextSnapshot/);
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

  it("stores compressed project context as durable searchable memory during long loops", async () => {
    const orchestrator = createStrictTestOrchestrator();
    let snapshot = await createInputProject(orchestrator, input);
    snapshot = await orchestrator.startLoop(snapshot.project.id);

    const compressionRecords = snapshot.normalizedRecords.filter((record) => record.metadata.contextCompression === true);
    const compressionRecordIds = new Set(compressionRecords.map((record) => record.id));
    const compressionChunks = snapshot.chunks.filter((chunk) => chunk.recordId && compressionRecordIds.has(chunk.recordId));

    expect(compressionRecords.length).toBeGreaterThan(0);
    expect(compressionRecords[0]?.metadata).toMatchObject({
      sourceKind: "context_compression",
      traceabilityKind: "project_provenance",
      canSupportHypothesis: false
    });
    expect(compressionRecords[0]?.content).toContain("Project Context Compression");
    expect(compressionChunks.length).toBeGreaterThan(0);
    expect(snapshot.iterations.some((iteration) => iteration.message.includes("Context compression stored"))).toBe(true);
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

class ToolOnlyPlanLlmProvider implements LlmProvider {
  readonly name = "tool-only-plan-test-llm";
  private readonly base = new DeterministicLlmProvider();

  async isAvailable(): Promise<boolean> {
    return true;
  }

  async completeJson<T>(request: LlmJsonRequest): Promise<T> {
    if (request.schemaName !== "AetherOpsResearchPlan") {
      return this.base.completeJson<T>(request);
    }
    return {
      objective: "Iteration 1: run registered AetherOps research tools without OpenCode.",
      targetQuestions: ["q1"],
      targetHypotheses: ["h1"],
      requiredTools: ["ArtifactWriterTool", "DataAnalysisTool"],
      expectedSources: ["tool log", "artifact"],
      expectedArtifacts: ["research-note.md"],
      executionSteps: ["Run registered research tools"],
      stopCriteria: ["Internal safety cap reached"]
    } as T;
  }
}
