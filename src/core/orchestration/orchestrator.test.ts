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
    expect(snapshot.legacyAgentRuns).toHaveLength(0);
    expect(snapshot.toolRuns.filter((run) => run.toolName === "DataAnalysisTool")).toHaveLength(2);
    expect(snapshot.toolRuns.filter((run) => run.toolName === "ArtifactWriterTool")).toHaveLength(2);
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

    expect(snapshot.legacyAgentRuns).toHaveLength(0);
    expect(snapshot.toolRuns.filter((run) => run.toolName === "DataAnalysisTool")).toHaveLength(1);
    expect(snapshot.toolRuns.filter((run) => run.toolName === "ArtifactWriterTool")).toHaveLength(1);
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

    expect(snapshot.legacyAgentRuns).toHaveLength(0);
    expect(snapshot.toolRuns.filter((run) => run.toolName === "DataAnalysisTool")).toHaveLength(1);
    expect(snapshot.toolRuns.filter((run) => run.toolName === "ArtifactWriterTool")).toHaveLength(1);
    expect(snapshot.researchPlans).toHaveLength(planCount);
    expect(snapshot.project.status).toBe("completed");
  });

  it.each(["blocked", "failed", "running"] as const)("re-enters execution when a durable resume starts from a %s project snapshot", async (status) => {
    const store = new InMemoryResearchStore();
    const orchestrator = createStrictTestOrchestrator({ store });
    const snapshot = await createInputProject(orchestrator, {
      ...input,
      autonomyPolicy: { ...input.autonomyPolicy, maxLoopIterations: 1 }
    });
    await store.updateProject({ ...snapshot.project, status });

    const resumed = await orchestrator.resume(snapshot.project.id);

    expect(resumed.project.status).toBe("completed");
    expect(resumed.project.currentStep).toBe(ResearchLoopStep.FinalizeOutputs);
    expect(resumed.toolRuns.length).toBeGreaterThan(0);
  });

  it.each(["idle", "completed", "aborted"] as const)("rejects a durable resume from a non-resumable %s project snapshot", async (status) => {
    const store = new InMemoryResearchStore();
    const orchestrator = createStrictTestOrchestrator({ store });
    const snapshot = await createInputProject(orchestrator, input);
    await store.updateProject({ ...snapshot.project, status });

    await expect(orchestrator.resume(snapshot.project.id)).rejects.toThrow(/cannot resume from project status/);
  });

  it("runs registered research tools without requiring Codex CLI when the plan excludes CodexCliTool", async () => {
    const settings: AppSettings = {
      ...strictTestSettings,
      allowExternalSearch: false,
      allowCodeExecution: false
    };
    const llm = new ToolOnlyPlanLlmProvider();
    const orchestrator = createStrictTestOrchestrator({
      settings,
      llm,
      codexCli: {
        preflight: async () => {
          throw new Error("Codex CLI preflight should not run for a tool-only plan.");
        },
        run: async () => {
          throw new Error("Codex CLI run should not run for a tool-only plan.");
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
    expect(snapshot.legacyAgentRuns).toHaveLength(0);
    expect(snapshot.toolRuns.map((toolRun) => toolRun.toolName)).toEqual(["DataAnalysisTool", "ArtifactWriterTool"]);
    expect(snapshot.iterations.some((iteration) => iteration.step === ResearchLoopStep.ExecuteTools)).toBe(true);
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

    const categories = new Set([...snapshot.evidence.map((item) => item.category), ...snapshot.artifacts.map((item) => item.category)]);

    expect(categories.has("generated_artifact")).toBe(true);
    expect(categories.has("experiment_log")).toBe(false);
    expect(snapshot.toolRuns.some((run) => run.toolName === "DataAnalysisTool" && run.status === "completed")).toBe(true);
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

  it("assigns distinct project roots to same-topic projects created on the same day", async () => {
    const orchestrator = createStrictTestOrchestrator({ store: new InMemoryResearchStore() });
    const first = await orchestrator.createProject(input);
    const second = await orchestrator.createProject(input);

    expect(first.project.id).not.toBe(second.project.id);
    expect(first.project.projectRoot).not.toBe(second.project.projectRoot);
    for (const project of [first.project, second.project]) {
      const shortProjectId = project.id
        .replace(/^project[_-]/, "")
        .replace(/[^a-zA-Z0-9]/g, "")
        .slice(0, 12);
      expect(project.projectRoot).toMatch(new RegExp(`-${shortProjectId}$`));
    }
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
      toolRequests: [
        {
          intentId: "analyze-results",
          toolName: "DataAnalysisTool",
          purpose: "Analyze the deterministic research evidence.",
          expectedOutcome: "A traceable evidence assessment.",
          inputs: { checks: ["evidence_coverage", "hypothesis_coverage"] }
        },
        {
          intentId: "write-artifact",
          toolName: "ArtifactWriterTool",
          purpose: "Write the deterministic research note.",
          expectedOutcome: "A persisted iteration research note.",
          inputs: {
            artifacts: [{ relativePath: "artifacts/iteration-1/research-note.md", kind: "research_report", format: "markdown" }]
          }
        }
      ],
      expectedSources: ["tool log", "artifact"],
      expectedArtifacts: ["research-note.md"],
      executionSteps: ["Run registered research tools"],
      stopCriteria: ["Internal safety cap reached"],
      fetchCandidateUrls: []
    } as T;
  }
}
