import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ResearchLoopStep, type AppSettings, type OpenCodeRunInput, type ResearchProject } from "../../../core/shared/types.js";
import { RealOpenCodeAdapter } from "./realOpenCodeAdapter.js";

let tempDir: string | undefined;

afterEach(() => {
  if (tempDir) {
    rmSync(tempDir, { recursive: true, force: true });
    tempDir = undefined;
  }
});

describe("RealOpenCodeAdapter", () => {
  it("parses OpenCode json text events as the final schema", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "aetherops-real-opencode-"));
    const command = createFakeOpenCodeCommand(tempDir);
    const adapter = new RealOpenCodeAdapter(() => settings(command));

    const output = await adapter.run(input());

    expect(output.run.status).toBe("completed");
    expect(output.run.logs[0]).toContain("parsed from OpenCode text event");
    expect(output.nextActions).toEqual([]);
    expect(output.needsMoreEvidence).toBe(false);
    expect(output.needsMoreAnalysis).toBe(false);
    expect(output.fatalError).toBeUndefined();
  });

  it("includes bounded tool context and optimization execution instructions in the OpenCode prompt", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "aetherops-real-opencode-context-"));
    const command = createFakeOpenCodeCommand(tempDir);
    const adapter = new RealOpenCodeAdapter(() => settings(command));

    const run = await adapter.createRunAttempt(inputWithOptimizationContext());

    expect(run.prompt).toContain("ToolContext:");
    expect(run.prompt).toContain("Optimization execution contract:");
    expect(run.prompt).toContain("Optimization Code");
    expect(run.prompt).toContain("Optimization Result");
    expect(run.prompt).toContain("CLARK Y AIRFOIL");
    expect(run.prompt).toContain("\"alpha\":6");
    expect(run.prompt).toContain("\"cl\":1.0328");
  });

  it("accepts validated OpenCode optimization files when stdout JSON is missing", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "aetherops-real-opencode-files-"));
    const command = createOptimizationFilesInvalidJsonCommand(tempDir);
    const adapter = new RealOpenCodeAdapter(() => settings(command));

    const output = await adapter.run(inputWithOptimizationContext());

    expect(output.run.status).toBe("completed");
    expect(output.run.toolPlan).toContain("OpenCodeFilesystemArtifactValidation");
    expect(output.run.metadata?.completionSource).toBe("opencode-filesystem-artifacts");
    expect(output.artifacts.map((artifact) => artifact.title)).toContain("Optimization Code");
    expect(output.artifacts.map((artifact) => artifact.title)).toContain("Optimization Result");
    expect(output.observations?.[0]?.content).toContain("alpha=6");
    expect(output.observations?.[0]?.content).toContain("L/D=113.6193619361936");
    expect(output.toolRuns?.[0]?.toolName).toBe("OpenCodeStructuredOutput");
  });

  it("downgrades legacy OpenCode evidence into non-support claims and source candidates", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "aetherops-real-opencode-legacy-"));
    const command = createFakeOpenCodeCommand(tempDir, {
      summary: "legacy evidence returned",
      toolPlan: ["legacy"],
      artifacts: [],
      evidence: [
        {
          category: "web_source",
          title: "Invented-looking evidence",
          summary: "This must not be stored as EvidenceItem.",
          sourceUri: "https://example.com/source",
          citation: "Example source",
          quote: "Quote"
        }
      ],
      nextActions: [],
      needsMoreEvidence: true,
      needsMoreAnalysis: false
    });
    const adapter = new RealOpenCodeAdapter(() => settings(command));

    const output = await adapter.run(input());

    expect(output.evidence).toEqual([]);
    expect(output.run.evidenceIds).toEqual([]);
    expect(output.claims?.[0]).toMatchObject({ title: "Invented-looking evidence", sourceUri: "https://example.com/source" });
    expect(output.sources?.[0]).toMatchObject({ url: "https://example.com/source", metadata: expect.objectContaining({ sourceCandidateOnly: true }) });
    expect(output.sourceCandidates?.[0]).toMatchObject({ url: "https://example.com/source", metadata: expect.objectContaining({ sourceCandidateOnly: true }) });
    expect(output.toolRuns?.[0]?.toolName).toBe("OpenCodeStructuredOutput");
  });

  it("rejects invalid UTF-8 OpenCode output before parsing", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "aetherops-real-opencode-invalid-"));
    const command = createInvalidUtf8OpenCodeCommand(tempDir);
    const adapter = new RealOpenCodeAdapter(() => settings(command));

    await expect(adapter.run(input())).rejects.toThrow("OpenCode stdout is not valid UTF-8");
  });
});

