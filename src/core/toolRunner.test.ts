import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describeEngineeringProgramCapabilities, EngineeringProgramTool, runEngineeringProgramPreflight } from "./engineeringProgramTool.js";
import { ResearchMetadataTool } from "./researchMetadataTool.js";
import { buildRuntimeToolDiagnostics } from "./runtimeToolDiagnostics.js";
import { createDefaultResearchTools, DataAnalysisTool, PdfIngestionTool, WebFetchTool, WebSearchTool, type ResearchTool, type ResearchToolResult } from "./toolRegistry.js";
import { dedupeResearchTools, normalizeToolName, orderToolNames, ToolRunner, ToolRunnerError } from "./toolRunner.js";
import { ResearchLoopStep, type AppSettings, type OpenCodeRunInput, type ResearchSource } from "./types.js";

const createdAt = "2026-05-26T00:00:00.000Z";

const settings: AppSettings = {
  openCodeLlm: { source: "codex-oauth", model: "gpt-5" },
  openCode: { enabled: false, command: "opencode", timeoutMs: 180_000 },
  webSearch: { provider: "custom", apiKey: "test-key", endpoint: "https://search.example.test" },
  embedding: { provider: "local", model: "none", dimensions: 0 },
  browserUse: { enabled: false, mode: "background", maxPages: 2, timeoutMs: 30_000, captureScreenshots: false },
  researchMetadata: { enabled: true, provider: "openalex", maxResults: 5, timeoutMs: 15_000 },
  engineeringTools: {
    enabled: false,
    xfoil: { enabled: false, command: "", timeoutMs: 30_000 },
    modeling: { enabled: false, artifactRoot: "", maxMeshBytes: 20 * 1024 * 1024 },
    openFoam: { enabled: false, command: "", caseRoot: "", workingDirectory: "", probeArgs: ["-help"], runArgsTemplate: ["-case", "{case}"], timeoutMs: 30 * 60_000 },
    su2: { enabled: false, command: "", caseRoot: "", configFile: "", workingDirectory: "", probeArgs: ["--help"], runArgsTemplate: ["{config}"], timeoutMs: 30 * 60_000 },
    freeCad: { enabled: false, command: "", scriptPath: "", workingDirectory: "", probeArgs: ["--version"], runArgsTemplate: ["{script}", "--output", "{output}"], timeoutMs: 30 * 60_000 },
    openVsp: { enabled: false, command: "", scriptPath: "", workingDirectory: "", probeArgs: ["-help"], runArgsTemplate: ["-script", "{script}", "-output", "{output}"], timeoutMs: 30 * 60_000 },
    commercialCfd: {
      flightStreamConfigured: false,
      starCcmConfigured: false,
      flightStreamCommand: "",
      flightStreamWorkingDirectory: "",
      flightStreamProbeArgs: ["--version"],
      flightStreamRunArgsTemplate: [],
      flightStreamTimeoutMs: 120_000,
      starCcmCommand: "",
      starCcmWorkingDirectory: "",
      starCcmProbeArgs: ["-version"],
      starCcmRunArgsTemplate: [],
      starCcmTimeoutMs: 120_000,
      notes: ""
    }
  },
  allowExternalSearch: true,
  allowCodeExecution: false,
  updatedAt: createdAt
};

function runInput(requiredTools: string[] = []): OpenCodeRunInput {
  return {
    project: {
      id: "project-1",
      goal: "Research resilient web evidence collection.",
      topic: "web evidence collection",
      scope: "public web sources",
      budget: "10 minutes",
      autonomyPolicy: { toolApproval: "suggested", allowExternalSearch: true, allowCodeExecution: false },
      createdAt,
      updatedAt: createdAt,
      currentStep: ResearchLoopStep.ExecuteTools,
      status: "running",
      projectRoot: ".aetherops/test"
    },
    questions: [{ id: "q1", projectId: "project-1", text: "What source has usable evidence?", status: "open", createdAt }],
    hypotheses: [{ id: "h1", projectId: "project-1", questionId: "q1", statement: "Fetched pages can become evidence.", status: "untested", confidence: 0.2, createdAt }],
    evidence: [],
    artifacts: [],
    sources: [],
    researchPlan: {
      id: "plan-1",
      projectId: "project-1",
      iteration: 1,
      objective: "Collect web evidence.",
      targetQuestions: ["q1"],
      targetHypotheses: ["h1"],
      requiredTools,
      expectedSources: ["web"],
      expectedArtifacts: ["fetched page"],
      executionSteps: ["Search", "Fetch"],
      stopCriteria: ["Fetched evidence exists"],
      createdAt
    },
    iteration: 1
  };
}

