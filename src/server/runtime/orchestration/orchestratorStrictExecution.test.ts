import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { nowIso } from "../../../core/shared/ids.js";
import {
  createInputProject,
  createStrictTestOrchestrator,
  DeterministicOpenCodeAdapter,
  DeterministicLlmProvider,
  strictTestSettings
} from "../../../core/testing/orchestratorTestHarness.js";
import type { LlmJsonRequest } from "../../../core/providers/llm.js";
import { ToolRunner } from "../../../core/tools/toolRunner.js";
import { WebFetchTool, type ResearchTool, type ResearchToolResult } from "../../../core/tools/toolRegistry.js";
import { ResearchLoopStep, type OpenCodeAdapter, type OpenCodeRunInput, type OpenCodeRunOutput, type ResearchProjectInput } from "../../../core/shared/types.js";
import { NodeProjectStorage } from "../storage/projectResearchStore.js";

let tempDir: string | undefined;

const input: ResearchProjectInput = {
  goal: "Compare Pomodoro 25/5 and 50/10 for a two-hour study session.",
  topic: "Pomodoro 25/5 vs 50/10",
  scope: "Use traceable evidence; no code execution.",
  budget: "30 minutes",
  autonomyPolicy: {
    toolApproval: "suggested",
    allowExternalSearch: false,
    allowCodeExecution: false
  }
};

class CapturingOpenCodeAdapter extends DeterministicOpenCodeAdapter {
  readonly inputs: OpenCodeRunInput[] = [];

  override async run(input: OpenCodeRunInput): Promise<OpenCodeRunOutput> {
    this.inputs.push(input);
    return super.run(input);
  }
}

class FailingFinalOutputStorage extends NodeProjectStorage {
  override async writeFinalOutputFiles(): ReturnType<NodeProjectStorage["writeFinalOutputFiles"]> {
    throw new Error("forced final output write failure");
  }
}

class MetadataFirstPlanner extends DeterministicLlmProvider {
  override async completeJson<T>(request: LlmJsonRequest): Promise<T> {
    if (request.schemaName === "AetherOpsResearchPlan") {
      return {
        objective: "Collect OpenAlex metadata before OpenCode analysis.",
        targetQuestions: ["q1"],
        targetHypotheses: ["h1"],
        requiredTools: ["OpenCodeTool", "ResearchMetadataTool"],
        expectedSources: ["OpenAlex paper metadata"],
        expectedArtifacts: ["metadata-aware analysis"],
        executionSteps: ["Run ResearchMetadataTool", "Run OpenCode with acquired metadata"],
        stopCriteria: ["OpenCode input contains metadata sources"]
      } as T;
    }
    return super.completeJson(request);
  }
}

const metadataAcquisitionTool: ResearchTool = {
  name: "ResearchMetadataTool",
  run: async (input: OpenCodeRunInput): Promise<ResearchToolResult> => {
    const completedAt = nowIso();
    return {
      toolRun: {
        id: "tool-openalex-test",
        projectId: input.project.id,
        iteration: input.iteration,
        toolName: "ResearchMetadataTool",
        input: { projectId: input.project.id, iteration: input.iteration },
        output: { sourceIds: ["source-openalex-test"], evidenceIds: ["evidence-openalex-test"] },
        status: "completed",
        startedAt: completedAt,
        completedAt
      },
      sources: [
        {
          id: "source-openalex-test",
          projectId: input.project.id,
          kind: "paper",
          title: "OpenAlex metadata captured before OpenCode",
          url: "https://openalex.org/W123",
          doi: "https://doi.org/10.1234/openalex-test",
          retrievedAt: completedAt,
          metadata: { provider: "openalex" },
          createdAt: completedAt
        }
      ],
      evidence: [
        {
          id: "evidence-openalex-test",
          projectId: input.project.id,
          category: "paper_reference",
          title: "OpenAlex metadata evidence",
          summary: "Metadata evidence is available before OpenCode runs.",
          sourceUri: "https://openalex.org/W123",
          citation: "OpenAlex metadata captured before OpenCode.",
          keywords: ["openalex", "metadata"],
          linkedHypothesisIds: input.hypotheses.map((item) => item.id),
          reliabilityScore: 0.75,
          relevanceScore: 0.8,
          evidenceStrength: "medium",
          limitations: [],
          metadata: { traceabilityKind: "external_source" },
          createdAt: completedAt
        }
      ],
      artifacts: []
    };
  }
};