function createFakeOpenCodeCommand(root: string, payload?: Record<string, unknown>): string {
  mkdirSync(root, { recursive: true });
  const event = JSON.stringify({
    type: "text",
    part: {
      text: JSON.stringify(payload ?? {
        summary: "parsed from OpenCode text event",
        toolPlan: ["self-check"],
        artifacts: [],
        claims: [],
        observations: [],
        sourceCandidates: [],
        nextActions: [],
        needsMoreEvidence: false,
        needsMoreAnalysis: false
      })
    }
  });

  if (process.platform === "win32") {
    const command = join(root, "fake-opencode.cmd");
    writeFileSync(command, `@echo off\r\necho ${event}\r\nexit /b 0\r\n`, "utf8");
    return command;
  }

  const command = join(root, "fake-opencode");
  writeFileSync(command, `#!/bin/sh\nprintf '%s\\n' '${event.replace(/'/g, "'\\''")}'\n`, "utf8");
  chmodSync(command, 0o755);
  return command;
}

function createOptimizationFilesInvalidJsonCommand(root: string): string {
  mkdirSync(root, { recursive: true });
  const script = join(root, "write-optimization-files.js");
  const result = {
    title: "Optimization Result",
    objective: "maximize liftToDrag = cl / cd",
    inputDataProvenance: {
      toolContext: "EngineeringProgramTool output in AetherOps ToolContext",
      sourceArtifactRelativePath: "artifacts/iteration-1/engineering-program/xfoil-wasm-polar-CLARK-Y-AIRFOIL.json",
      engineeringArtifact: "artifacts/iteration-1/engineering-program/xfoil-wasm-polar-CLARK-Y-AIRFOIL.json",
      runtime: "webxfoil-wasm",
      sourceUrl: "https://m-selig.ae.illinois.edu/ads/coord/clarky.dat",
      rowCount: 2
    },
    comparedCandidates: [
      { alpha: 4, cl: 0.8325, cd: 0.00758, ld: 109.82849604221636 },
      { alpha: 6, cl: 1.0328, cd: 0.00909, ld: 113.6193619361936 }
    ],
    selectedOptimum: {
      variables: { alpha: 6 },
      coefficients: { cl: 1.0328, cd: 0.00909 },
      objectiveValue: 113.6193619361936
    }
  };
  writeFileSync(script, [
    "const fs = require('fs');",
    "const path = require('path');",
    `const root = ${JSON.stringify(root)};`,
    "const dir = path.join(root, 'artifacts', 'iteration-1', 'opencode-optimization');",
    "fs.mkdirSync(dir, { recursive: true });",
    "fs.writeFileSync(path.join(dir, 'optimize_clarky_ld.py'), '# Optimization Code\\nprint(\"ok\")\\n', 'utf8');",
    `fs.writeFileSync(path.join(dir, 'optimization_result.json'), ${JSON.stringify(JSON.stringify(result, null, 2))}, 'utf8');`,
    "console.log('not json');"
  ].join("\n"), "utf8");

  if (process.platform === "win32") {
    const command = join(root, "fake-opencode-files.cmd");
    writeFileSync(command, `@echo off\r\nnode "%~dp0write-optimization-files.js"\r\nexit /b 0\r\n`, "utf8");
    return command;
  }

  const command = join(root, "fake-opencode-files");
  writeFileSync(command, "#!/bin/sh\nnode \"$(dirname \"$0\")/write-optimization-files.js\"\n", "utf8");
  chmodSync(command, 0o755);
  return command;
}

