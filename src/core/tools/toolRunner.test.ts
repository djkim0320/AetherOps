import { describe, expect, it } from "vitest";
import { ResearchLoopStep, type AppSettings, type OpenCodeRunInput } from "../shared/types.js";
import type { ResearchTool } from "./researchToolTypes.js";
import { orderToolNames, ToolRunner, ToolRunnerError } from "./toolRunner.js";

const createdAt = "2026-07-10T00:00:00.000Z";
const settings: AppSettings = {
  openCodeLlm: { source: "codex-oauth", model: "gpt-5.6", reasoningEffort: "xhigh", timeoutMs: 180_000 },
  openCode: { enabled: false, command: "", timeoutMs: 1_000 },
  webSearch: { provider: "disabled" },
  embedding: { provider: "local", model: "none", dimensions: 0 },
  browserUse: { enabled: false, mode: "background", maxPages: 1, timeoutMs: 1_000, captureScreenshots: false },
  researchMetadata: { enabled: false, provider: "openalex", maxResults: 1, timeoutMs: 1_000 },
  engineeringTools: {
    enabled: false,
    xfoil: { enabled: false, command: "", timeoutMs: 1_000 },
    modeling: { enabled: false, artifactRoot: "", maxMeshBytes: 1_024 },
    su2: { enabled: false, command: "", caseRoot: "", configFile: "", workingDirectory: "", probeArgs: [], runArgsTemplate: [], timeoutMs: 1_000 },
    openVsp: { enabled: false, command: "", scriptPath: "", workingDirectory: "", probeArgs: [], runArgsTemplate: [], timeoutMs: 1_000 },
    xflr5: { enabled: false, command: "", scriptPath: "", workingDirectory: "", probeArgs: [], runArgsTemplate: [], timeoutMs: 1_000 }
  },
  allowExternalSearch: false,
  allowCodeExecution: false,
  updatedAt: createdAt
};

function input(requiredTools: string[]): OpenCodeRunInput {
  return {
    project: {
      id: "project-1",
      goal: "Verify deterministic tool execution.",
      topic: "tool scheduling",
      scope: "core only",
      budget: "one minute",
      autonomyPolicy: { toolApproval: "suggested", allowExternalSearch: false, allowCodeExecution: false },
      createdAt,
      updatedAt: createdAt,
      currentStep: ResearchLoopStep.ExecuteTools,
      status: "running",
      projectRoot: ".aetherops/test"
    },
    questions: [],
    hypotheses: [],
    evidence: [],
    sources: [],
    artifacts: [],
    iteration: 1,
    researchPlan: {
      id: "plan-1",
      projectId: "project-1",
      iteration: 1,
      objective: "Execute tools.",
      targetQuestions: [],
      targetHypotheses: [],
      requiredTools,
      expectedSources: [],
      expectedArtifacts: [],
      executionSteps: [],
      stopCriteria: [],
      createdAt
    }
  };
}

function completedTool(name: string, calls: string[]): ResearchTool {
  return {
    name,
    run: async (rollingInput) => {
      calls.push(name);
      return {
        toolRun: {
          id: `run-${name}`,
          projectId: rollingInput.project.id,
          iteration: rollingInput.iteration,
          toolName: name,
          input: {},
          output: { calls: [...calls] },
          status: "completed",
          startedAt: createdAt,
          completedAt: createdAt
        },
        evidence: [],
        artifacts: [],
        sources: []
      };
    }
  };
}

describe("ToolRunner core contract", () => {
  it("uses canonical ordering independent of requested order", async () => {
    const calls: string[] = [];
    const runner = new ToolRunner([completedTool("DataAnalysisTool", calls), completedTool("ArtifactWriterTool", calls), completedTool("WebFetchTool", calls)]);

    await runner.runAll(input(["DataAnalysisTool", "WebFetchTool", "ArtifactWriterTool"]), settings);

    expect(calls).toEqual(orderToolNames(["DataAnalysisTool", "WebFetchTool", "ArtifactWriterTool"]));
  });

  it("fails closed for an unregistered required tool", async () => {
    await expect(new ToolRunner([]).runAll(input(["RemovedLegacyTool"]), settings)).rejects.toMatchObject({
      name: "ToolRunnerError",
      toolName: "removedlegacytool"
    } satisfies Partial<ToolRunnerError>);
  });
});