afterEach(() => {
  if (tempDir) {
    rmSync(tempDir, { recursive: true, force: true });
    tempDir = undefined;
  }
});

describe("AetherOps strict execution loop", () => {
  it("derives research input from the project brief when separate hypotheses are missing", async () => {
    const orchestrator = createStrictTestOrchestrator();
    let snapshot = await orchestrator.createProject(input);
    snapshot = await orchestrator.seedQuestions(snapshot.project.id);

    expect(snapshot.project.currentStep).toBe(ResearchLoopStep.BuildResearchSpecification);
    expect(snapshot.project.status).not.toBe("blocked");
    expect(snapshot.runtimeBlockers.some((blocker) => blocker.requirementKey === "research_input")).toBe(false);
    expect(snapshot.researchInputs).toHaveLength(1);
    expect(snapshot.researchInputs[0]?.researchQuestion).toBe(input.goal);
    expect(snapshot.researchInputs[0]?.initialHypotheses.length).toBeGreaterThan(0);
    expect(snapshot.researchInputs[0]?.initialHypotheses[0]).toContain(input.topic);
    expect(snapshot.questions).toHaveLength(1);
    expect(snapshot.hypotheses.length).toBeGreaterThan(0);
    expect(snapshot.finalOutputs).toHaveLength(0);
  });

  it("runs research metadata before OpenCode so the LLM receives real acquired sources", async () => {
    const openCode = new CapturingOpenCodeAdapter();
    const orchestrator = createStrictTestOrchestrator({
      openCode,
      llm: new MetadataFirstPlanner(),
      toolRunner: new ToolRunner([metadataAcquisitionTool]),
      settings: {
        ...strictTestSettings,
        allowExternalSearch: true,
        researchMetadata: { ...strictTestSettings.researchMetadata, enabled: true }
      }
    });

    let snapshot = await createInputProject(orchestrator, {
      ...input,
      autonomyPolicy: {
        ...input.autonomyPolicy,
        allowExternalSearch: true,
        maxLoopIterations: 1
      }
    });
    snapshot = await orchestrator.startLoop(snapshot.project.id);

    expect(snapshot.project.status).toBe("completed");
    expect(openCode.inputs).toHaveLength(1);
    expect(openCode.inputs[0]?.sources?.some((source) => source.id === "source-openalex-test")).toBe(true);
    expect(openCode.inputs[0]?.evidence?.some((evidence) => evidence.id === "evidence-openalex-test")).toBe(true);
    expect(snapshot.toolRuns.some((toolRun) => toolRun.toolName === "ResearchMetadataTool")).toBe(true);
  });

  it("uses the current GUI research brief instead of stale untagged specifications or plans", async () => {
    const openCode = new CapturingOpenCodeAdapter();
    const orchestrator = createStrictTestOrchestrator({
      openCode,
      settings: {
        ...strictTestSettings,
        maxLoopIterations: 1
      }
    });
    const nextInput: ResearchProjectInput = {
      goal: "Evaluate whether citation-aware metadata improves RAG precision for literature review workflows.",
      topic: "citation-aware metadata RAG precision",
      scope: "Use traceable metadata and no synthetic sources.",
      budget: "20 minutes",
      autonomyPolicy: {
        ...input.autonomyPolicy,
        maxLoopIterations: 1
      }
    };
    const nextHypothesis = "Citation-aware metadata improves RAG precision compared with text-only retrieval.";

    let snapshot = await createInputProject(orchestrator, input);
    snapshot = await orchestrator.buildResearchSpecification(snapshot.project.id);
    snapshot = await orchestrator.planResearch(snapshot.project.id, 1);
    const staleInputId = snapshot.researchInputs.at(-1)?.id;

    snapshot = await orchestrator.updateProjectInput(snapshot.project.id, nextInput);
    snapshot = await orchestrator.inputResearchQuestionHypothesis(snapshot.project.id, {
      researchQuestion: nextInput.goal,
      initialHypotheses: [nextHypothesis],
      constraints: [],
      expectedOutputs: []
    });
    const activeInputId = snapshot.researchInputs.at(-1)?.id;
    snapshot = await orchestrator.startLoop(snapshot.project.id);

    expect(snapshot.project.status).toBe("completed");
    expect(activeInputId).toBeDefined();
    expect(activeInputId).not.toBe(staleInputId);
    expect(openCode.inputs).toHaveLength(1);
    expect(openCode.inputs[0]?.questions.map((question) => question.text)).toEqual([nextInput.goal]);
    expect(openCode.inputs[0]?.hypotheses.map((hypothesis) => hypothesis.statement)).toEqual([nextHypothesis]);
    expect(openCode.inputs[0]?.specification?.sourceResearchInputId).toBe(activeInputId);
    expect(openCode.inputs[0]?.researchPlan?.sourceResearchInputId).toBe(activeInputId);
    expect(JSON.stringify(openCode.inputs[0])).not.toContain(input.goal);
  });

  it("fails at FinalizeOutputs when the final report cannot be written", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "aetherops-loop-"));
    const orchestrator = createStrictTestOrchestrator({
      storage: new FailingFinalOutputStorage(),
      projectRootBase: join(tempDir, "projects")
    });

    let snapshot = await createInputProject(orchestrator, {
      ...input,
      autonomyPolicy: {
        ...input.autonomyPolicy,
        maxLoopIterations: 1
      }
    });
    snapshot = await orchestrator.startLoop(snapshot.project.id);

    expect(snapshot.project.status).toBe("failed");
    expect(snapshot.project.currentStep).toBe(ResearchLoopStep.FinalizeOutputs);
    expect(snapshot.stepErrors.at(-1)).toMatchObject({
      step: ResearchLoopStep.FinalizeOutputs,
      cause: "step_failed"
    });
    expect(snapshot.stepErrors.at(-1)?.message).toContain("forced final output write failure");
    expect(snapshot.report).toBeUndefined();
    expect(snapshot.finalOutputs).toHaveLength(0);
    expect(snapshot.runAuditOutputs).toHaveLength(1);
    expect(snapshot.runAuditOutputs[0]).toMatchObject({
      finalStatus: "failed",
      failedStep: ResearchLoopStep.FinalizeOutputs
    });
    expect(existsSync(join(snapshot.project.projectRoot, "reports", "final-report.md"))).toBe(false);
  });

  it("blocks clearly when the OpenCode execution engine is not configured", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "aetherops-loop-"));
    const orchestrator = createStrictTestOrchestrator({
      storage: new NodeProjectStorage(),
      projectRootBase: join(tempDir, "projects"),
      settings: {
        ...strictTestSettings,
        openCode: { ...strictTestSettings.openCode, enabled: false, command: "" }
      }
    });

    let snapshot = await createInputProject(orchestrator, input);
    snapshot = await orchestrator.startLoop(snapshot.project.id);

    expect(snapshot.project.currentStep).toBe(ResearchLoopStep.ExecuteTools);
    expect(snapshot.project.status).toBe("blocked");
    expect(snapshot.runtimeBlockers.length).toBeGreaterThan(0);
    expect(snapshot.stepErrors.length).toBeGreaterThan(0);
    expect(snapshot.openCodeRuns).toHaveLength(0);
    expect(snapshot.evidence.some((item) => item.keywords.includes("tool_unavailable") || item.keywords.includes("evidence_gap"))).toBe(false);
    expect(snapshot.report).toBeUndefined();
    expect(snapshot.finalOutputs).toHaveLength(0);
    expect(snapshot.runAuditOutputs).toHaveLength(1);
    expect(snapshot.runAuditOutputs[0]).toMatchObject({
      finalStatus: "blocked",
      failedStep: ResearchLoopStep.ExecuteTools
    });
    expect(snapshot.runAuditOutputs[0]?.markdownReport).toContain("blocked before execution could proceed");
    expect(snapshot.runAuditOutputs[0]?.unmetRequirements?.length).toBeGreaterThan(0);
    expect(existsSync(join(snapshot.project.projectRoot, "reports", "run-audit.md"))).toBe(true);
    expect(existsSync(join(snapshot.project.projectRoot, "exports", "run-audit.json"))).toBe(true);
    expect(existsSync(join(snapshot.project.projectRoot, "reports", "final-report.md"))).toBe(false);
  });

  it("blocks at BuildVectorIndex when the embedding API key is missing while preserving partial outputs", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "aetherops-loop-"));
    const orchestrator = createStrictTestOrchestrator({
      storage: new NodeProjectStorage(),
      projectRootBase: join(tempDir, "projects"),
      settings: {
        ...strictTestSettings,
        embedding: {
          provider: "openai",
          model: "text-embedding-3-small",
          dimensions: 64,
          apiKeyConfigured: false
        }
      }
    });

    let snapshot = await createInputProject(orchestrator, input);
    snapshot = await orchestrator.startLoop(snapshot.project.id);

    expect(snapshot.project.status).toBe("blocked");
    expect(snapshot.project.currentStep).toBe(ResearchLoopStep.BuildVectorIndex);
    expect(snapshot.runtimeBlockers.some((blocker) => blocker.requirementKey === "embedding.apiKey")).toBe(true);
    expect(snapshot.stepErrors.at(-1)).toMatchObject({
      step: ResearchLoopStep.BuildVectorIndex,
      cause: "runtime_requirement"
    });
    expect(snapshot.runAuditOutputs).toHaveLength(1);
    expect(snapshot.runAuditOutputs[0]).toMatchObject({
      finalStatus: "blocked",
      failedStep: ResearchLoopStep.BuildVectorIndex
    });
    expect(snapshot.runAuditOutputs[0]?.unmetRequirements?.some((item) => item.requirementKey === "embedding.apiKey")).toBe(true);
    expect(snapshot.finalOutputs).toHaveLength(0);
    expect(snapshot.openCodeRuns.length).toBeGreaterThan(0);
    expect(snapshot.sources.length).toBeGreaterThan(0);
    expect(snapshot.artifacts.length).toBeGreaterThan(0);
    expect(snapshot.normalizedRecords.length).toBeGreaterThan(0);
    expect(snapshot.evidence.some((item) => !item.sourceUri && !item.citation && !item.quote)).toBe(false);
    expect(existsSync(join(snapshot.project.projectRoot, "reports", "run-audit.md"))).toBe(true);
    expect(existsSync(join(snapshot.project.projectRoot, "exports", "run-audit.json"))).toBe(true);
    expect(existsSync(join(snapshot.project.projectRoot, "reports", "final-report.md"))).toBe(false);
  });

  it("blocks at PlanResearch when the LLM requests an unregistered tool", async () => {
    const orchestrator = createStrictTestOrchestrator({ llm: new UnregisteredToolPlanner() });
    let snapshot = await createInputProject(orchestrator, input);
    snapshot = await orchestrator.startLoop(snapshot.project.id);

    expect(snapshot.project.currentStep).toBe(ResearchLoopStep.PlanResearch);
    expect(snapshot.project.status).toBe("blocked");
    expect(snapshot.runtimeBlockers.some((blocker) => blocker.requirementKey === "tool.registered")).toBe(true);
    expect(snapshot.openCodeRuns).toHaveLength(0);
    expect(snapshot.finalOutputs).toHaveLength(0);
  });

  it("records ExecuteTools as the failed step when a configured execution tool fails", async () => {
    const orchestrator = createStrictTestOrchestrator({ openCode: failingAdapter() });
    let snapshot = await createInputProject(orchestrator, input);
    snapshot = await orchestrator.startLoop(snapshot.project.id);

    expect(snapshot.project.currentStep).toBe(ResearchLoopStep.ExecuteTools);
    expect(snapshot.project.status).toBe("failed");
    expect(snapshot.stepErrors.at(-1)?.step).toBe(ResearchLoopStep.ExecuteTools);
    expect(snapshot.openCodeRuns).toHaveLength(1);
    expect(snapshot.openCodeRuns[0]).toMatchObject({
      iteration: 1,
      status: "failed"
    });
    expect(snapshot.openCodeRuns[0]?.prompt).toContain(input.topic);
    expect(snapshot.openCodeRuns[0]?.metadata?.executionBundleId).toBeDefined();
    expect(snapshot.openCodeRuns[0]?.metadata?.error).toBe("configured OpenCode execution failed");
    expect(snapshot.finalOutputs).toHaveLength(0);
  });

  it("preserves pre-OpenCode acquisition outputs when the OpenCode attempt fails", async () => {
    const orchestrator = createStrictTestOrchestrator({
      openCode: failingAdapter(),
      llm: new MetadataFirstPlanner(),
      toolRunner: new ToolRunner([metadataAcquisitionTool]),
      settings: {
        ...strictTestSettings,
        allowExternalSearch: true
      }
    });
    let snapshot = await createInputProject(orchestrator, {
      ...input,
      autonomyPolicy: {
        ...input.autonomyPolicy,
        allowExternalSearch: true
      }
    });
    snapshot = await orchestrator.startLoop(snapshot.project.id);

    const failedRun = snapshot.openCodeRuns[0];
    const bundleId = failedRun?.metadata?.executionBundleId;

    expect(snapshot.project.status).toBe("failed");
    expect(failedRun?.status).toBe("failed");
    expect(bundleId).toBeDefined();
    expect(snapshot.toolRuns.some((toolRun) => toolRun.id === "tool-openalex-test" && toolRun.status === "completed")).toBe(true);
    expect(snapshot.sources.some((source) => source.id === "source-openalex-test" && source.metadata.executionBundleId === bundleId)).toBe(true);
    expect(snapshot.evidence.some((evidence) => evidence.id === "evidence-openalex-test" && evidence.metadata?.executionBundleId === bundleId)).toBe(true);
  });

  it("feeds OpenCode source candidates into WebFetchTool during the same iteration", async () => {
    const orchestrator = createStrictTestOrchestrator({
      openCode: sourceCandidateAdapter(),
      llm: new FetchOnlyPlanner(),
      toolRunner: new ToolRunner([new WebFetchTool()]),
      settings: {
        ...strictTestSettings,
        allowExternalSearch: true,
        webSearch: { provider: "custom", apiKey: "test-key", endpoint: "https://search.example.test" }
      }
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => ({
        ok: true,
        status: 200,
        statusText: "OK",
        url,
        headers: new Headers({ "content-type": "text/html" }),
        text: async () => "<html><title>Fetched OpenCode source</title><body>OpenCode candidate became fetched evidence.</body></html>"
      }))
    );

    let snapshot = await createInputProject(orchestrator, { ...input, autonomyPolicy: { ...input.autonomyPolicy, allowExternalSearch: true } });
    snapshot = await orchestrator.createResearchDb(snapshot.project.id);
    snapshot = await orchestrator.buildResearchSpecification(snapshot.project.id);
    snapshot = await orchestrator.planResearch(snapshot.project.id, 1);
    snapshot = await orchestrator.executeTools(snapshot.project.id, 1);

    expect(snapshot.project.status).not.toBe("failed");
    expect(snapshot.openCodeRuns).toHaveLength(1);
    expect(snapshot.toolRuns.some((run) => run.toolName === "WebFetchTool" && run.status === "completed")).toBe(true);
    expect(snapshot.sources.some((item) => item.url === "https://example.edu/opencode-source" && item.metadata.fetchStatus === "fetched")).toBe(true);
    expect(snapshot.evidence.some((item) => item.sourceUri === "https://example.edu/opencode-source")).toBe(true);
  });

  it("dedupes duplicate OpenCode sources and source candidates before persistence", async () => {
    const orchestrator = createStrictTestOrchestrator({
      openCode: duplicateSourceAdapter(),
      llm: new DuplicateSourcePlanner(),
      toolRunner: new ToolRunner([])
    });
    let snapshot = await createInputProject(orchestrator, input);
    snapshot = await orchestrator.createResearchDb(snapshot.project.id);
    snapshot = await orchestrator.buildResearchSpecification(snapshot.project.id);
    snapshot = await orchestrator.planResearch(snapshot.project.id, 1);
    snapshot = await orchestrator.executeTools(snapshot.project.id, 1);

    const duplicates = snapshot.sources.filter((source) => source.url?.startsWith("https://example.edu/duplicate-source"));
    expect(duplicates).toHaveLength(1);
    expect(duplicates[0]?.metadata.sourceCandidateOnly).toBe(true);
  });

  it("passes snapshot analysis arrays into auxiliary tool inputs", async () => {
    const orchestrator = createStrictTestOrchestrator({
      openCode: completedAdapter(),
      llm: new CaptureInputPlanner(),
      toolRunner: new ToolRunner([captureInputTool()])
    });
    let snapshot = await createInputProject(orchestrator, input);
    snapshot = await orchestrator.createResearchDb(snapshot.project.id);
    snapshot = await orchestrator.buildResearchSpecification(snapshot.project.id);
    snapshot = await orchestrator.planResearch(snapshot.project.id, 1);
    snapshot = await orchestrator.executeTools(snapshot.project.id, 1);

    expect(snapshot.toolRuns.find((run) => run.toolName === "CaptureInputTool")?.output).toMatchObject({
      hasNormalizedRecords: true,
      hasValidationResults: true,
      hasProjectContextSnapshots: true,
      hasResults: true
    });
  });

  it("persists completed and failed auxiliary tool output before marking ExecuteTools failed", async () => {
    const orchestrator = createStrictTestOrchestrator({
      openCode: completedAdapter(),
      llm: new PartialFailurePlanner(),
      toolRunner: new ToolRunner([partialSuccessTool(), partialFailureTool()])
    });
    let snapshot = await createInputProject(orchestrator, input);
    snapshot = await orchestrator.createResearchDb(snapshot.project.id);
    snapshot = await orchestrator.buildResearchSpecification(snapshot.project.id);
    snapshot = await orchestrator.planResearch(snapshot.project.id, 1);
    snapshot = await orchestrator.executeTools(snapshot.project.id, 1);

    expect(snapshot.project.status).toBe("failed");
    expect(snapshot.project.currentStep).toBe(ResearchLoopStep.ExecuteTools);
    expect(snapshot.openCodeRuns).toHaveLength(1);
    expect(snapshot.sources.some((source) => source.id === "partial-source-1")).toBe(true);
    expect(snapshot.toolRuns.some((run) => run.id === "partial-tool-1" && run.status === "completed")).toBe(true);
    expect(snapshot.toolRuns.some((run) => run.id === "partial-tool-2" && run.status === "failed")).toBe(true);
    expect(snapshot.toolRuns.find((run) => run.id === "partial-tool-2")?.output).toMatchObject({
      executionBundleId: snapshot.openCodeRuns[0]?.metadata?.executionBundleId
    });

    snapshot = await orchestrator.executeTools(snapshot.project.id, 1);
    expect(snapshot.toolRuns.filter((run) => run.id === "partial-tool-1")).toHaveLength(1);
    expect(snapshot.toolRuns.filter((run) => run.id === "partial-tool-2")).toHaveLength(1);
    expect(snapshot.sources.filter((source) => source.id === "partial-source-1")).toHaveLength(1);
  });

  it("persists a synthetic failed tool run when an auxiliary tool throws", async () => {
    const orchestrator = createStrictTestOrchestrator({
      openCode: completedAdapter(),
      llm: new ThrowingToolPlanner(),
      toolRunner: new ToolRunner([partialSuccessTool(), throwingTool()])
    });
    let snapshot = await createInputProject(orchestrator, input);
    snapshot = await orchestrator.createResearchDb(snapshot.project.id);
    snapshot = await orchestrator.buildResearchSpecification(snapshot.project.id);
    snapshot = await orchestrator.planResearch(snapshot.project.id, 1);
    snapshot = await orchestrator.executeTools(snapshot.project.id, 1);

    expect(snapshot.project.status).toBe("failed");
    expect(snapshot.sources.some((source) => source.id === "partial-source-1")).toBe(true);
    expect(snapshot.toolRuns.some((run) => run.id === "partial-tool-1" && run.status === "completed")).toBe(true);
    expect(snapshot.toolRuns.some((run) => run.toolName === "ThrowingTool" && run.status === "failed" && run.error === "synthetic throw")).toBe(true);
  });

  it("does not finalize when paused or aborted during a loop", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "aetherops-control-"));
    let orchestrator = createStrictTestOrchestrator({
      storage: new NodeProjectStorage(),
      projectRootBase: join(tempDir, "projects"),
      openCode: pausingAdapter(() => orchestrator)
    });

    let snapshot = await createInputProject(orchestrator, input);
    snapshot = await orchestrator.startLoop(snapshot.project.id);
    expect(snapshot.project.status).toBe("paused");
    expect(snapshot.project.currentStep).not.toBe(ResearchLoopStep.FinalizeOutputs);
    expect(snapshot.report).toBeUndefined();

    let abortingOrchestrator = createStrictTestOrchestrator({
      storage: new NodeProjectStorage(),
      projectRootBase: join(tempDir, "abort-projects"),
      openCode: abortingAdapter(() => abortingOrchestrator)
    });
    snapshot = await createInputProject(abortingOrchestrator, input);
    snapshot = await abortingOrchestrator.startLoop(snapshot.project.id);
    expect(snapshot.project.status).toBe("aborted");
    expect(snapshot.project.status).not.toBe("completed");
    expect(snapshot.report).toBeUndefined();
  });
});

