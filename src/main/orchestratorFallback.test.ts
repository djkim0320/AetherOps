import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createId, nowIso } from "../core/ids.js";
import { LocalResearchAdapter } from "../core/localResearchAdapter.js";
import { InMemoryResearchStore } from "../core/memoryStore.js";
import { AetherOpsOrchestrator } from "../core/orchestrator.js";
import { ResearchLoopStep, type AppSettings, type CreateProjectInput, type OpenCodeAdapter, type OpenCodeRunInput, type OpenCodeRunOutput } from "../core/types.js";
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
  allowExternalSearch: true,
  allowCodeExecution: false,
  maxLoopIterations: 2,
  updatedAt: "2026-05-14T00:00:00.000Z"
};

const input: CreateProjectInput = {
  goal: "포모도로 25/5와 50/10을 2시간 공부 조건에서 근거 기반으로 비교한다.",
  topic: "Pomodoro 25/5 vs 50/10",
  scope: "공개 근거 3~5개 또는 evidence_gap, 미니 실험 설계, 집중도/피로도/완료량 지표",
  budget: "30분 이내",
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

describe("AetherOps fallback loop", () => {
  it("seeds questions, hypotheses, and evidence", async () => {
    const orchestrator = new AetherOpsOrchestrator(new InMemoryResearchStore());
    let snapshot = await orchestrator.createProject(input);
    snapshot = await orchestrator.createResearchDb(snapshot.project.id);
    snapshot = await orchestrator.seedQuestions(snapshot.project.id);

    expect(snapshot.questions.length).toBeGreaterThanOrEqual(3);
    expect(snapshot.hypotheses.length).toBeGreaterThanOrEqual(2);
    expect(snapshot.evidence.length).toBeGreaterThanOrEqual(2);
  });

  it("runs maxLoopIterations with LocalResearchAdapter and writes outputs", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "aetherops-loop-"));
    const orchestrator = new AetherOpsOrchestrator(
      new InMemoryResearchStore(),
      new LocalResearchAdapter(() => settings),
      undefined,
      join(tempDir, "projects"),
      undefined,
      new NodeProjectStorage()
    );

    let snapshot = await orchestrator.createProject(input);
    snapshot = await orchestrator.startLoop(snapshot.project.id);

    expect(snapshot.project.currentStep).toBe(ResearchLoopStep.FinalizeResearchOutputs);
    expect(snapshot.project.status).toBe("completed");
    expect(snapshot.openCodeRuns).toHaveLength(2);
    expect(snapshot.toolRuns.length).toBeGreaterThan(0);
    expect(snapshot.artifacts.length).toBeGreaterThanOrEqual(2);
    expect(snapshot.ragContexts.length).toBeGreaterThan(0);
    expect(snapshot.results.length).toBeGreaterThan(0);
    expect(snapshot.report).toBeDefined();
    expect(existsSync(join(snapshot.project.projectRoot, "artifacts", "iteration-1"))).toBe(true);
    expect(existsSync(join(snapshot.project.projectRoot, "artifacts", "iteration-2"))).toBe(true);
    expect(existsSync(join(snapshot.project.projectRoot, "reports", "final-report.md"))).toBe(true);
    expect(existsSync(join(snapshot.project.projectRoot, "knowledge", "reusable-knowledge.md"))).toBe(true);
  });

  it("does not finalize when paused or aborted during a loop", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "aetherops-control-"));
    let orchestrator: AetherOpsOrchestrator;
    const pausingAdapter: OpenCodeAdapter = {
      run: async (runInput: OpenCodeRunInput): Promise<OpenCodeRunOutput> => {
        await orchestrator.pause(runInput.project.id);
        const createdAt = nowIso();
        return emptyOutput(runInput, "pause-test", createdAt);
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
    expect(snapshot.project.currentStep).not.toBe(ResearchLoopStep.FinalizeResearchOutputs);
    expect(snapshot.report).toBeUndefined();

    let abortingOrchestrator: AetherOpsOrchestrator;
    const abortingAdapter: OpenCodeAdapter = {
      run: async (runInput: OpenCodeRunInput): Promise<OpenCodeRunOutput> => {
        await abortingOrchestrator.abort(runInput.project.id);
        const createdAt = nowIso();
        return emptyOutput(runInput, "abort-test", createdAt);
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

function emptyOutput(input: OpenCodeRunInput, planName: string, createdAt: string): OpenCodeRunOutput {
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
