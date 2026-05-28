import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { nowIso } from "../../core/ids.js";
import {
  createInputProject,
  createStrictTestOrchestrator,
  DeterministicLlmProvider,
  strictTestSettings
} from "../../core/orchestratorTestHarness.test.js";
import type { LlmJsonRequest } from "../../core/llm.js";
import { ToolRunner } from "../../core/toolRunner.js";
import { WebFetchTool, type ResearchTool, type ResearchToolResult } from "../../core/toolRegistry.js";
import { ResearchLoopStep, type OpenCodeAdapter, type OpenCodeRunInput, type OpenCodeRunOutput, type ResearchProjectInput } from "../../core/types.js";
import { NodeProjectStorage } from "./projectResearchStore.js";

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

afterEach(() => {
  if (tempDir) {
    rmSync(tempDir, { recursive: true, force: true });
    tempDir = undefined;
  }
});

describe("AetherOps strict execution loop", () => {
  it("blocks when explicit research input is missing", async () => {
    const orchestrator = createStrictTestOrchestrator();
    let snapshot = await orchestrator.createProject(input);
    snapshot = await orchestrator.seedQuestions(snapshot.project.id);

    expect(snapshot.project.currentStep).toBe(ResearchLoopStep.InputResearchQuestionHypothesis);
    expect(snapshot.project.status).toBe("blocked");
    expect(snapshot.runtimeBlockers.some((blocker) => blocker.requirementKey === "research_input")).toBe(true);
    expect(snapshot.questions).toHaveLength(0);
    expect(snapshot.finalOutputs).toHaveLength(0);
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
    expect(snapshot.finalOutputs).toHaveLength(0);
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
    expect(snapshot.toolRuns.find((run) => run.id === "partial-tool-2")?.output).toMatchObject({ executionBundleId: "execution-bundle:" + snapshot.project.id + ":1:opencode-completed" });

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