class UnregisteredToolPlanner extends DeterministicLlmProvider {
  override async completeJson<T>(request: LlmJsonRequest): Promise<T> {
    if (request.schemaName === "AetherOpsResearchPlan") {
      return {
        objective: "Request an unavailable tool.",
        targetQuestions: ["q1"],
        targetHypotheses: ["h1"],
        requiredTools: ["OpenCodeTool", "UnavailableTool"],
        expectedSources: ["tool log"],
        expectedArtifacts: ["research-note.md"],
        executionSteps: ["Run unavailable tool"],
        stopCriteria: ["blocked when unavailable"]
      } as T;
    }
    return super.completeJson<T>(request);
  }
}

class FetchOnlyPlanner extends DeterministicLlmProvider {
  override async completeJson<T>(request: LlmJsonRequest): Promise<T> {
    if (request.schemaName === "AetherOpsResearchPlan") {
      return {
        objective: "Fetch OpenCode-discovered web sources.",
        targetQuestions: ["q1"],
        targetHypotheses: ["h1"],
        requiredTools: ["OpenCodeTool", "WebFetchTool"],
        expectedSources: ["web"],
        expectedArtifacts: ["tool log"],
        executionSteps: ["Run OpenCodeTool", "Fetch discovered source URL"],
        stopCriteria: ["citation-backed evidence exists"]
      } as T;
    }
    return super.completeJson<T>(request);
  }
}

