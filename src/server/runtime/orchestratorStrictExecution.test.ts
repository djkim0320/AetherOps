import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createId, nowIso } from "../../core/ids.js";
import { InMemoryResearchStore } from "../../core/memoryStore.js";
import { AetherOpsOrchestrator } from "../../core/orchestrator.js";
import {
  ResearchLoopStep,
  type AppSettings,
  type EvidenceItem,
  type OpenCodeAdapter,
  type OpenCodeRunInput,
  type OpenCodeRunOutput,
  type ResearchProjectInput
} from "../../core/types.js";
import { NodeProjectStorage } from "./projectResearchStore.js";

let tempDir: string | undefined;

const settings: AppSettings = {
  openCodeLlm: {
    source: "codex-oauth",
    model: "gpt-5.5"
  },
  openCode: {
    enabled: false,
    command: "opencode",
    provider: "openai",
    model: "gpt-5.5",
    timeoutMs: 180_000
  },
  webSearch: {
    provider: "disabled"
  },
  embedding: {
    provider: "local",
    model: "local-hash",
    dimensions: 96
  },
  browserUse: {
    enabled: false,
    mode: "background",
    maxPages: 2,
    timeoutMs: 30_000,
    captureScreenshots: false
  },
  allowExternalSearch: true,
  allowCodeExecution: false,
  maxLoopIterations: 2,
  updatedAt: "2026-05-14T00:00:00.000Z"
};

const input: ResearchProjectInput = {
  goal: "Compare Pomodoro 25/5 and 50/10 for a two-hour study session.",
  topic: "Pomodoro 25/5 vs 50/10",
  scope: "Use traceable evidence or explicit evidence gaps; no code execution.",
  budget: "30 minutes",
  autonomyPolicy: {
    toolApproval: "suggested",
    maxLoopIterations: 2,
    allowExternalSearch: true,
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
  it("seeds questions, hypotheses, and evidence", async () => {
    const orchestrator = new AetherOpsOrchestrator(new InMemoryResearchStore());
    let snapshot = await orchestrator.createProject(input);
    snapshot = await orchestrator.createResearchDb(snapshot.project.id);
    snapshot = await orchestrator.seedQuestions(snapshot.project.id);

    expect(snapshot.questions.length).toBeGreaterThanOrEqual(3);
    expect(snapshot.hypotheses.length).toBeGreaterThanOrEqual(2);
    expect(snapshot.evidence.length).toBeGreaterThanOrEqual(2);
  });

  it("fails clearly when the OpenCode execution engine is unavailable", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "aetherops-loop-"));
    const failingAdapter = new FailingOpenCodeAdapter();
    const orchestrator = new AetherOpsOrchestrator(
      new InMemoryResearchStore(),
      failingAdapter,
      undefined,
      join(tempDir, "projects"),
      undefined,
      new NodeProjectStorage(),
      undefined,
      async () => settings
    );

    let snapshot = await orchestrator.createProject(input);
    snapshot = await orchestrator.startLoop(snapshot.project.id);

    expect(snapshot.project.currentStep).toBe(ResearchLoopStep.ExecuteTools);
    expect(snapshot.project.status).toBe("failed");
    expect(snapshot.openCodeRuns).toHaveLength(1);
    expect(snapshot.openCodeRuns[0]?.status).toBe("failed");
    expect(snapshot.evidence.some((item) => item.keywords.includes("tool_unavailable") || item.keywords.includes("evidence_gap"))).toBe(true);
    expect(snapshot.report).toBeUndefined();
    expect(snapshot.finalOutputs).toHaveLength(0);
    expect(existsSync(join(snapshot.project.projectRoot, "reports", "final-report.md"))).toBe(false);
  });

  it("does not finalize when paused or aborted during a loop", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "aetherops-control-"));
    let orchestrator: AetherOpsOrchestrator;
    const pausingAdapter: OpenCodeAdapter = {
      run: async (runInput: OpenCodeRunInput): Promise<OpenCodeRunOutput> => {
        await orchestrator.pause(runInput.project.id);
        const createdAt = nowIso();
        return completedOutput(runInput, "pause-test", createdAt);
      }
    };
    orchestrator = new AetherOpsOrchestrator(
      new InMemoryResearchStore(),
      pausingAdapter,
      undefined,
      join(tempDir, "projects"),
      undefined,
      new NodeProjectStorage()
    );

    let snapshot = await orchestrator.createProject(input);
    snapshot = await orchestrator.startLoop(snapshot.project.id);
    expect(snapshot.project.status).toBe("paused");
    expect(snapshot.project.currentStep).not.toBe(ResearchLoopStep.FinalizeOutputs);
    expect(snapshot.report).toBeUndefined();

    let abortingOrchestrator: AetherOpsOrchestrator;
    const abortingAdapter: OpenCodeAdapter = {
      run: async (runInput: OpenCodeRunInput): Promise<OpenCodeRunOutput> => {
        await abortingOrchestrator.abort(runInput.project.id);
        const createdAt = nowIso();
        return completedOutput(runInput, "abort-test", createdAt);
      }
    };
    abortingOrchestrator = new AetherOpsOrchestrator(
      new InMemoryResearchStore(),
      abortingAdapter,
      undefined,
      join(tempDir, "abort-projects"),
      undefined,
      new NodeProjectStorage()
    );
    snapshot = await abortingOrchestrator.createProject(input);
    snapshot = await abortingOrchestrator.startLoop(snapshot.project.id);
    expect(snapshot.project.status).toBe("aborted");
    expect(snapshot.project.status).not.toBe("completed");
    expect(snapshot.report).toBeUndefined();
  });
});

class FailingOpenCodeAdapter implements OpenCodeAdapter {
  async run(input: OpenCodeRunInput): Promise<OpenCodeRunOutput> {
    const createdAt = nowIso();
    const gap: EvidenceItem = {
      id: createId("evidence"),
      projectId: input.project.id,
      category: "experiment_log",
      title: "tool_unavailable: OpenCode CLI",
      summary: "OpenCode CLI is unavailable. No alternate execution path is used.",
      keywords: ["tool_unavailable", "evidence_gap", "opencode"],
      linkedHypothesisIds: [],
      reliabilityScore: 0.1,
      relevanceScore: 0.5,
      evidenceStrength: "weak",
      limitations: ["No real OpenCode execution was performed."],
      createdAt
    };
    return {
      run: {
        id: createId("opencode"),
        projectId: input.project.id,
        iteration: input.iteration,
        prompt: "opencode-required",
        toolPlan: ["opencode-cli"],
        status: "failed",
        logs: ["OpenCode CLI is unavailable.", "No alternate execution path is configured."],
        artifactIds: [],
        evidenceIds: [gap.id],
        startedAt: createdAt,
        completedAt: createdAt
      },
      artifacts: [],
      evidence: [gap],
      fatalError: "OpenCode CLI is unavailable."
    };
  }
}

function completedOutput(input: OpenCodeRunInput, planName: string, createdAt: string): OpenCodeRunOutput {
  return {
    run: {
      id: createId("opencode"),
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
