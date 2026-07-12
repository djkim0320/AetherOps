import { describe, expect, it } from "vitest";
import { ResearchLoopStep, type ResearchToolInput } from "../shared/types.js";
import { ArtifactWriterTool } from "./artifactWriterTool.js";
import type { ResearchToolExecutionContext } from "./researchToolTypes.js";

const timestamp = "2026-07-11T00:00:00.000Z";

describe("ArtifactWriterTool", () => {
  it("creates exactly one deterministic artifact for every validated request", async () => {
    const result = await new ArtifactWriterTool().run(
      input(),
      undefined,
      context([
        { relativePath: "reports/research.md", kind: "research_report", format: "markdown" },
        { relativePath: "artifacts/evidence.json", kind: "evidence_index", format: "json" }
      ])
    );

    expect(result.artifacts.map((item) => item.relativePath)).toEqual(["reports/research.md", "artifacts/evidence.json"]);
    expect(result.artifacts[0]?.content).toContain("Research Report");
    expect(() => JSON.parse(result.artifacts[1]?.content ?? "")).not.toThrow();
    expect(result.toolRun.input).toEqual({
      artifacts: [
        { relativePath: "reports/research.md", kind: "research_report", format: "markdown" },
        { relativePath: "artifacts/evidence.json", kind: "evidence_index", format: "json" }
      ]
    });
  });

  it("rejects traversal before creating any artifact", async () => {
    await expect(
      new ArtifactWriterTool().run(input(), undefined, context([{ relativePath: "../escape.json", kind: "evidence_index", format: "json" }]))
    ).rejects.toThrow(/traversal/i);
  });
});

function context(artifacts: Array<{ relativePath: string; kind: string; format: string }>): ResearchToolExecutionContext {
  return {
    signal: new AbortController().signal,
    attemptId: "attempt-artifact",
    decisionId: "decision-artifact",
    ordinal: 1,
    phase: "artifact",
    inputs: { artifacts }
  };
}

function input(): ResearchToolInput {
  return {
    project: {
      id: "project-1",
      goal: "Produce deterministic research artifacts.",
      topic: "artifact fidelity",
      scope: "local",
      budget: "one iteration",
      autonomyPolicy: { toolApproval: "suggested", allowExternalSearch: false, allowCodeExecution: false },
      createdAt: timestamp,
      updatedAt: timestamp,
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
    toolRuns: [
      {
        id: "analysis-1",
        projectId: "project-1",
        iteration: 1,
        toolName: "DataAnalysisTool",
        input: { checks: ["evidence_coverage"] },
        output: { evidenceGaps: ["No evidence was collected."], planRevisionHints: ["Collect evidence."] },
        status: "completed",
        startedAt: timestamp,
        completedAt: timestamp
      }
    ]
  };
}