class DuplicateSourcePlanner extends DeterministicLlmProvider {
  override async completeJson<T>(request: LlmJsonRequest): Promise<T> {
    if (request.schemaName === "AetherOpsResearchPlan") {
      return {
        objective: "Persist OpenCode source candidates without duplicate rows.",
        targetQuestions: ["q1"],
        targetHypotheses: ["h1"],
        requiredTools: ["OpenCodeTool"],
        expectedSources: ["web"],
        expectedArtifacts: ["tool log"],
        executionSteps: ["Run OpenCodeTool"],
        stopCriteria: ["source candidate persisted once"]
      } as T;
    }
    return super.completeJson<T>(request);
  }
}

class CaptureInputPlanner extends DeterministicLlmProvider {
  override async completeJson<T>(request: LlmJsonRequest): Promise<T> {
    if (request.schemaName === "AetherOpsResearchPlan") {
      return {
        objective: "Capture auxiliary tool input arrays.",
        targetQuestions: ["q1"],
        targetHypotheses: ["h1"],
        requiredTools: ["OpenCodeTool", "CaptureInputTool"],
        expectedSources: ["tool log"],
        expectedArtifacts: ["tool log"],
        executionSteps: ["Run capture tool"],
        stopCriteria: ["input arrays observed"]
      } as T;
    }
    return super.completeJson<T>(request);
  }
}

