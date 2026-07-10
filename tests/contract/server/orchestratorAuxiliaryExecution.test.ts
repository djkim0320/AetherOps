import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { nowIso } from "../../../src/core/shared/ids.js";
import {
  createInputProject,
  createStrictTestOrchestrator,
  DeterministicLlmProvider,
  strictTestSettings
} from "../../../src/core/testing/orchestratorTestHarness.js";
import type { LlmJsonRequest } from "../../../src/core/providers/llm.js";
import { ToolRunner } from "../../../src/core/tools/toolRunner.js";
import { WebFetchTool } from "../../../src/server/runtime/tools/webFetchTool.js";
import type { ResearchTool, ResearchToolResult } from "../../../src/core/tools/researchToolTypes.js";
import {
  ResearchLoopStep,
  type OpenCodeAdapter,
  type OpenCodeRunInput,
  type OpenCodeRunOutput,
  type ResearchProjectInput
} from "../../../src/core/shared/types.js";
import { NodeProjectStorage } from "../../../src/server/runtime/storage/projectResearchStore.js";

let tempDir: string | undefined;
const input: ResearchProjectInput = {
  goal: "Compare Pomodoro 25/5 and 50/10 for a two-hour study session.",
  topic: "Pomodoro 25/5 vs 50/10",
  scope: "Use traceable evidence; no code execution.",
  budget: "30 minutes",
  autonomyPolicy: { toolApproval: "suggested", allowExternalSearch: false, allowCodeExecution: false }
};

afterEach(() => {
  vi.unstubAllGlobals();
  if (tempDir && existsSync(tempDir)) rmSync(tempDir, { recursive: true, force: true });
  tempDir = undefined;
});

describe("AetherOps strict auxiliary execution", () => {
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

  it("persists a synthetic failed tool run and rejects malformed nested evidence", async () => {
    const orchestrator = createStrictTestOrchestrator({
      openCode: completedAdapter(),
      llm: new MalformedToolPlanner(),
      toolRunner: new ToolRunner([partialSuccessTool(), malformedTool()])
    });
    let snapshot = await createInputProject(orchestrator, input);
    snapshot = await orchestrator.createResearchDb(snapshot.project.id);
    snapshot = await orchestrator.buildResearchSpecification(snapshot.project.id);
    snapshot = await orchestrator.planResearch(snapshot.project.id, 1);
    snapshot = await orchestrator.executeTools(snapshot.project.id, 1);

    expect(snapshot.project.status).toBe("failed");
    expect(snapshot.sources.some((source) => source.id === "partial-source-1")).toBe(true);
    expect(snapshot.evidence.some((evidence) => evidence.id === "malformed-evidence")).toBe(false);
    const malformedRun = snapshot.toolRuns.find((run) => run.toolName === "MalformedTool");
    expect(malformedRun).toMatchObject({
      status: "failed",
      error: "evidence[0].keywords must be a string array",
      output: {
        failureKind: "malformed_tool_result",
        evidenceFailure: true
      }
    });
  });

  it("does not finalize when paused or aborted during a loop", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "aetherops-control-"));
    const orchestrator = createStrictTestOrchestrator({
      storage: new NodeProjectStorage(),
      projectRootBase: join(tempDir, "projects"),
      openCode: pausingAdapter(() => orchestrator)
    });

    let snapshot = await createInputProject(orchestrator, input);
    snapshot = await orchestrator.startLoop(snapshot.project.id);
    expect(snapshot.project.status).toBe("paused");
    expect(snapshot.project.currentStep).not.toBe(ResearchLoopStep.FinalizeOutputs);
    expect(snapshot.report).toBeUndefined();

    const abortingOrchestrator = createStrictTestOrchestrator({
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

class MalformedToolPlanner extends DeterministicLlmProvider {
  override async completeJson<T>(request: LlmJsonRequest): Promise<T> {
    if (request.schemaName === "AetherOpsResearchPlan") {
      return {
        objective: "Run one successful auxiliary tool before a malformed one.",
        targetQuestions: ["q1"],
        targetHypotheses: ["h1"],
        requiredTools: ["OpenCodeTool", "PartialSuccessTool", "MalformedTool"],
        expectedSources: ["tool source"],
        expectedArtifacts: ["tool log"],
        executionSteps: ["Run partial success", "Return malformed result"],
        stopCriteria: ["malformed result is recorded as failed"]
      } as T;
    }
    return super.completeJson<T>(request);
  }
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
      toolRun: {
        id: "partial-tool-1",
        projectId: input.project.id,
        iteration: input.iteration,
        toolName: "PartialSuccessTool",
        input: {},
        output: {},
        status: "completed",
        startedAt: nowIso(),
        completedAt: nowIso()
      },
      evidence: [],
      artifacts: [],
      sources: [
        {
          id: "partial-source-1",
          projectId: input.project.id,
          kind: "web",
          title: "Partial source",
          url: "https://example.edu/partial",
          retrievedAt: nowIso(),
          metadata: {},
          createdAt: nowIso()
        }
      ]
    })
  };
}

function partialFailureTool(): ResearchTool {
  return {
    name: "PartialFailureTool",
    run: async (input: OpenCodeRunInput): Promise<ResearchToolResult> => ({
      toolRun: {
        id: "partial-tool-2",
        projectId: input.project.id,
        iteration: input.iteration,
        toolName: "PartialFailureTool",
        input: {},
        output: { reason: "failed after partial output" },
        status: "failed",
        error: "failed after partial output",
        startedAt: nowIso(),
        completedAt: nowIso()
      },
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

function malformedTool(): ResearchTool {
  return {
    name: "MalformedTool",
    run: async (input: OpenCodeRunInput) =>
      ({
        toolRun: {
          id: "malformed-tool-run",
          projectId: input.project.id,
          iteration: input.iteration,
          toolName: "MalformedTool",
          input: {},
          output: {},
          status: "completed",
          startedAt: nowIso(),
          completedAt: nowIso()
        },
        evidence: [
          {
            id: "malformed-evidence",
            projectId: input.project.id,
            category: "web_source",
            title: "Malformed evidence",
            summary: "This should not be persisted.",
            createdAt: nowIso()
          }
        ],
        artifacts: [],
        sources: []
      }) as unknown as Promise<ResearchToolResult>
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
