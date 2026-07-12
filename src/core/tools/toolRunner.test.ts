import { describe, expect, it } from "vitest";
import { ResearchLoopStep, type AppSettings, type ResearchToolInput } from "../shared/types.js";
import type { ResearchTool, ToolExecutionStatusEvent } from "./researchToolTypes.js";
import { ToolRunner, ToolRunnerError } from "./toolRunner.js";

const createdAt = "2026-07-10T00:00:00.000Z";
const settings: AppSettings = {
  codex: { model: "gpt-5.6", reasoningEffort: "xhigh", timeoutMs: 180_000, taskTimeoutMs: 600_000 },
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
  allowAgent: true,
  allowExternalSearch: false,
  allowCodeExecution: false,
  updatedAt: createdAt
};

function input(requiredTools: string[]): ResearchToolInput {
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
      toolRequests: requiredTools.map((toolName, index) => ({
        intentId: `intent-${index}`,
        toolName,
        purpose: `Run ${toolName}.`,
        expectedOutcome: `${toolName} completes.`,
        inputs: toolInputs(toolName)
      })),
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

    await runner.execute(input(["DataAnalysisTool", "WebFetchTool", "ArtifactWriterTool"]), settings);

    expect(calls).toEqual(["WebFetchTool", "DataAnalysisTool", "ArtifactWriterTool"]);
  });

  it("fails closed for an unregistered required tool", async () => {
    await expect(new ToolRunner([]).execute(input(["RemovedLegacyTool"]), settings)).rejects.toMatchObject({
      name: "ToolRunnerError",
      toolName: "RemovedLegacyTool"
    } satisfies Partial<ToolRunnerError>);
  });

  it("rechecks the fixed job capability before every tool action", async () => {
    const calls: string[] = [];
    const runInput = input(["WebFetchTool"]);
    runInput.researchPlan = {
      ...runInput.researchPlan!,
      toolRequests: [
        {
          intentId: "fetch-1",
          toolName: "WebFetchTool",
          purpose: "Fetch the explicitly scoped source.",
          expectedOutcome: "One validated source response.",
          inputs: { urls: ["https://example.com/source"] }
        }
      ]
    };

    await expect(
      new ToolRunner([completedTool("WebFetchTool", calls)]).execute(runInput, settings, {
        execution: { effectiveCapabilities: { agent: true, engineering: false, search: false } }
      })
    ).rejects.toThrow(/denied by job capabilities: search/i);
    expect(calls).toEqual([]);
  });

  it("terminalizes every queued action when an upstream action fails", async () => {
    const events: ToolExecutionStatusEvent[] = [];
    const failing: ResearchTool = {
      name: "WebFetchTool",
      run: async () => {
        throw new Error("fetch failed");
      }
    };
    const runInput = input(["WebFetchTool", "DataAnalysisTool", "ArtifactWriterTool"]);

    await expect(
      new ToolRunner([failing, completedTool("DataAnalysisTool", []), completedTool("ArtifactWriterTool", [])]).execute(runInput, settings, {
        execution: {
          effectiveCapabilities: { agent: true, engineering: false, search: true },
          onStatus: (event) => {
            events.push(event);
          }
        }
      })
    ).rejects.toThrow("fetch failed");

    const terminalByTool = new Map(events.filter((event) => !["queued", "running"].includes(event.status)).map((event) => [event.toolName, event]));
    expect(terminalByTool.get("WebFetchTool")?.status).toBe("failed");
    expect(terminalByTool.get("DataAnalysisTool")).toMatchObject({ status: "blocked", terminalCause: "DEPENDENCY_FAILED" });
    expect(terminalByTool.get("ArtifactWriterTool")).toMatchObject({ status: "blocked", terminalCause: "DEPENDENCY_FAILED" });
    expect(events.filter((event) => ["queued", "running"].includes(event.status)).length).toBeGreaterThan(0);
  });
});

function toolInputs(toolName: string): Record<string, unknown> {
  if (toolName === "WebFetchTool") return { urls: ["https://example.com/source"] };
  if (toolName === "DataAnalysisTool") return { checks: ["evidence_coverage"] };
  if (toolName === "ArtifactWriterTool") return { artifacts: [{ relativePath: "artifacts/research-note.md", kind: "research_report", format: "markdown" }] };
  return {};
}