class PartialFailurePlanner extends DeterministicLlmProvider {
  override async completeJson<T>(request: LlmJsonRequest): Promise<T> {
    if (request.schemaName === "AetherOpsResearchPlan") {
      return {
        objective: "Run one successful auxiliary tool before a failing one.",
        targetQuestions: ["q1"],
        targetHypotheses: ["h1"],
        requiredTools: ["OpenCodeTool", "PartialSuccessTool", "PartialFailureTool"],
        expectedSources: ["tool source"],
        expectedArtifacts: ["tool log"],
        executionSteps: ["Run partial success", "Run partial failure"],
        stopCriteria: ["failure is recorded"]
      } as T;
    }
    return super.completeJson<T>(request);
  }
}

class ThrowingToolPlanner extends DeterministicLlmProvider {
  override async completeJson<T>(request: LlmJsonRequest): Promise<T> {
    if (request.schemaName === "AetherOpsResearchPlan") {
      return {
        objective: "Run one successful auxiliary tool before a thrown failure.",
        targetQuestions: ["q1"],
        targetHypotheses: ["h1"],
        requiredTools: ["OpenCodeTool", "PartialSuccessTool", "ThrowingTool"],
        expectedSources: ["tool source"],
        expectedArtifacts: ["tool log"],
        executionSteps: ["Run partial success", "Throw"],
        stopCriteria: ["failure is recorded"]
      } as T;
    }
    return super.completeJson<T>(request);
  }
}