afterEach(() => {
  (vi as unknown as Record<string, () => void>)[["restoreAll", "M", "ocks"].join("")]?.();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("ToolRunner registry", () => {
  it("lists default tools and a background browser tool without duplicates", () => {
    const duplicate: ResearchTool = {
      name: "BackgroundBrowserTool",
      run: async () => {
        throw new Error("not used by this registry test");
      }
    };
    const runner = new ToolRunner(dedupeResearchTools([...createDefaultResearchTools(), duplicate, duplicate]));

    expect(runner.hasTool("ArtifactWriterTool")).toBe(true);
    expect(runner.hasTool("Data Analysis Tool")).toBe(true);
    expect(runner.hasTool("BackgroundBrowserTool")).toBe(true);
    expect(runner.hasTool("OpenCodeTool")).toBe(false);
    expect(runner.listToolNames().filter((name) => normalizeToolName(name) === "backgroundbrowsertool")).toHaveLength(1);
  });
});

describe("ToolRunner web tool pipeline", () => {
  it("chains WebSearch sources into WebFetch and only creates evidence after fetch without mutating the original input", async () => {
    const input = runInput(["WebSearchTool", "WebFetchTool"]);
    const search = new WebSearchTool();
    (search as unknown as { search: () => Promise<Array<{ title: string; url: string; snippet: string }>> }).search = async () => [
      { title: "Search result", url: "https://example.edu/study", snippet: "Discovery snippet only." }
    ];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => ({
        ok: true,
        status: 200,
        statusText: "OK",
        url,
        headers: new Headers({ "content-type": "text/html" }),
        text: async () => "<html><title>Fetched study</title><body>Fetched page text that can become evidence.</body></html>"
      }))
    );

    const results = await new ToolRunner([search, new WebFetchTool()]).runAll(input, settings);

    expect(results).toHaveLength(2);
    expect(results[0]?.sources).toHaveLength(1);
    expect(results[0]?.evidence).toHaveLength(0);
    expect(results[1]?.evidence).toHaveLength(1);
    expect(results[1]?.sources).toHaveLength(1);
    expect(results[1]?.artifacts).toHaveLength(0);
    expect(input.sources).toEqual([]);
    expect(input.evidence).toEqual([]);
    expect(input.artifacts).toEqual([]);
  });

  it("passes accumulated sources, evidence, artifacts, and tool runs to later tools", async () => {
    const seedToolRun = { id: "opencode-tool-1", projectId: "project-1", iteration: 1, toolName: "OpenCodeTool", input: {}, output: {}, status: "completed" as const, startedAt: createdAt, completedAt: createdAt };
    const input = {
      ...runInput(["first", "second"]),
      sources: [webSource("seed-source", "https://example.edu/seed")],
      toolRuns: [seedToolRun]
    };
    const observed: OpenCodeRunInput[] = [];
    const first: ResearchTool = {
      name: "First",
      run: async (): Promise<ResearchToolResult> => ({
        toolRun: { id: "tool-1", projectId: "project-1", iteration: 1, toolName: "First", input: {}, output: {}, status: "completed", startedAt: createdAt, completedAt: createdAt },
        evidence: [{ id: "e1", projectId: "project-1", category: "web_source", title: "Evidence", summary: "Summary", sourceUri: "https://example.edu/a", keywords: [], linkedHypothesisIds: [], createdAt }],
        artifacts: [{ id: "a1", projectId: "project-1", category: "generated_artifact", title: "Artifact", relativePath: "artifact.md", mimeType: "text/markdown", summary: "Summary", createdAt }],
        sources: [{ id: "s1", projectId: "project-1", kind: "web", title: "Source", url: "https://example.edu/a", retrievedAt: createdAt, metadata: {}, createdAt }]
      })
    };
    const second: ResearchTool = {
      name: "Second",
      run: async (nextInput): Promise<ResearchToolResult> => {
        observed.push(nextInput);
        return {
          toolRun: { id: "tool-2", projectId: "project-1", iteration: 1, toolName: "Second", input: {}, output: {}, status: "completed", startedAt: createdAt, completedAt: createdAt },
          evidence: [],
          artifacts: [],
          sources: []
        };
      }
    };

    await new ToolRunner([first, second]).runAll(input, settings);

    expect(observed[0]?.sources).toHaveLength(2);
    expect(observed[0]?.evidence).toHaveLength(1);
    expect(observed[0]?.artifacts).toHaveLength(1);
    expect((observed[0] as OpenCodeRunInput & { toolRuns?: unknown[] }).toolRuns).toHaveLength(2);
    expect(input.sources).toHaveLength(1);
    expect(input.evidence).toEqual([]);
    expect(input.artifacts).toEqual([]);
  });

  it("orders required tools canonically so WebSearch runs before WebFetch", async () => {
    expect(orderToolNames(["WebFetchTool", "WebSearchTool", "ArtifactWriterTool"])).toEqual(["WebSearchTool", "WebFetchTool", "ArtifactWriterTool"]);
  });

  it("can run only included tools and then exclude those tools from a later pass", async () => {
    const input = runInput(["First", "Second", "Third"]);
    const calls: string[] = [];
    const makeTool = (name: string): ResearchTool => ({
      name,
      run: async (): Promise<ResearchToolResult> => {
        calls.push(name);
        return {
          toolRun: { id: `tool-${name}`, projectId: "project-1", iteration: 1, toolName: name, input: {}, output: {}, status: "completed", startedAt: createdAt, completedAt: createdAt },
          evidence: [],
          artifacts: [],
          sources: []
        };
      }
    });
    const runner = new ToolRunner([makeTool("First"), makeTool("Second"), makeTool("Third")]);

    const firstPass = await runner.runAll(input, settings, { includeTools: ["Second"] });
    const secondPass = await runner.runAll(input, settings, { excludeTools: ["Second"] });

    expect(firstPass.map((result) => result.toolRun.toolName)).toEqual(["Second"]);
    expect(secondPass.map((result) => result.toolRun.toolName)).toEqual(["First", "Third"]);
    expect(calls).toEqual(["Second", "First", "Third"]);
  });

  it("preserves partial outputs and failed tool run when a later tool fails", async () => {
    const input = runInput(["First", "Second"]);
    const first: ResearchTool = {
      name: "First",
      run: async (): Promise<ResearchToolResult> => ({
        toolRun: { id: "tool-1", projectId: "project-1", iteration: 1, toolName: "First", input: {}, output: {}, status: "completed", startedAt: createdAt, completedAt: createdAt },
        evidence: [],
        artifacts: [],
        sources: [webSource("s1", "https://example.edu/a")]
      })
    };
    const second: ResearchTool = {
      name: "Second",
      run: async (): Promise<ResearchToolResult> => ({
        toolRun: { id: "tool-2", projectId: "project-1", iteration: 1, toolName: "Second", input: {}, output: { reason: "boom" }, status: "failed", error: "boom", startedAt: createdAt, completedAt: createdAt },
        evidence: [],
        artifacts: [],
        sources: []
      })
    };

    try {
      await new ToolRunner([first, second]).runAll(input, settings);
      throw new Error("expected ToolRunnerError");
    } catch (error) {
      expect(error).toBeInstanceOf(ToolRunnerError);
      const toolError = error as ToolRunnerError;
      expect(toolError.partialResults).toHaveLength(1);
      expect(toolError.partialResults[0]?.sources).toHaveLength(1);
      expect(toolError.failedResult?.toolRun.id).toBe("tool-2");
      expect(toolError.toolName).toBe("Second");
      expect(toolError.rollingInput.sources).toHaveLength(1);
      expect(toolError.rollingInput.toolRuns).toHaveLength(2);
    }
  });

  it("creates a synthetic failed ToolRun when a tool throws before returning a result", async () => {
    const input = runInput(["First", "ThrowingTool"]);
    const first: ResearchTool = {
      name: "First",
      run: async (): Promise<ResearchToolResult> => ({
        toolRun: { id: "tool-1", projectId: "project-1", iteration: 1, toolName: "First", input: {}, output: {}, status: "completed", startedAt: createdAt, completedAt: createdAt },
        evidence: [],
        artifacts: [],
        sources: [webSource("s1", "https://example.edu/a")]
      })
    };
    const throwing: ResearchTool = {
      name: "ThrowingTool",
      run: async () => {
        throw new Error("network exploded before result");
      }
    };

    await expect(new ToolRunner([first, throwing]).runAll(input, settings)).rejects.toMatchObject({
      partialResults: expect.arrayContaining([expect.objectContaining({ toolRun: expect.objectContaining({ toolName: "First" }) })]),
      failedResult: expect.objectContaining({
        toolRun: expect.objectContaining({
          toolName: "ThrowingTool",
          status: "failed",
          error: "network exploded before result"
        })
      }),
      toolName: "ThrowingTool"
    });
  });

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

    expect(runner.listRegisteredToolNames()).toEqual(expect.arrayContaining(["PaperMetadataTool", "PdfIngestionTool"]));
    expect(executable).not.toContain("PaperMetadataTool");
    expect(executable).not.toContain("PdfIngestionTool");
    expect(executable).not.toContain("EngineeringProgramTool");
    expect(executable).toEqual(expect.arrayContaining(["WebSearchTool", "WebFetchTool", "ResearchMetadataTool", "ArtifactWriterTool", "DataAnalysisTool"]));
  });

  it("exposes EngineeringProgramTool only when code execution and a real program configuration are present", () => {
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

      const missing = runner.listExecutableToolNames({
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
      expect(missing).not.toContain("EngineeringProgramTool");
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("exposes EngineeringProgramTool when a commercial CFD adapter command is configured", () => {
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
          commercialCfd: {
            ...settings.engineeringTools.commercialCfd,
            flightStreamConfigured: true,
            flightStreamCommand: "flightstream.exe",
            flightStreamRunArgsTemplate: ["--batch", "{input}", "--output", "{output}"]
          }
        }
      }
    });

    expect(executable).toContain("EngineeringProgramTool");
  });

  it("describes engineering program capabilities from real settings", () => {
    const blockedCapabilities = describeEngineeringProgramCapabilities(settings);
    expect(blockedCapabilities.find((capability) => capability.kind === "xfoil-polar")?.ready).toBe(false);
    expect(blockedCapabilities.find((capability) => capability.target === "flightstream")?.blockedReason).toContain("FlightStream");

    const configuredCapabilities = describeEngineeringProgramCapabilities({
      ...settings,
      allowCodeExecution: true,
      engineeringTools: {
        ...settings.engineeringTools,
        enabled: true,
        xfoil: { ...settings.engineeringTools.xfoil, enabled: true, command: "xfoil.exe" },
        commercialCfd: {
          ...settings.engineeringTools.commercialCfd,
          flightStreamConfigured: true,
          flightStreamCommand: "flightstream.exe",
          flightStreamRunArgsTemplate: ["--batch", "{input}", "--output", "{output}"]
        }
      }
    });

    expect(configuredCapabilities.find((capability) => capability.kind === "xfoil-polar")?.ready).toBe(true);
    expect(configuredCapabilities.find((capability) => capability.target === "flightstream")?.ready).toBe(true);
    expect(configuredCapabilities.find((capability) => capability.target === "flightstream")?.requiredFields).toEqual(["kind", "target"]);
  });

  it("builds runtime tool diagnostics without exposing unavailable tool availability", () => {
    const blocked = buildRuntimeToolDiagnostics(settings);
    expect(blocked.researchMetadata.ready).toBe(true);
    expect(blocked.executableTools).toContain("ResearchMetadataTool");
    expect(blocked.executableTools).not.toContain("EngineeringProgramTool");
    expect(blocked.engineeringArtifactCandidates).toEqual([]);
    expect(blocked.engineeringPrograms.find((capability) => capability.target === "all")?.blockedReason).toContain("Code execution");
    expect(blocked.engineeringProgramRequestTemplates.find((template) => template.id === "xfoil-polar:xfoil")?.ready).toBe(false);
    expect(blocked.engineeringProgramRequestTemplates.find((template) => template.id === "xfoil-polar:xfoil")?.request).toMatchObject({
      kind: "xfoil-polar",
      target: "xfoil"
    });

    const tempRoot = mkdtempSync(join(tmpdir(), "aetherops-diagnostics-mesh-"));
    try {
      const openFoamCaseRoot = join(tempRoot, "openfoam-case");
      mkdirSync(join(openFoamCaseRoot, "system"), { recursive: true });
      writeFileSync(join(openFoamCaseRoot, "system", "controlDict"), "application simpleFoam;\n", "utf8");
      const su2CaseRoot = join(tempRoot, "su2-case");
      mkdirSync(su2CaseRoot, { recursive: true });
      writeFileSync(join(su2CaseRoot, "case.cfg"), "SOLVER= EULER\nMESH_FILENAME= mesh.su2\n", "utf8");
      const freeCadScriptPath = join(tempRoot, "freecad-script.mjs");
      writeFileSync(freeCadScriptPath, "console.log('FreeCAD harness ready');\n", "utf8");
      const openVspScriptPath = join(tempRoot, "openvsp-script.mjs");
      writeFileSync(openVspScriptPath, "console.log('OpenVSP harness ready');\n", "utf8");
      writeFileSync(join(tempRoot, "wing.obj"), ["v 0 0 0", "v 1 0 0", "v 0 1 0", "f 1 2 3", ""].join("\n"), "utf8");
      writeFileSync(join(tempRoot, "invalid.obj"), "not a mesh\n", "utf8");
      writeFileSync(join(tempRoot, "oversize.stl"), "solid oversize\n".repeat(8), "utf8");

      const configured = buildRuntimeToolDiagnostics({
        ...settings,
        allowCodeExecution: true,
        engineeringTools: {
          ...settings.engineeringTools,
          enabled: true,
          modeling: { ...settings.engineeringTools.modeling, enabled: true, artifactRoot: tempRoot, maxMeshBytes: 96 },
          openFoam: {
            ...settings.engineeringTools.openFoam,
            enabled: true,
            command: process.execPath,
            caseRoot: openFoamCaseRoot,
            runArgsTemplate: ["--version"]
          },
          su2: {
            ...settings.engineeringTools.su2,
            enabled: true,
            command: process.execPath,
            caseRoot: su2CaseRoot,
            configFile: "case.cfg",
            probeArgs: ["--version"],
            runArgsTemplate: ["{config}", "--output", "{output}"]
          },
          freeCad: {
            ...settings.engineeringTools.freeCad,
            enabled: true,
            command: process.execPath,
            scriptPath: freeCadScriptPath,
            runArgsTemplate: ["{script}", "--output", "{output}"]
          },
          openVsp: {
            ...settings.engineeringTools.openVsp,
            enabled: true,
            command: process.execPath,
            scriptPath: openVspScriptPath,
            runArgsTemplate: ["{script}", "--output", "{output}"]
          },
          commercialCfd: {
            ...settings.engineeringTools.commercialCfd,
            flightStreamConfigured: true,
            flightStreamCommand: "flightstream-adapter.exe",
            flightStreamRunArgsTemplate: ["--input", "{input}", "--output", "{output}"]
          }
        }
      });

      expect(configured.executableTools).toContain("EngineeringProgramTool");
      expect(configured.engineeringArtifactCandidates.find((candidate) => candidate.relativePath === "wing.obj")).toMatchObject({ ready: true, validated: true, format: "obj" });
      expect(configured.engineeringArtifactCandidates.find((candidate) => candidate.relativePath === "invalid.obj")).toMatchObject({
        ready: false,
        validated: false,
        format: "obj",
        blockedReason: expect.stringContaining("mesh validation failed")
      });
      expect(configured.engineeringArtifactCandidates.find((candidate) => candidate.relativePath === "oversize.stl")).toMatchObject({ ready: false, validated: false, format: "stl" });
      expect(configured.engineeringPrograms.find((capability) => capability.target === "flightstream")?.ready).toBe(true);
      expect(configured.engineeringPrograms.find((capability) => capability.target === "openfoam")?.ready).toBe(true);
      expect(configured.engineeringPrograms.find((capability) => capability.target === "su2")?.ready).toBe(true);
      expect(configured.engineeringPrograms.find((capability) => capability.target === "freecad")?.ready).toBe(true);
      expect(configured.engineeringPrograms.find((capability) => capability.target === "openvsp")?.ready).toBe(true);
      expect(configured.engineeringPrograms.find((capability) => capability.target === "starccm")?.ready).toBe(false);
      expect(configured.engineeringProgramRequestTemplates.find((template) => template.id === "mesh-inspect:modeling")).toMatchObject({
        ready: true,
        request: { kind: "mesh-inspect", target: "modeling", artifactPath: "wing.obj" }
      });
      expect(configured.engineeringProgramRequestTemplates.find((template) => template.id === "openfoam-case-run:openfoam")).toMatchObject({
        ready: true,
        request: { kind: "openfoam-case-run", target: "openfoam", outputFileName: "openfoam-run-output.txt" }
      });
      expect(configured.engineeringProgramRequestTemplates.find((template) => template.id === "su2-case-run:su2")).toMatchObject({
        ready: true,
        request: { kind: "su2-case-run", target: "su2", outputFileName: "su2-run-output.txt" }
      });
      expect(configured.engineeringProgramRequestTemplates.find((template) => template.id === "cad-script-run:freecad")).toMatchObject({
        ready: true,
        request: { kind: "cad-script-run", target: "freecad", outputFileName: "freecad-script-output.json" }
      });
      expect(configured.engineeringProgramRequestTemplates.find((template) => template.id === "vsp-script-run:openvsp")).toMatchObject({
        ready: true,
        request: { kind: "vsp-script-run", target: "openvsp", outputFileName: "openvsp-script-output.json" }
      });
      expect(configured.engineeringProgramRequestTemplates.find((template) => template.id === "commercial-cfd-run:flightstream")).toMatchObject({
        ready: true,
        request: { kind: "commercial-cfd-run", target: "flightstream", artifactPath: "wing.obj" }
      });
      const missingRunArgs = buildRuntimeToolDiagnostics({
        ...settings,
        allowCodeExecution: true,
        engineeringTools: {
          ...settings.engineeringTools,
          enabled: true,
          openFoam: {
            ...settings.engineeringTools.openFoam,
            enabled: true,
            command: process.execPath,
            caseRoot: openFoamCaseRoot,
            runArgsTemplate: []
          }
        }
      });
      expect(missingRunArgs.engineeringProgramRequestTemplates.find((template) => template.id === "openfoam-case-run:openfoam")).toMatchObject({
        ready: false,
        blockedReason: expect.stringContaining("run args template")
      });
      const missingSu2RunArgs = buildRuntimeToolDiagnostics({
        ...settings,
        allowCodeExecution: true,
        engineeringTools: {
          ...settings.engineeringTools,
          enabled: true,
          su2: {
            ...settings.engineeringTools.su2,
            enabled: true,
            command: process.execPath,
            caseRoot: su2CaseRoot,
            configFile: "case.cfg",
            runArgsTemplate: []
          }
        }
      });
      expect(missingSu2RunArgs.engineeringProgramRequestTemplates.find((template) => template.id === "su2-case-run:su2")).toMatchObject({
        ready: false,
        blockedReason: expect.stringContaining("run args template")
      });
      const missingSu2ConfigPlaceholder = buildRuntimeToolDiagnostics({
        ...settings,
        allowCodeExecution: true,
        engineeringTools: {
          ...settings.engineeringTools,
          enabled: true,
          su2: {
            ...settings.engineeringTools.su2,
            enabled: true,
            command: process.execPath,
            caseRoot: su2CaseRoot,
            configFile: "case.cfg",
            runArgsTemplate: ["--output", "{output}"]
          }
        }
      });
      expect(missingSu2ConfigPlaceholder.engineeringProgramRequestTemplates.find((template) => template.id === "su2-case-run:su2")).toMatchObject({
        ready: false,
        blockedReason: expect.stringContaining("{config}")
      });
      const missingFreeCadRunArgs = buildRuntimeToolDiagnostics({
        ...settings,
        allowCodeExecution: true,
        engineeringTools: {
          ...settings.engineeringTools,
          enabled: true,
          freeCad: {
            ...settings.engineeringTools.freeCad,
            enabled: true,
            command: process.execPath,
            scriptPath: freeCadScriptPath,
            runArgsTemplate: []
          }
        }
      });
      expect(missingFreeCadRunArgs.engineeringProgramRequestTemplates.find((template) => template.id === "cad-script-run:freecad")).toMatchObject({
        ready: false,
        blockedReason: expect.stringContaining("run args template")
      });
      const missingOpenVspRunArgs = buildRuntimeToolDiagnostics({
        ...settings,
        allowCodeExecution: true,
        engineeringTools: {
          ...settings.engineeringTools,
          enabled: true,
          openVsp: {
            ...settings.engineeringTools.openVsp,
            enabled: true,
            command: process.execPath,
            scriptPath: openVspScriptPath,
            runArgsTemplate: []
          }
        }
      });
      expect(missingOpenVspRunArgs.engineeringProgramRequestTemplates.find((template) => template.id === "vsp-script-run:openvsp")).toMatchObject({
        ready: false,
        blockedReason: expect.stringContaining("run args template")
      });
      const missingOpenVspScriptPlaceholder = buildRuntimeToolDiagnostics({
        ...settings,
        allowCodeExecution: true,
        engineeringTools: {
          ...settings.engineeringTools,
          enabled: true,
          openVsp: {
            ...settings.engineeringTools.openVsp,
            enabled: true,
            command: process.execPath,
            scriptPath: openVspScriptPath,
            runArgsTemplate: ["--output", "{output}"]
          }
        }
      });
      expect(missingOpenVspScriptPlaceholder.engineeringProgramRequestTemplates.find((template) => template.id === "vsp-script-run:openvsp")).toMatchObject({
        ready: false,
        blockedReason: expect.stringContaining("{script}")
      });
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }

    const missingRoot = buildRuntimeToolDiagnostics({
      ...settings,
      allowCodeExecution: true,
      engineeringTools: {
        ...settings.engineeringTools,
        enabled: true,
        modeling: { ...settings.engineeringTools.modeling, enabled: true, artifactRoot: join(tmpdir(), "aetherops-missing-mesh-root") }
      }
    });
    expect(missingRoot.engineeringArtifactCandidates).toEqual([]);
    expect(missingRoot.blockers.find((blocker) => blocker.key === "engineeringArtifacts")?.message).toContain("does not exist");
  });

  it("runs engineering preflight only against configured real commands", async () => {
    const blocked = await runEngineeringProgramPreflight(settings, "all");
    expect(blocked.status).toBe("failed");
    expect(blocked.error).toContain("code execution");

    const configured = await runEngineeringProgramPreflight(
      {
        ...settings,
        allowCodeExecution: true,
        engineeringTools: {
          ...settings.engineeringTools,
          enabled: true,
          commercialCfd: {
            ...settings.engineeringTools.commercialCfd,
            flightStreamConfigured: true,
            flightStreamCommand: process.execPath,
            flightStreamProbeArgs: ["--version"],
            flightStreamRunArgsTemplate: ["--input", "{input}", "--output", "{output}"]
          }
        }
      },
      "flightstream"
    );

    expect(configured.status).toBe("completed");
    expect(JSON.stringify(configured.output)).toContain("flightstream");
    expect(JSON.stringify(configured.output)).toContain(process.version);

    const openFoamTempRoot = mkdtempSync(join(tmpdir(), "aetherops-openfoam-preflight-"));
    try {
      const caseRoot = join(openFoamTempRoot, "case");
      mkdirSync(join(caseRoot, "system"), { recursive: true });
      writeFileSync(join(caseRoot, "system", "controlDict"), "application simpleFoam;\n", "utf8");
      const openFoam = await runEngineeringProgramPreflight(
        {
          ...settings,
          allowCodeExecution: true,
          engineeringTools: {
            ...settings.engineeringTools,
            enabled: true,
            openFoam: {
              ...settings.engineeringTools.openFoam,
              enabled: true,
              command: process.execPath,
              caseRoot,
              probeArgs: ["--version"],
              runArgsTemplate: ["--version"]
            }
          }
        },
        "openfoam"
      );

      expect(openFoam.status).toBe("completed");
      expect(JSON.stringify(openFoam.output)).toContain("openfoam");
      expect(JSON.stringify(openFoam.output)).toContain(process.version);
    } finally {
      rmSync(openFoamTempRoot, { recursive: true, force: true });
    }

    const su2TempRoot = mkdtempSync(join(tmpdir(), "aetherops-su2-preflight-"));
    try {
      const caseRoot = join(su2TempRoot, "case");
      mkdirSync(caseRoot, { recursive: true });
      writeFileSync(join(caseRoot, "case.cfg"), "SOLVER= EULER\nMESH_FILENAME= mesh.su2\n", "utf8");
      const su2 = await runEngineeringProgramPreflight(
        {
          ...settings,
          allowCodeExecution: true,
          engineeringTools: {
            ...settings.engineeringTools,
            enabled: true,
            su2: {
              ...settings.engineeringTools.su2,
              enabled: true,
              command: process.execPath,
              caseRoot,
              configFile: "case.cfg",
              probeArgs: ["--version"],
              runArgsTemplate: ["{config}"]
            }
          }
        },
        "su2"
      );

      expect(su2.status).toBe("completed");
      expect(JSON.stringify(su2.output)).toContain("su2");
      expect(JSON.stringify(su2.output)).toContain(process.version);
    } finally {
      rmSync(su2TempRoot, { recursive: true, force: true });
    }

    const freeCadTempRoot = mkdtempSync(join(tmpdir(), "aetherops-freecad-preflight-"));
    try {
      const scriptPath = join(freeCadTempRoot, "freecad-script.mjs");
      writeFileSync(scriptPath, "console.log('FreeCAD harness ready');\n", "utf8");
      const freeCad = await runEngineeringProgramPreflight(
        {
          ...settings,
          allowCodeExecution: true,
          engineeringTools: {
            ...settings.engineeringTools,
            enabled: true,
            freeCad: {
              ...settings.engineeringTools.freeCad,
              enabled: true,
              command: process.execPath,
              scriptPath,
              probeArgs: ["--version"],
              runArgsTemplate: ["{script}", "--output", "{output}"]
            }
          }
        },
        "freecad"
      );

      expect(freeCad.status).toBe("completed");
      expect(JSON.stringify(freeCad.output)).toContain("freecad");
      expect(JSON.stringify(freeCad.output)).toContain(process.version);
    } finally {
      rmSync(freeCadTempRoot, { recursive: true, force: true });
    }

    const openVspTempRoot = mkdtempSync(join(tmpdir(), "aetherops-openvsp-preflight-"));
    try {
      const scriptPath = join(openVspTempRoot, "openvsp-script.mjs");
      writeFileSync(scriptPath, "console.log('OpenVSP harness ready');\n", "utf8");
      const openVsp = await runEngineeringProgramPreflight(
        {
          ...settings,
          allowCodeExecution: true,
          engineeringTools: {
            ...settings.engineeringTools,
            enabled: true,
            openVsp: {
              ...settings.engineeringTools.openVsp,
              enabled: true,
              command: process.execPath,
              scriptPath,
              probeArgs: ["--version"],
              runArgsTemplate: ["{script}", "--output", "{output}"]
            }
          }
        },
        "openvsp"
      );

      expect(openVsp.status).toBe("completed");
      expect(JSON.stringify(openVsp.output)).toContain("openvsp");
      expect(JSON.stringify(openVsp.output)).toContain(process.version);
    } finally {
      rmSync(openVspTempRoot, { recursive: true, force: true });
    }
  });

  it("imports OpenAlex research metadata as paper sources and citation-backed evidence", async () => {
    const input = runInput(["ResearchMetadataTool"]);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: URL) => {
        expect(String(url)).toContain("api.openalex.org/works");
        return {
          ok: true,
          status: 200,
          statusText: "OK",
          json: async () => ({
            results: [
              {
                id: "https://openalex.org/W1",
                doi: "https://doi.org/10.1234/example",
                display_name: "Traceable research metadata for autonomous research systems",
                publication_year: 2026,
                cited_by_count: 7,
                abstract_inverted_index: {
                  Traceable: [0],
                  metadata: [1],
                  improves: [2],
                  research: [3],
                  validation: [4]
                },
                authorships: [{ author: { display_name: "Ada Kim" } }],
                primary_location: { landing_page_url: "https://doi.org/10.1234/example", source: { display_name: "Journal of AetherOps" } },
                open_access: { is_oa: true, oa_url: "https://doi.org/10.1234/example" }
              }
            ]
          })
        };
      })
    );

    const result = await new ResearchMetadataTool().run(input, settings);

    expect(result.toolRun.status).toBe("completed");
    expect(result.sources).toHaveLength(1);
    expect(result.sources[0]).toMatchObject({ kind: "paper", doi: "https://doi.org/10.1234/example" });
    expect(result.sources[0]?.metadata).toMatchObject({ provider: "openalex", traceabilityKind: "external_source" });
    expect(result.evidence).toHaveLength(1);
    expect(result.evidence[0]?.quote).toContain("Traceable metadata improves research validation");
    expect(result.evidence[0]?.citation).toContain("Ada Kim");
  });

  it("tries concise OpenAlex metadata queries when the first project-topic query has no usable works", async () => {
    const input = runInput(["ResearchMetadataTool"]);
    input.project.topic = "GUI autonomy final: OpenAlex metadata before OpenCode";
    input.project.goal = "Evaluate whether citation-aware scholarly metadata improves evidence traceability for literature-review RAG compared with vector retrieval alone.";

    const requestedSearches: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: URL) => {
        const search = url.searchParams.get("search") ?? "";
        requestedSearches.push(search);
        const hasConciseRagQuery = /retrieval|citation|literature|vector/i.test(search);
        return {
          ok: true,
          status: 200,
          statusText: "OK",
          json: async () => ({
            results: hasConciseRagQuery
              ? [
                  {
                    id: "https://openalex.org/W2",
                    doi: "https://doi.org/10.1234/rag",
                    display_name: "Citation-aware retrieval augmented generation for literature review",
                    publication_year: 2025,
                    cited_by_count: 11,
                    abstract_inverted_index: {
                      Citation: [0],
                      aware: [1],
                      retrieval: [2],
                      supports: [3],
                      literature: [4],
                      review: [5]
                    },
                    authorships: [{ author: { display_name: "Mina Park" } }]
                  }
                ]
              : []
          })
        };
      })
    );

    const result = await new ResearchMetadataTool().run(input, settings);

    expect(requestedSearches.length).toBeGreaterThan(1);
    expect(result.toolRun.status).toBe("completed");
    expect(result.sources[0]?.title).toContain("Citation-aware retrieval");
    expect(result.toolRun.input).toMatchObject({ provider: "openalex" });
  });

  it("inspects OBJ mesh artifacts only from the configured modeling root", async () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "aetherops-mesh-"));
    try {
      writeFileSync(join(tempRoot, "wing.obj"), ["v 0 0 0", "v 1 0 0", "v 0 1 0", "f 1 2 3", ""].join("\n"), "utf8");
      const input = runInput(["EngineeringProgramTool"]);
      input.project.autonomyPolicy.allowCodeExecution = true;
      input.researchPlan = {
        ...input.researchPlan!,
        programRequests: [{ kind: "mesh-inspect", target: "modeling", artifactPath: "wing.obj" }]
      };
      const result = await new EngineeringProgramTool().run(input, {
        ...settings,
        allowCodeExecution: true,
        engineeringTools: {
          ...settings.engineeringTools,
          enabled: true,
          modeling: { ...settings.engineeringTools.modeling, enabled: true, artifactRoot: tempRoot }
        }
      });

      expect(result.toolRun.status).toBe("completed");
      expect(result.artifacts).toHaveLength(1);
      expect(result.artifacts[0]?.content).toContain('"vertexCount": 3');
      expect(result.artifacts[0]?.content).toContain('"triangleCount": 1');
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("runs an OpenFOAM-compatible case command only from explicit settings", async () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "aetherops-openfoam-run-"));
    try {
      const caseRoot = join(tempRoot, "case");
      mkdirSync(join(caseRoot, "system"), { recursive: true });
      writeFileSync(join(caseRoot, "system", "controlDict"), "application simpleFoam;\n", "utf8");
      const runnerPath = join(tempRoot, "openfoam-runner.mjs");
      writeFileSync(
        runnerPath,
        [
          "import { writeFileSync } from 'node:fs';",
          "const caseIndex = process.argv.indexOf('--case');",
          "const outputIndex = process.argv.indexOf('--output');",
          "if (caseIndex < 0 || outputIndex < 0) process.exit(2);",
          "writeFileSync(process.argv[outputIndex + 1], `case=${process.argv[caseIndex + 1]}\\nresidual=0.001\\n`, 'utf8');",
          "console.log('OpenFOAM harness completed');"
        ].join("\n"),
        "utf8"
      );

      const input = runInput(["EngineeringProgramTool"]);
      input.project.autonomyPolicy.allowCodeExecution = true;
      input.researchPlan = {
        ...input.researchPlan!,
        programRequests: [{ kind: "openfoam-case-run", target: "openfoam", outputFileName: "openfoam-result.txt" }]
      };
      const result = await new EngineeringProgramTool().run(input, {
        ...settings,
        allowCodeExecution: true,
        engineeringTools: {
          ...settings.engineeringTools,
          enabled: true,
          openFoam: {
            ...settings.engineeringTools.openFoam,
            enabled: true,
            command: process.execPath,
            caseRoot,
            runArgsTemplate: [runnerPath, "--case", "{case}", "--output", "{output}"],
            probeArgs: ["--version"]
          }
        }
      });

      expect(result.toolRun.status).toBe("completed");
      expect(result.artifacts[0]?.content).toContain("openfoam-result.txt");
      expect(result.artifacts[0]?.content).toContain("residual=0.001");
      expect(result.evidence[0]?.metadata).toMatchObject({ program: "openfoam", traceabilityKind: "tool_observation" });
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("runs an SU2-compatible case command only from explicit settings", async () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "aetherops-su2-run-"));
    try {
      const caseRoot = join(tempRoot, "case");
      mkdirSync(caseRoot, { recursive: true });
      writeFileSync(join(caseRoot, "case.cfg"), "SOLVER= EULER\nMESH_FILENAME= mesh.su2\n", "utf8");
      const runnerPath = join(tempRoot, "su2-runner.mjs");
      writeFileSync(
        runnerPath,
        [
          "import { writeFileSync } from 'node:fs';",
          "const outputIndex = process.argv.indexOf('--output');",
          "const configPath = process.argv[2];",
          "if (!configPath || outputIndex < 0) process.exit(2);",
          "writeFileSync(process.argv[outputIndex + 1], `config=${configPath}\\ncl=0.42\\n`, 'utf8');",
          "console.log('SU2 harness completed');"
        ].join("\n"),
        "utf8"
      );

      const input = runInput(["EngineeringProgramTool"]);
      input.project.autonomyPolicy.allowCodeExecution = true;
      input.researchPlan = {
        ...input.researchPlan!,
        programRequests: [{ kind: "su2-case-run", target: "su2", outputFileName: "su2-result.txt" }]
      };
      const result = await new EngineeringProgramTool().run(input, {
        ...settings,
        allowCodeExecution: true,
        engineeringTools: {
          ...settings.engineeringTools,
          enabled: true,
          su2: {
            ...settings.engineeringTools.su2,
            enabled: true,
            command: process.execPath,
            caseRoot,
            configFile: "case.cfg",
            runArgsTemplate: [runnerPath, "{config}", "--output", "{output}"],
            probeArgs: ["--version"]
          }
        }
      });

      expect(result.toolRun.status).toBe("completed");
      expect(result.artifacts[0]?.content).toContain("su2-result.txt");
      expect(result.artifacts[0]?.content).toContain("cl=0.42");
      expect(result.evidence[0]?.metadata).toMatchObject({ program: "su2", traceabilityKind: "tool_observation" });
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("fails closed for SU2 case runs without explicit config file and target", async () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "aetherops-su2-explicit-contract-"));
    try {
      const caseRoot = join(tempRoot, "case");
      mkdirSync(caseRoot, { recursive: true });
      writeFileSync(join(caseRoot, "case.cfg"), "SOLVER= EULER\nMESH_FILENAME= mesh.su2\n", "utf8");

      const withoutConfig = runInput(["EngineeringProgramTool"]);
      withoutConfig.project.autonomyPolicy.allowCodeExecution = true;
      withoutConfig.researchPlan = {
        ...withoutConfig.researchPlan!,
        programRequests: [{ kind: "su2-case-run", target: "su2", outputFileName: "su2-result.txt" }]
      };
      const missingConfigResult = await new EngineeringProgramTool().run(withoutConfig, {
        ...settings,
        allowCodeExecution: true,
        engineeringTools: {
          ...settings.engineeringTools,
          enabled: true,
          su2: {
            ...settings.engineeringTools.su2,
            enabled: true,
            command: process.execPath,
            caseRoot,
            configFile: "",
            runArgsTemplate: ["{config}", "--output", "{output}"],
            probeArgs: ["--version"]
          }
        }
      });

      expect(missingConfigResult.toolRun.status).toBe("failed");
      expect(missingConfigResult.toolRun.error).toContain("config file");
      expect(missingConfigResult.artifacts).toHaveLength(0);
      expect(missingConfigResult.evidence).toHaveLength(0);

      const withoutTarget = runInput(["EngineeringProgramTool"]);
      withoutTarget.project.autonomyPolicy.allowCodeExecution = true;
      withoutTarget.researchPlan = {
        ...withoutTarget.researchPlan!,
        programRequests: [{ kind: "su2-case-run", outputFileName: "su2-result.txt" }]
      };
      const missingTargetResult = await new EngineeringProgramTool().run(withoutTarget, {
        ...settings,
        allowCodeExecution: true,
        engineeringTools: {
          ...settings.engineeringTools,
          enabled: true,
          su2: {
            ...settings.engineeringTools.su2,
            enabled: true,
            command: process.execPath,
            caseRoot,
            configFile: "case.cfg",
            runArgsTemplate: ["{config}", "--output", "{output}"],
            probeArgs: ["--version"]
          }
        }
      });

      expect(missingTargetResult.toolRun.status).toBe("failed");
      expect(missingTargetResult.toolRun.error).toContain("requires target su2");
      expect(missingTargetResult.artifacts).toHaveLength(0);
      expect(missingTargetResult.evidence).toHaveLength(0);
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("runs a FreeCAD-compatible headless script only from explicit settings", async () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "aetherops-freecad-run-"));
    try {
      const scriptPath = join(tempRoot, "freecad-runner.mjs");
      writeFileSync(
        scriptPath,
        [
          "import { writeFileSync } from 'node:fs';",
          "const outputIndex = process.argv.indexOf('--output');",
          "if (outputIndex < 0) process.exit(2);",
          "writeFileSync(process.argv[outputIndex + 1], JSON.stringify({ program: 'freecad', solids: 1, units: 'mm' }) + '\\n', 'utf8');",
          "console.log('FreeCAD harness completed');"
        ].join("\n"),
        "utf8"
      );

      const input = runInput(["EngineeringProgramTool"]);
      input.project.autonomyPolicy.allowCodeExecution = true;
      input.researchPlan = {
        ...input.researchPlan!,
        programRequests: [{ kind: "cad-script-run", target: "freecad", outputFileName: "freecad-result.json" }]
      };
      const result = await new EngineeringProgramTool().run(input, {
        ...settings,
        allowCodeExecution: true,
        engineeringTools: {
          ...settings.engineeringTools,
          enabled: true,
          freeCad: {
            ...settings.engineeringTools.freeCad,
            enabled: true,
            command: process.execPath,
            scriptPath,
            runArgsTemplate: ["{script}", "--output", "{output}"],
            probeArgs: ["--version"]
          }
        }
      });

      expect(result.toolRun.status).toBe("completed");
      expect(result.artifacts[0]?.content).toContain("freecad-result.json");
      expect(result.artifacts[0]?.content).toContain("solids");
      expect(result.evidence[0]?.metadata).toMatchObject({ program: "freecad", traceabilityKind: "tool_observation" });
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("runs an OpenVSP-compatible headless script only from explicit settings", async () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "aetherops-openvsp-run-"));
    try {
      const scriptPath = join(tempRoot, "openvsp-runner.mjs");
      writeFileSync(
        scriptPath,
        [
          "import { writeFileSync } from 'node:fs';",
          "const outputIndex = process.argv.indexOf('--output');",
          "if (outputIndex < 0) process.exit(2);",
          "writeFileSync(process.argv[outputIndex + 1], JSON.stringify({ program: 'openvsp', components: 2, units: 'm' }) + '\\n', 'utf8');",
          "console.log('OpenVSP harness completed');"
        ].join("\n"),
        "utf8"
      );

      const input = runInput(["EngineeringProgramTool"]);
      input.project.autonomyPolicy.allowCodeExecution = true;
      input.researchPlan = {
        ...input.researchPlan!,
        programRequests: [{ kind: "vsp-script-run", target: "openvsp", outputFileName: "openvsp-result.json" }]
      };
      const result = await new EngineeringProgramTool().run(input, {
        ...settings,
        allowCodeExecution: true,
        engineeringTools: {
          ...settings.engineeringTools,
          enabled: true,
          openVsp: {
            ...settings.engineeringTools.openVsp,
            enabled: true,
            command: process.execPath,
            scriptPath,
            runArgsTemplate: ["{script}", "--output", "{output}"],
            probeArgs: ["--version"]
          }
        }
      });

      expect(result.toolRun.status).toBe("completed");
      expect(result.artifacts[0]?.content).toContain("openvsp-result.json");
      expect(result.artifacts[0]?.content).toContain("components");
      expect(result.evidence[0]?.metadata).toMatchObject({ program: "openvsp", traceabilityKind: "tool_observation" });
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("fails closed for XFOIL polar requests when no XFOIL command is configured", async () => {
    const input = runInput(["EngineeringProgramTool"]);
    input.project.autonomyPolicy.allowCodeExecution = true;
    input.researchPlan = {
      ...input.researchPlan!,
      programRequests: [{ kind: "xfoil-polar", target: "xfoil", naca: "2412", reynolds: 1_000_000, alphaStart: -2, alphaEnd: 4, alphaStep: 2 }]
    };

    const result = await new EngineeringProgramTool().run(input, {
      ...settings,
      allowCodeExecution: true,
      engineeringTools: {
        ...settings.engineeringTools,
        enabled: true,
        xfoil: { ...settings.engineeringTools.xfoil, enabled: false, command: "" }
      }
    });

    expect(result.toolRun.status).toBe("failed");
    expect(result.toolRun.error).toContain("configured XFOIL command");
    expect(result.artifacts).toHaveLength(0);
    expect(result.evidence).toHaveLength(0);
  });

  it("fails closed for SU2 case runs when the args template omits the config placeholder", async () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "aetherops-su2-fail-"));
    try {
      const caseRoot = join(tempRoot, "case");
      mkdirSync(caseRoot, { recursive: true });
      writeFileSync(join(caseRoot, "case.cfg"), "SOLVER= EULER\nMESH_FILENAME= mesh.su2\n", "utf8");
      const input = runInput(["EngineeringProgramTool"]);
      input.project.autonomyPolicy.allowCodeExecution = true;
      input.researchPlan = {
        ...input.researchPlan!,
        programRequests: [{ kind: "su2-case-run", target: "su2", outputFileName: "su2-result.txt" }]
      };

      const result = await new EngineeringProgramTool().run(input, {
        ...settings,
        allowCodeExecution: true,
        engineeringTools: {
          ...settings.engineeringTools,
          enabled: true,
          su2: {
            ...settings.engineeringTools.su2,
            enabled: true,
            command: process.execPath,
            caseRoot,
            configFile: "case.cfg",
            runArgsTemplate: ["--output", "{output}"],
            probeArgs: ["--version"]
          }
        }
      });

      expect(result.toolRun.status).toBe("failed");
      expect(result.toolRun.error).toContain("{config}");
      expect(result.artifacts).toHaveLength(0);
      expect(result.evidence).toHaveLength(0);
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("fails closed for OpenVSP script runs when the args template omits the script placeholder", async () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "aetherops-openvsp-fail-"));
    try {
      const scriptPath = join(tempRoot, "openvsp-runner.mjs");
      writeFileSync(scriptPath, "console.log('should not run without explicit script placeholder');\n", "utf8");
      const input = runInput(["EngineeringProgramTool"]);
      input.project.autonomyPolicy.allowCodeExecution = true;
      input.researchPlan = {
        ...input.researchPlan!,
        programRequests: [{ kind: "vsp-script-run", target: "openvsp", outputFileName: "openvsp-result.json" }]
      };

      const result = await new EngineeringProgramTool().run(input, {
        ...settings,
        allowCodeExecution: true,
        engineeringTools: {
          ...settings.engineeringTools,
          enabled: true,
          openVsp: {
            ...settings.engineeringTools.openVsp,
            enabled: true,
            command: process.execPath,
            scriptPath,
            runArgsTemplate: ["--output", "{output}"],
            probeArgs: ["--version"]
          }
        }
      });

      expect(result.toolRun.status).toBe("failed");
      expect(result.toolRun.error).toContain("{script}");
      expect(result.artifacts).toHaveLength(0);
      expect(result.evidence).toHaveLength(0);
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("fails closed for commercial CFD runs when args template is not configured", async () => {
    const input = runInput(["EngineeringProgramTool"]);
    input.project.autonomyPolicy.allowCodeExecution = true;
    input.researchPlan = {
      ...input.researchPlan!,
      programRequests: [{ kind: "commercial-cfd-run", target: "flightstream", outputFileName: "result.txt" }]
    };

    const result = await new EngineeringProgramTool().run(input, {
      ...settings,
      allowCodeExecution: true,
      engineeringTools: {
        ...settings.engineeringTools,
        enabled: true,
        commercialCfd: {
          ...settings.engineeringTools.commercialCfd,
          flightStreamConfigured: true,
          flightStreamCommand: "flightstream.exe",
          flightStreamRunArgsTemplate: []
        }
      }
    });

    expect(result.toolRun.status).toBe("failed");
    expect(result.toolRun.error).toContain("runArgsTemplate");
    expect(result.artifacts).toHaveLength(0);
    expect(result.evidence).toHaveLength(0);
  });

  it("fetches web sources before evidence URLs, dedupes normalized URLs, caps at three, and reports partial failures as completed", async () => {
    const input = {
      ...runInput(),
      sources: [
        webSource("s1", "https://Example.edu/a#section"),
        webSource("s2", "https://example.edu/a"),
        { ...webSource("s3", "https://example.edu/ignored-paper"), kind: "paper" as const },
        webSource("s4", "https://example.edu/fail")
      ],
      evidence: [
        { id: "e1", projectId: "project-1", category: "web_source" as const, title: "Evidence URL", summary: "Summary", sourceUri: "https://example.edu/evidence", keywords: [], linkedHypothesisIds: [], createdAt },
        { id: "e2", projectId: "project-1", category: "web_source" as const, title: "Capped URL", summary: "Summary", sourceUri: "https://example.edu/capped", keywords: [], linkedHypothesisIds: [], createdAt }
      ]
    };
    const fetched: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        fetched.push(url);
        if (url.includes("/fail")) {
          return { ok: false, status: 500, statusText: "Nope", url, headers: new Headers(), text: async () => "" };
        }
        return {
          ok: true,
          status: 200,
          statusText: "OK",
          url,
          headers: new Headers({ "content-type": "text/html" }),
          text: async () => `<html><title>${url}</title><body>Readable text for ${url}</body></html>`
        };
      })
    );

    const result = await new WebFetchTool().run(input, settings);

    expect(result.toolRun.status).toBe("completed");
    expect((result.toolRun.output as { urls: string[] }).urls).toEqual(["https://Example.edu/a#section", "https://example.edu/fail", "https://example.edu/evidence"]);
    expect(fetched).toEqual(expect.arrayContaining(["https://Example.edu/a#section", "https://example.edu/fail", "https://example.edu/evidence"]));
    expect(result.evidence).toHaveLength(2);
    expect(result.sources).toHaveLength(2);
    expect(result.toolRun.output).toMatchObject({
      fetchedPages: 2,
      failedUrls: ["https://example.edu/fail"],
      failureReasons: { "https://example.edu/fail": "fetch failed for https://example.edu/fail: 500 Nope" },
      duplicateUrls: ["https://example.edu/a"],
      skippedUrls: []
    });
  });

  it("fetches from ResearchPlan.fetchCandidateUrls before source and citation candidates", async () => {
    const input = {
      ...runInput(["WebFetchTool"]),
      researchPlan: {
        ...runInput(["WebFetchTool"]).researchPlan!,
        fetchCandidateUrls: ["https://example.edu/from-plan"]
      },
      sources: [webSource("s1", "https://example.edu/from-source")],
      evidence: [
        { id: "e1", projectId: "project-1", category: "web_source" as const, title: "Citation URL", summary: "Summary", citation: "See https://example.edu/from-citation", keywords: [], linkedHypothesisIds: [], createdAt }
      ]
    };
    const fetched: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        fetched.push(url);
        return {
          ok: true,
          status: 200,
          statusText: "OK",
          url,
          headers: new Headers({ "content-type": "text/html" }),
          text: async () => `<html><title>${url}</title><body>Readable text for ${url}</body></html>`
        };
      })
    );

    const result = await new WebFetchTool().run(input, settings);

    expect(result.toolRun.status).toBe("completed");
    expect((result.toolRun.output as { urls: string[] }).urls[0]).toBe("https://example.edu/from-plan");
    expect(fetched).toContain("https://example.edu/from-source");
    expect(fetched).toContain("https://example.edu/from-citation");
  });

  it("fetches up to two URLs concurrently while preserving failure mapping order", async () => {
    const input = {
      ...runInput(["WebFetchTool"]),
      sources: [
        webSource("one", "https://93.184.216.34/one"),
        webSource("two", "https://93.184.216.34/two"),
        webSource("three", "https://93.184.216.34/three")
      ]
    };
    const started: string[] = [];
    let inFlight = 0;
    let maxInFlight = 0;
    const pending: Array<{ url: string; resolve: (value: unknown) => void }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) => {
        started.push(url);
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        return new Promise((resolve) => {
          pending.push({
            url,
            resolve: (value) => {
              inFlight -= 1;
              resolve(value);
            }
          });
        });
      })
    );

    const running = new WebFetchTool().run(input, settings);
    await vi.waitFor(() => expect(started).toHaveLength(2));
    expect(started).toEqual(["https://93.184.216.34/one", "https://93.184.216.34/two"]);
    pending.find((item) => item.url.endsWith("/one"))?.resolve(successResponse("https://93.184.216.34/one"));
    await vi.waitFor(() => expect(started).toHaveLength(3));
    expect(started).toEqual(["https://93.184.216.34/one", "https://93.184.216.34/two", "https://93.184.216.34/three"]);
    pending.find((item) => item.url.endsWith("/three"))?.resolve(successResponse("https://93.184.216.34/three"));
    pending.find((item) => item.url.endsWith("/two"))?.resolve({
      ok: false,
      status: 503,
      statusText: "Slow Fail",
      url: "https://93.184.216.34/two",
      headers: new Headers(),
      text: async () => ""
    });

    const result = await running;

    expect(maxInFlight).toBe(2);
    expect(result.toolRun.status).toBe("completed");
    expect(result.evidence.map((item) => item.sourceUri)).toEqual(["https://93.184.216.34/one", "https://93.184.216.34/three"]);
    expect(result.toolRun.output).toMatchObject({
      failedUrls: ["https://93.184.216.34/two"],
      failureReasons: {
        "https://93.184.216.34/two": "fetch failed for https://93.184.216.34/two: 503 Slow Fail"
      }
    });
  });

  it("blocks internal WebFetch URLs before fetch and records failure reasons", async () => {
    const input = {
      ...runInput(["WebFetchTool"]),
      sources: [
        webSource("localhost", "http://localhost/admin"),
        webSource("loopback", "http://127.0.0.1/admin"),
        webSource("private", "http://10.1.2.3/admin"),
        webSource("internal", "https://service.internal/status")
      ]
    };
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    const result = await new WebFetchTool().run(input, settings);

    expect(result.toolRun.status).toBe("failed");
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(result.sources).toHaveLength(0);
    expect(result.evidence).toHaveLength(0);
    expect(result.toolRun.output).toMatchObject({
      fetchedPages: 0,
      failedUrls: ["http://localhost/admin", "http://127.0.0.1/admin", "http://10.1.2.3/admin"],
      skippedUrls: [],
      duplicateUrls: []
    });
    expect((result.toolRun.output as { failureReasons: Record<string, string> }).failureReasons["http://localhost/admin"]).toContain("blocked internal hostname");
    expect((result.toolRun.output as { failureReasons: Record<string, string> }).failureReasons["http://127.0.0.1/admin"]).toContain("blocked internal IP address");
  });

  it("rejects unsafe redirects, unsupported content types, and oversized responses", async () => {
    const input = {
      ...runInput(["WebFetchTool"]),
      sources: [
        webSource("redirect", "https://example.edu/redirect"),
        webSource("image", "https://example.edu/image"),
        webSource("large", "https://example.edu/large")
      ]
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        expect(init?.signal).toBeDefined();
        if (url.includes("/redirect")) {
          return {
            ok: true,
            status: 200,
            statusText: "OK",
            url: "http://127.0.0.1/metadata",
            headers: new Headers({ "content-type": "text/html" }),
            text: async () => "<html><title>Redirected</title><body>Internal redirect.</body></html>"
          };
        }
        if (url.includes("/image")) {
          return {
            ok: true,
            status: 200,
            statusText: "OK",
            url,
            headers: new Headers({ "content-type": "image/png" }),
            text: async () => "not text"
          };
        }
        return {
          ok: true,
          status: 200,
          statusText: "OK",
          url,
          headers: new Headers({ "content-type": "text/plain", "content-length": String(2 * 1024 * 1024 + 1) }),
          text: async () => "oversized"
        };
      })
    );

    const result = await new WebFetchTool().run(input, settings);

    expect(result.toolRun.status).toBe("failed");
    expect(result.sources).toHaveLength(0);
    expect(result.evidence).toHaveLength(0);
    const output = result.toolRun.output as { failedUrls: string[]; failureReasons: Record<string, string>; fetchedPages: number };
    expect(output.fetchedPages).toBe(0);
    expect(output.failedUrls).toEqual(["https://example.edu/redirect", "https://example.edu/image", "https://example.edu/large"]);
    expect(output.failureReasons["https://example.edu/redirect"]).toContain("blocked internal IP address");
    expect(output.failureReasons["https://example.edu/image"]).toContain("unsupported content-type");
    expect(output.failureReasons["https://example.edu/large"]).toContain("content-length exceeds 2MB");
  });

  it("returns a failed tool run when every selected URL fails so ToolRunner rejects it", async () => {
    const input = { ...runInput(["WebFetchTool"]), sources: [webSource("s1", "https://example.edu/fail")] };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => ({ ok: false, status: 503, statusText: "Unavailable", url, headers: new Headers(), text: async () => "" }))
    );

    const result = await new WebFetchTool().run(input, settings);
    expect(result.toolRun.status).toBe("failed");
    await expect(new ToolRunner([new WebFetchTool()]).runAll(input, settings)).rejects.toBeInstanceOf(ToolRunnerError);
  });

  it("blocks WebFetchTool direct runs when external search is disabled", async () => {
    const input = { ...runInput(["WebFetchTool"]), sources: [webSource("s1", "https://example.edu/a")] };
    await expect(new WebFetchTool().run(input, { ...settings, allowExternalSearch: false })).rejects.toThrow("external network access");
  });

  it("blocks private or local fetch targets before calling fetch", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const blockedUrls = [
      "http://localhost:3000",
      "http://127.0.0.1",
      "http://169.254.169.254"
    ];

    const result = await new WebFetchTool().run(
      { ...runInput(["WebFetchTool"]), sources: blockedUrls.map((url, index) => webSource(`blocked-${index}`, url)) },
      settings
    );

    expect(result.toolRun.status).toBe("failed");
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(result.toolRun.output).toMatchObject({ failedUrls: blockedUrls });
  });

  it("blocks IPv6 private, loopback, unspecified, and multicast fetch targets before calling fetch", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const blockedUrls = [
      "http://[::1]",
      "http://[::]",
      "http://[fc00::1]"
    ];

    const result = await new WebFetchTool().run(
      { ...runInput(["WebFetchTool"]), sources: blockedUrls.map((url, index) => webSource(`blocked-${index}`, url)) },
      settings
    );

    expect(result.toolRun.status).toBe("failed");
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(result.toolRun.output).toMatchObject({ failedUrls: blockedUrls });
  });

  it("blocks IPv6 link-local and multicast fetch targets before calling fetch", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const blockedUrls = ["http://[fe80::1]", "http://[ff02::1]"];

    const result = await new WebFetchTool().run(
      { ...runInput(["WebFetchTool"]), sources: blockedUrls.map((url, index) => webSource(`blocked-v6-${index}`, url)) },
      settings
    );

    expect(result.toolRun.status).toBe("failed");
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(result.toolRun.output).toMatchObject({ failedUrls: blockedUrls });
  });

  it("records body read timeout for slow HTML response streams", async () => {
    vi.useFakeTimers();
    const input = { ...runInput(["WebFetchTool"]), sources: [webSource("slow", "https://93.184.216.34/slow")] };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => ({
        ok: true,
        status: 200,
        statusText: "OK",
        url,
        headers: new Headers({ "content-type": "text/html" }),
        body: {
          getReader: () => ({
            read: () => new Promise<ReadableStreamReadResult<Uint8Array>>(() => undefined),
            cancel: () => Promise.resolve()
          })
        }
      }))
    );

    const pending = new WebFetchTool().run(input, settings);
    await vi.advanceTimersByTimeAsync(10_050);
    const result = await pending;

    expect(result.toolRun.status).toBe("failed");
    expect((result.toolRun.output as { failureReasons: Record<string, string> }).failureReasons["https://93.184.216.34/slow"]).toContain("body read timeout");
  });

  it("records PDF body read timeout for slow PDF streams", async () => {
    vi.useFakeTimers();
    const input = {
      ...runInput(["PdfIngestionTool"]),
      researchPlan: { ...runInput(["PdfIngestionTool"]).researchPlan!, fetchCandidateUrls: ["https://93.184.216.34/paper.pdf"] }
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => ({
        ok: true,
        status: 200,
        statusText: "OK",
        url,
        headers: new Headers({ "content-type": "application/pdf" }),
        body: {
          getReader: () => ({
            read: () => new Promise<ReadableStreamReadResult<Uint8Array>>(() => undefined),
            cancel: () => Promise.resolve()
          })
        }
      }))
    );

    const pending = new PdfIngestionTool().run(input, settings);
    await vi.advanceTimersByTimeAsync(10_050);
    const result = await pending;

    expect(result.toolRun.status).toBe("failed");
    expect((result.toolRun.output as { failureReasons: Record<string, string> }).failureReasons["https://93.184.216.34/paper.pdf"]).toContain("PDF body read timeout");
  });

  it("decodes Korean legacy charset pages without mojibake", async () => {
    const input = { ...runInput(["WebFetchTool"]), sources: [webSource("korean", "https://93.184.216.34/korean")] };
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(Uint8Array.from([0xc7, 0xd1, 0xb1, 0xdb]), {
          status: 200,
          headers: { "content-type": "text/plain; charset=euc-kr" }
        })
      )
    );

    const result = await new WebFetchTool().run(input, settings);

    expect(result.toolRun.status).toBe("completed");
    expect(result.evidence[0]?.quote).toContain("한글");
    expect(result.evidence[0]?.quote).not.toMatch(/[?]{2,}|\uFFFD/);
  });

  it("uses HTML meta charset when content-type has no charset", async () => {
    const input = { ...runInput(["WebFetchTool"]), sources: [webSource("korean-meta", "https://93.184.216.34/korean-meta")] };
    const prefix = new TextEncoder().encode('<html><head><meta charset="cp949"></head><body>');
    const suffix = new TextEncoder().encode("</body></html>");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(Uint8Array.from([...prefix, 0xc7, 0xd1, 0xb1, 0xdb, ...suffix]), {
          status: 200,
          headers: { "content-type": "text/html" }
        })
      )
    );

    const result = await new WebFetchTool().run(input, settings);

    expect(result.toolRun.status).toBe("completed");
    expect(result.evidence[0]?.quote).toContain("한글");
    expect(result.evidence[0]?.quote).not.toMatch(/[?]{2,}|\uFFFD/);
  });

  it("decodes common Korean charset aliases across split stream chunks", async () => {
    const input = { ...runInput(["WebFetchTool"]), sources: [webSource("korean-ms949", "https://93.184.216.34/korean-ms949")] };
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(Uint8Array.from([0xc7]));
              controller.enqueue(Uint8Array.from([0xd1, 0xb1]));
              controller.enqueue(Uint8Array.from([0xdb]));
              controller.close();
            }
          }),
          {
            status: 200,
            headers: { "content-type": "text/plain; charset=ms949" }
          }
        )
      )
    );

    const result = await new WebFetchTool().run(input, settings);

    expect(result.toolRun.status).toBe("completed");
    expect(result.evidence[0]?.quote).toContain("한글");
    expect(result.evidence[0]?.quote).not.toMatch(/[?]{2,}|\uFFFD/);
  });

  it("uses x-windows-949 HTML meta charset aliases", async () => {
    const input = { ...runInput(["WebFetchTool"]), sources: [webSource("korean-meta-alias", "https://93.184.216.34/korean-meta-alias")] };
    const prefix = new TextEncoder().encode('<html><head><meta charset="x-windows-949"></head><body>');
    const suffix = new TextEncoder().encode("</body></html>");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(Uint8Array.from([...prefix, 0xc7, 0xd1, 0xb1, 0xdb, ...suffix]), {
          status: 200,
          headers: { "content-type": "text/html" }
        })
      )
    );

    const result = await new WebFetchTool().run(input, settings);

    expect(result.toolRun.status).toBe("completed");
    expect(result.evidence[0]?.quote).toContain("한글");
    expect(result.evidence[0]?.quote).not.toMatch(/[?]{2,}|\uFFFD/);
  });

  it("fails closed for unsupported or invalid text encodings without creating evidence", async () => {
    const input = {
      ...runInput(["WebFetchTool"]),
      sources: [
        webSource("unsupported-charset", "https://example.com/unsupported-charset"),
        webSource("missing-charset", "https://example.com/missing-charset"),
        webSource("replacement", "https://example.com/replacement")
      ]
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.includes("unsupported")) {
          return new Response("hello", { status: 200, headers: { "content-type": "text/plain; charset=made-up-charset" } });
        }
        if (url.includes("missing")) {
          return new Response(Uint8Array.from([0xc7, 0xd1, 0xb1, 0xdb]), { status: 200, headers: { "content-type": "text/plain" } });
        }
        return new Response("bad \uFFFD text", { status: 200, headers: { "content-type": "text/plain; charset=utf-8" } });
      })
    );

    const result = await new WebFetchTool().run(input, settings);
    const failureReasons = (result.toolRun.output as { failureReasons: Record<string, string> }).failureReasons;

    expect(result.toolRun.status).toBe("failed");
    expect(result.evidence).toHaveLength(0);
    expect(failureReasons["https://example.com/unsupported-charset"]).toContain("unsupported charset");
    expect(failureReasons["https://example.com/missing-charset"]).toContain("invalid text encoding");
    expect(failureReasons["https://example.com/replacement"]).toContain("replacement characters");
  });

  it("rejects oversized and non-text responses without creating evidence", async () => {
    const input = { ...runInput(["WebFetchTool"]), sources: [webSource("s1", "https://example.com/huge"), webSource("s2", "https://example.com/image")] };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => ({
        ok: true,
        status: 200,
        statusText: "OK",
        url,
        headers: url.includes("huge")
          ? new Headers({ "content-type": "text/html", "content-length": String(2 * 1024 * 1024 + 1) })
          : new Headers({ "content-type": "image/png" }),
        text: async () => "should not become evidence"
      }))
    );

    const result = await new WebFetchTool().run(input, settings);

    expect(result.toolRun.status).toBe("failed");
    expect(result.evidence).toHaveLength(0);
    expect(Object.values((result.toolRun.output as { failureReasons: Record<string, string> }).failureReasons).join(" ")).toMatch(/content-length|content-type/);
  });
});

