import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { nowIso } from "../../core/ids.js";
import {
  createInputProject,
  createStrictTestOrchestrator,
  DeterministicLlmProvider,
  strictTestSettings
} from "../../core/orchestratorTestHarness.test.js";
import type { LlmJsonRequest } from "../../core/llm.js";
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

function failingAdapter(): OpenCodeAdapter {
  return {
    run: async () => {
      throw new Error("configured OpenCode execution failed");
    }
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