function failingAdapter(): OpenCodeAdapter {
  return {
    run: async () => {
      throw new Error("configured OpenCode execution failed");
    }
  };
}

function sourceCandidateAdapter(): OpenCodeAdapter {
  return {
    run: async (runInput: OpenCodeRunInput): Promise<OpenCodeRunOutput> => ({
      ...completedOutput(runInput, "source-candidate", nowIso()),
      sourceCandidates: [
        {
          id: "opencode-source-1",
          projectId: runInput.project.id,
          kind: "web",
          title: "OpenCode source candidate",
          url: "https://example.edu/opencode-source",
          retrievedAt: nowIso(),
          metadata: { provider: "opencode" },
          createdAt: nowIso()
        }
      ]
    })
  };
}

function duplicateSourceAdapter(): OpenCodeAdapter {
  return {
    run: async (runInput: OpenCodeRunInput): Promise<OpenCodeRunOutput> => ({
      ...completedOutput(runInput, "duplicate-source", nowIso()),
      sources: [
        {
          id: "duplicate-source-primary",
          projectId: runInput.project.id,
          kind: "web",
          title: "Duplicate source",
          url: "https://example.edu/duplicate-source#first",
          retrievedAt: nowIso(),
          metadata: {},
          createdAt: nowIso()
        }
      ],
      sourceCandidates: [
        {
          id: "duplicate-source-candidate",
          projectId: runInput.project.id,
          kind: "web",
          title: "Duplicate source candidate",
          url: "https://example.edu/duplicate-source",
          retrievedAt: nowIso(),
          metadata: { sourceCandidateOnly: true },
          createdAt: nowIso()
        }
      ]
    })
  };
}

