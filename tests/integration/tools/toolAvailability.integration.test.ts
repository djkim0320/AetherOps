import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ToolRunner } from "../../../src/core/tools/toolRunner.js";
import { describeEngineeringProgramCapabilities } from "../../../src/server/runtime/engineering/engineeringRuntimeCapabilities.js";
import { createRuntimeResearchTools as createDefaultResearchTools } from "../../../src/server/runtime/tools/defaultResearchTools.js";
import { installToolRunnerTestCleanup, runInput, settings, webSource } from "./toolRunner.integration.support.js";

installToolRunnerTestCleanup();

describe("Tool availability and engineering capabilities", () => {
  it("separates registered tools from currently executable tools", () => {
    const runner = new ToolRunner(createDefaultResearchTools());
    const input = runInput();
    const snapshot = {
      project: input.project,
      sources: [],
      evidence: [],
      artifacts: [],
      toolRuns: [],
      continuationDecisions: []
    } as unknown as Parameters<ToolRunner["listExecutableToolNames"]>[0]["snapshot"];

    const executable = runner.listExecutableToolNames({ snapshot, settings });

    expect(runner.listRegisteredToolNames()).toEqual(expect.arrayContaining(["ResearchMetadataTool", "PdfIngestionTool"]));
    expect(runner.listRegisteredToolNames()).not.toContain("PaperMetadataTool");
    expect(runner.listRegisteredToolNames()).not.toContain("CodeExecutionTool");
    expect(executable).not.toContain("PdfIngestionTool");
    expect(executable).not.toContain("EngineeringProgramTool");
    expect(executable).toEqual(expect.arrayContaining(["WebSearchTool", "WebFetchTool", "ResearchMetadataTool", "ArtifactWriterTool", "DataAnalysisTool"]));
  });

  it("does not expose PdfIngestionTool for PDF URLs when external access is disabled", () => {
    const runner = new ToolRunner(createDefaultResearchTools());
    const input = runInput();
    const snapshot = {
      project: input.project,
      sources: [webSource("paper", "https://example.edu/paper.pdf")],
      evidence: [],
      artifacts: [],
      researchPlans: [{ ...input.researchPlan!, fetchCandidateUrls: ["https://arxiv.org/abs/2401.00001"] }],
      toolRuns: [],
      continuationDecisions: []
    } as unknown as Parameters<ToolRunner["listExecutableToolNames"]>[0]["snapshot"];

    expect(runner.listExecutableToolNames({ snapshot, settings })).toContain("PdfIngestionTool");
    expect(runner.listExecutableToolNames({ snapshot, settings: { ...settings, allowExternalSearch: false } })).not.toContain("PdfIngestionTool");
  });
  it("exposes EngineeringProgramTool when code execution and bundled or configured engineering solvers are present", () => {
    const runner = new ToolRunner(createDefaultResearchTools());
    const input = runInput();
    input.project.autonomyPolicy.allowCodeExecution = true;
    const snapshot = {
      project: input.project,
      sources: [],
      evidence: [],
      artifacts: [],
      toolRuns: [],
      continuationDecisions: []
    } as unknown as Parameters<ToolRunner["listExecutableToolNames"]>[0]["snapshot"];
    const tempRoot = mkdtempSync(join(tmpdir(), "aetherops-executable-modeling-"));
    try {
      const executable = runner.listExecutableToolNames({
        snapshot,
        settings: {
          ...settings,
          allowCodeExecution: true,
          engineeringTools: {
            ...settings.engineeringTools,
            enabled: true,
            modeling: { ...settings.engineeringTools.modeling, enabled: true, artifactRoot: tempRoot }
          }
        }
      });

      expect(executable).toContain("EngineeringProgramTool");

      const missingModelingRoot = runner.listExecutableToolNames({
        snapshot,
        settings: {
          ...settings,
          allowCodeExecution: true,
          engineeringTools: {
            ...settings.engineeringTools,
            enabled: true,
            modeling: { ...settings.engineeringTools.modeling, enabled: true, artifactRoot: join(tempRoot, "missing") }
          }
        }
      });
      expect(missingModelingRoot).toContain("EngineeringProgramTool");
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("exposes EngineeringProgramTool when an XFLR5 adapter command is configured", () => {
    const runner = new ToolRunner(createDefaultResearchTools());
    const input = runInput();
    input.project.autonomyPolicy.allowCodeExecution = true;
    const snapshot = {
      project: input.project,
      sources: [],
      evidence: [],
      artifacts: [],
      toolRuns: [],
      continuationDecisions: []
    } as unknown as Parameters<ToolRunner["listExecutableToolNames"]>[0]["snapshot"];
    const executable = runner.listExecutableToolNames({
      snapshot,
      settings: {
        ...settings,
        allowCodeExecution: true,
        engineeringTools: {
          ...settings.engineeringTools,
          enabled: true,
          xflr5: {
            ...settings.engineeringTools.xflr5,
            enabled: true,
            command: process.execPath,
            scriptPath: process.execPath,
            runArgsTemplate: ["--script", "{script}", "--spec", "{spec}", "--output", "{output}"]
          }
        }
      }
    });

    expect(executable).toContain("EngineeringProgramTool");
  });

  it("describes engineering program capabilities from real settings", () => {
    const blockedCapabilities = describeEngineeringProgramCapabilities(settings);
    expect(blockedCapabilities.find((capability) => capability.kind === "xfoil-polar")?.ready).toBe(false);
    expect(blockedCapabilities.find((capability) => capability.kind === "xfoil-wasm-polar")?.ready).toBe(false);
    expect(blockedCapabilities.find((capability) => capability.target === "xflr5")?.ready).toBe(false);

    const configuredCapabilities = describeEngineeringProgramCapabilities({
      ...settings,
      allowCodeExecution: true,
      engineeringTools: {
        ...settings.engineeringTools,
        enabled: true,
        xfoil: { ...settings.engineeringTools.xfoil, enabled: true, command: process.execPath },
        xflr5: {
          ...settings.engineeringTools.xflr5,
          enabled: true,
          command: process.execPath,
          scriptPath: process.execPath
        }
      }
    });

    expect(configuredCapabilities.find((capability) => capability.kind === "xfoil-polar")?.ready).toBe(true);
    expect(configuredCapabilities.find((capability) => capability.kind === "xfoil-wasm-polar")?.ready).toBe(true);
    expect(configuredCapabilities.find((capability) => capability.target === "xflr5")?.ready).toBe(true);
    expect(configuredCapabilities.find((capability) => capability.target === "xflr5")?.requiredFields).toEqual(["kind", "target", "cfdRunSpec"]);

    const missingCommandCapabilities = describeEngineeringProgramCapabilities({
      ...settings,
      allowCodeExecution: true,
      engineeringTools: {
        ...settings.engineeringTools,
        enabled: true,
        xfoil: { ...settings.engineeringTools.xfoil, enabled: true, command: "aetherops-missing-xfoil-command.exe" }
      }
    });
    expect(missingCommandCapabilities.find((capability) => capability.kind === "xfoil-polar")).toMatchObject({
      ready: false,
      blockedReason: expect.stringContaining("not available")
    });
  });
});