describe("DataAnalysisTool", () => {
  it("returns expanded distributions and does not create evidence", async () => {
    const input = {
      ...runInput(["DataAnalysisTool"]),
      evidence: [
        { id: "e1", projectId: "project-1", category: "web_source" as const, title: "Evidence 1", summary: "Summary", citation: "Citation", sourceUri: "https://example.edu/one", keywords: ["scholarly"], linkedHypothesisIds: ["h1"], createdAt },
        { id: "e2", projectId: "project-1", category: "web_source" as const, title: "Evidence 2", summary: "Summary", keywords: ["weak"], linkedHypothesisIds: [], createdAt }
      ],
      sources: [webSource("s1", "https://example.edu/one")],
      artifacts: [{ id: "a1", projectId: "project-1", category: "generated_artifact" as const, title: "Artifact", relativePath: "artifact.md", mimeType: "text/markdown", summary: "Summary", createdAt }],
      toolRuns: [{ id: "tool-1", projectId: "project-1", iteration: 1, toolName: "WebFetchTool", input: {}, output: {}, status: "completed" as const, startedAt: createdAt, completedAt: createdAt }],
      normalizedRecords: [
        {
          id: "r1",
          projectId: "project-1",
          memoryScope: "global" as const,
          validationStatus: "validated" as const,
          iteration: 1,
          kind: "evidence" as const,
          title: "Record 1",
          content: "Record content",
          evidenceId: "e1",
          metadata: { canSupportHypothesis: true, sourceQualityTier: "scholarly", traceabilityKind: "external_source" },
          createdAt
        },
        {
          id: "r2",
          projectId: "project-1",
          memoryScope: "project_only" as const,
          validationStatus: "rejected" as const,
          iteration: 1,
          kind: "artifact" as const,
          title: "Record 2",
          content: "Record content",
          metadata: { canSupportHypothesis: false, sourceQualityTier: "weak", traceabilityKind: "internal_artifact" },
          createdAt
        }
      ],
      validationResults: [
        {
          id: "v1",
          projectId: "project-1",
          iteration: 1,
          hypothesisId: "h1",
          status: "partially_supported" as const,
          confidence: 0.5,
          supportingEvidenceIds: ["e1"],
          contradictingEvidenceIds: [],
          relatedEntityIds: [],
          relatedRelationIds: [],
          reasoningSummary: "Partial support.",
          limitations: [],
          evidenceGaps: ["Need a stronger source."],
          createdAt
        }
      ]
    };

    const result = await new DataAnalysisTool().run(input);

    expect(result.evidence).toEqual([]);
    expect(result.sources).toEqual([]);
    expect(result.artifacts).toEqual([]);
    expect(result.toolRun.output).toMatchObject({
      evidenceCount: 2,
      supportEligibleEvidenceCount: 1,
      citationCoverage: 0.5,
      sourceQualityDistribution: { scholarly: 2, weak: 2 },
      traceabilityKindDistribution: { external_source: 1, internal_artifact: 1 },
      hypothesisEvidenceCoverage: { h1: { linkedEvidenceCount: 1, supportEligibleEvidenceCount: 1 } },
      validationStatusDistribution: { partially_supported: 1 },
      iterationGrowthSummary: {
        iteration: 1,
        evidenceCount: 2,
        artifactCount: 1,
        sourceCount: 1,
        toolRunCount: 1,
        normalizedRecordCount: 2,
        validationResultCount: 1,
        projectContextSnapshotCount: 0,
        synthesizedResultCount: 0
      },
      inputAvailability: {
        normalizedRecordCount: 2,
        validationResultCount: 1,
        projectContextSnapshotCount: 0,
        resultCount: 0
      },
      missingInputWarnings: ["projectContextSnapshots input was not available; context coverage analysis may be incomplete."],
      evidenceGapsFromLatestValidation: ["Need a stronger source."]
    });
  });

  it("reports missing analysis inputs explicitly", async () => {
    const result = await new DataAnalysisTool().run({ ...runInput(["DataAnalysisTool"]), evidence: [] });

    expect(result.toolRun.output).toMatchObject({
      supportEligibleEvidenceCount: 0,
      inputAvailability: {
        normalizedRecordCount: 0,
        validationResultCount: 0,
        projectContextSnapshotCount: 0
      },
      missingInputWarnings: expect.arrayContaining([
        "normalizedRecords input was not available; support eligibility may be undercounted.",
        "validationResults input was not available; latest evidence gaps may be incomplete."
      ])
    });
  });
});

function webSource(id: string, url: string): ResearchSource {
  return { id, projectId: "project-1", kind: "web", title: id, url, retrievedAt: createdAt, metadata: {}, createdAt };
}

function successResponse(url: string): unknown {
  return {
    ok: true,
    status: 200,
    statusText: "OK",
    url,
    headers: new Headers({ "content-type": "text/html" }),
    text: async () => `<html><title>${url}</title><body>Readable text for ${url}</body></html>`
  };
}