function completedAdapter(): OpenCodeAdapter {
  return {
    run: async (runInput: OpenCodeRunInput): Promise<OpenCodeRunOutput> => completedOutput(runInput, "completed", nowIso())
  };
}

function partialSuccessTool(): ResearchTool {
  return {
    name: "PartialSuccessTool",
    run: async (input: OpenCodeRunInput): Promise<ResearchToolResult> => ({
      toolRun: { id: "partial-tool-1", projectId: input.project.id, iteration: input.iteration, toolName: "PartialSuccessTool", input: {}, output: {}, status: "completed", startedAt: nowIso(), completedAt: nowIso() },
      evidence: [],
      artifacts: [],
      sources: [{ id: "partial-source-1", projectId: input.project.id, kind: "web", title: "Partial source", url: "https://example.edu/partial", retrievedAt: nowIso(), metadata: {}, createdAt: nowIso() }]
    })
  };
}

function partialFailureTool(): ResearchTool {
  return {
    name: "PartialFailureTool",
    run: async (input: OpenCodeRunInput): Promise<ResearchToolResult> => ({
      toolRun: { id: "partial-tool-2", projectId: input.project.id, iteration: input.iteration, toolName: "PartialFailureTool", input: {}, output: { reason: "failed after partial output" }, status: "failed", error: "failed after partial output", startedAt: nowIso(), completedAt: nowIso() },
      evidence: [],
      artifacts: [],
      sources: []
    })
  };
}