function createInvalidUtf8OpenCodeCommand(root: string): string {
  mkdirSync(root, { recursive: true });
  if (process.platform === "win32") {
    const command = join(root, "fake-invalid-opencode.cmd");
    writeFileSync(command, `@echo off\r\nnode -e "process.stdout.write(Buffer.from([255,123,125]));"\r\nexit /b 0\r\n`, "utf8");
    return command;
  }

  const command = join(root, "fake-invalid-opencode");
  writeFileSync(command, "#!/bin/sh\nnode -e 'process.stdout.write(Buffer.from([255,123,125]))'\n", "utf8");
  chmodSync(command, 0o755);
  return command;
}

function settings(command: string): AppSettings {
  return {
    openCodeLlm: {
      source: "codex-oauth",
      model: "gpt-5.5"
    },
    openCode: {
      enabled: true,
      command,
      provider: "openai",
      model: "gpt-5.5",
      timeoutMs: 10_000
    },
    webSearch: {
      provider: "disabled"
    },
    embedding: {
      provider: "openai",
      model: "text-embedding-3-small",
      dimensions: 1536,
      apiKey: "test-key",
      apiKeyConfigured: true
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
    updatedAt: "2026-05-20T00:00:00.000Z"
  };
}

function input(): OpenCodeRunInput {
  const project: ResearchProject = {
    id: "project-test",
    goal: "integration check",
    topic: "OpenCode integration",
    scope: "short check",
    budget: "none",
    autonomyPolicy: {
      toolApproval: "suggested",
      allowExternalSearch: false,
      allowCodeExecution: false
    },
    createdAt: "2026-05-20T00:00:00.000Z",
    updatedAt: "2026-05-20T00:00:00.000Z",
    currentStep: ResearchLoopStep.ExecuteTools,
    status: "running",
    projectRoot: tempDir ?? ""
  };
  return {
    project,
    questions: [],
    hypotheses: [],
    iteration: 1
  };
}

function inputWithOptimizationContext(): OpenCodeRunInput {
  const base = input();
  return {
    ...base,
    project: {
      ...base.project,
      goal: "Optimize Clark-Y angle of attack for maximum L/D using real solver output.",
      topic: "Clark-Y aerodynamic optimization",
      scope: "OpenCode must create and run optimization code from prior polar rows.",
      autonomyPolicy: {
        ...base.project.autonomyPolicy,
        allowCodeExecution: true
      }
    },
    researchPlan: {
      id: "plan-optimization",
      projectId: base.project.id,
      iteration: 1,
      objective: "Use OpenCodeTool to create optimization code and compute the best Clark-Y candidate from EngineeringProgramTool output.",
      targetQuestions: [],
      targetHypotheses: [],
      requiredTools: ["EngineeringProgramTool", "OpenCodeTool", "ArtifactWriterTool", "DataAnalysisTool"],
      expectedSources: ["tool observation"],
      expectedArtifacts: ["Optimization Code", "Optimization Result"],
      executionSteps: ["Run EngineeringProgramTool", "Run OpenCodeTool optimization code", "Write optimization result"],
      stopCriteria: ["Optimization result includes objective, candidates, and blocker-free execution notes."],
      createdAt: "2026-05-20T00:00:00.000Z"
    },
    toolRuns: [
      {
        id: "tool-engineering-1",
        projectId: base.project.id,
        iteration: 1,
        toolName: "EngineeringProgramTool",
        input: {},
        output: {
          artifactCount: 1,
          outputs: [
            {
              kind: "xfoil-wasm-polar",
              target: "xfoil-wasm",
              artifactPath: "artifacts/iteration-1/engineering-program/xfoil-wasm-polar-CLARK-Y-AIRFOIL.json",
              summary: {
                airfoil: "CLARK Y AIRFOIL",
                runtime: "webxfoil-wasm",
                runtimeVersion: "0.1.1",
                reynolds: 1000000,
                mach: 0,
                rowCount: 2,
                rows: [
                  { alpha: 4, cl: 0.8325, cd: 0.00758 },
                  { alpha: 6, cl: 1.0328, cd: 0.00909 }
                ]
              }
            }
          ]
        },
        status: "completed",
        startedAt: "2026-05-20T00:00:00.000Z",
        completedAt: "2026-05-20T00:00:01.000Z"
      }
    ]
  };
}