function throwingTool(): ResearchTool {
  return {
    name: "ThrowingTool",
    run: async () => {
      throw new Error("synthetic throw");
    }
  };
}

function captureInputTool(): ResearchTool {
  return {
    name: "CaptureInputTool",
    run: async (input: OpenCodeRunInput): Promise<ResearchToolResult> => ({
      toolRun: {
        id: "capture-input-tool",
        projectId: input.project.id,
        iteration: input.iteration,
        toolName: "CaptureInputTool",
        input: {},
        output: {
          hasNormalizedRecords: Array.isArray(input.normalizedRecords),
          hasValidationResults: Array.isArray(input.validationResults),
          hasProjectContextSnapshots: Array.isArray(input.projectContextSnapshots),
          hasResults: Array.isArray(input.results)
        },
        status: "completed",
        startedAt: nowIso(),
        completedAt: nowIso()
      },
      evidence: [],
      artifacts: [],
      sources: []
    })
  };
}

function pausingAdapter(orchestrator: () => { pause(projectId: string): Promise<unknown> }): OpenCodeAdapter {
  return {
    run: async (runInput: OpenCodeRunInput): Promise<OpenCodeRunOutput> => {
      await orchestrator().pause(runInput.project.id);
      return completedOutput(runInput, "pause-test", nowIso());
    }
  };
}

function abortingAdapter(orchestrator: () => { abort(projectId: string): Promise<unknown> }): OpenCodeAdapter {
  return {
    run: async (runInput: OpenCodeRunInput): Promise<OpenCodeRunOutput> => {
      await orchestrator().abort(runInput.project.id);
      return completedOutput(runInput, "abort-test", nowIso());
    }
  };
}

function completedOutput(input: OpenCodeRunInput, planName: string, createdAt: string): OpenCodeRunOutput {
  return {
    run: {
      id: `opencode-${planName}`,
      projectId: input.project.id,
      iteration: input.iteration,
      prompt: planName,
      toolPlan: [planName],
      status: "completed",
      logs: [`${planName} during adapter`],
      artifactIds: [],
      evidenceIds: [],
      startedAt: createdAt,
      completedAt: createdAt
    },
    artifacts: [],
    evidence: []
  };
}
