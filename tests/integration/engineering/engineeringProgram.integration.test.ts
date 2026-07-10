import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { EngineeringProgramTool, validateAirfoilCoordinateText } from "../../../src/core/tools/engineeringProgramTool.js";
import { resolveWasmAirfoilInput } from "../../../src/server/runtime/engineering/engineeringProgramCoordinateResolver.js";
import { runEngineeringProgram } from "../../../src/server/runtime/engineering/engineeringProgramRegistry.js";
import type { AppSettings, OpenCodeRunInput } from "../../../src/core/shared/types.js";
import { ResearchLoopStep } from "../../../src/core/shared/types.js";

const createdAt = "2026-07-10T00:00:00.000Z";
const fixturePath = fileURLToPath(new URL("../../../src/test/fixtures/airfoils/clark-y.dat", import.meta.url));

function createSettings(artifactRoot = ""): AppSettings {
  return {
    openCodeLlm: { source: "codex-oauth", model: "gpt-5.6", reasoningEffort: "xhigh", timeoutMs: 180_000 },
    openCode: { enabled: false, command: "opencode", timeoutMs: 180_000 },
    webSearch: { provider: "disabled" },
    embedding: { provider: "local", dimensions: 0 },
    browserUse: { enabled: false, mode: "background", maxPages: 1, timeoutMs: 30_000, captureScreenshots: false },
    researchMetadata: { enabled: true, provider: "openalex", maxResults: 5, timeoutMs: 15_000 },
    engineeringTools: {
      enabled: true,
      xfoil: { enabled: false, timeoutMs: 30_000 },
      modeling: { enabled: Boolean(artifactRoot), artifactRoot, maxMeshBytes: 8 * 1024 * 1024 },
      su2: {
        enabled: false,
        command: "",
        caseRoot: "",
        configFile: "",
        workingDirectory: "",
        probeArgs: ["--help"],
        runArgsTemplate: ["{config}"],
        timeoutMs: 180_000
      },
      openVsp: {
        enabled: false,
        command: "",
        scriptPath: "",
        workingDirectory: "",
        probeArgs: ["-help"],
        runArgsTemplate: ["-script", "{script}", "-spec", "{spec}", "-output", "{output}"],
        timeoutMs: 180_000
      },
      xflr5: {
        enabled: false,
        command: "",
        scriptPath: "",
        workingDirectory: "",
        probeArgs: ["--help"],
        runArgsTemplate: ["--script", "{script}", "--spec", "{spec}", "--output", "{output}"],
        timeoutMs: 180_000
      }
    },
    allowExternalSearch: true,
    allowCodeExecution: true,
    updatedAt: createdAt
  };
}

function createInput(programRequests: NonNullable<OpenCodeRunInput["researchPlan"]>["programRequests"]): OpenCodeRunInput {
  return {
    project: {
      id: "project-1",
      goal: "Validate engineering program orchestration.",
      topic: "engineering program orchestration",
      scope: "offline solver execution",
      budget: "10 minutes",
      autonomyPolicy: { toolApproval: "suggested", allowExternalSearch: true, allowCodeExecution: true },
      createdAt,
      updatedAt: createdAt,
      currentStep: ResearchLoopStep.ExecuteTools,
      status: "running",
      projectRoot: join(tmpdir(), "aetherops-project")
    },
    questions: [{ id: "q1", projectId: "project-1", text: "Can the tool run a real solver?", status: "open", createdAt }],
    hypotheses: [
      { id: "h1", projectId: "project-1", questionId: "q1", statement: "The solver path is wired correctly.", status: "untested", confidence: 0.4, createdAt }
    ],
    evidence: [],
    artifacts: [],
    sources: [],
    researchPlan: {
      id: "plan-1",
      projectId: "project-1",
      iteration: 1,
      objective: "Run engineering evidence generation.",
      targetQuestions: ["q1"],
      targetHypotheses: ["h1"],
      requiredTools: ["EngineeringProgramTool"],
      expectedSources: [],
      expectedArtifacts: [],
      executionSteps: ["Execute tool"],
      stopCriteria: ["Solver output exists"],
      programRequests,
      createdAt
    },
    iteration: 1
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("EngineeringProgramTool integration", () => {
  it("runs real WebXFOIL against the immutable Clark-Y fixture offline", async () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "aetherops-clarky-"));
    try {
      const fixture = readFileSync(fixturePath, "utf8");
      expect(() => validateAirfoilCoordinateText(fixture)).not.toThrow();
      writeFileSync(join(tempRoot, "clarky.dat"), fixture, "utf8");

      const result = await new EngineeringProgramTool(runEngineeringProgram).run(
        createInput([
          {
            kind: "xfoil-wasm-polar",
            target: "xfoil-wasm",
            artifactPath: "clarky.dat",
            reynolds: 1_000_000,
            mach: 0,
            alphaStart: -2,
            alphaEnd: 2,
            alphaStep: 2
          }
        ]),
        createSettings(tempRoot)
      );

      expect(result.toolRun.status).toBe("completed");
      expect(result.artifacts).toHaveLength(1);
      const summary = JSON.parse(result.artifacts[0]?.content ?? "{}") as {
        runtime?: string;
        sourceKind?: string;
        sourceArtifactPath?: string;
        rowCount?: number;
        rows?: Array<{ alpha: number; cl: number; cd: number }>;
      };
      expect(summary.runtime).toBe("webxfoil-wasm");
      expect(summary.sourceKind).toBe("artifact");
      expect(summary.sourceArtifactPath).toBe("clarky.dat");
      expect(summary.rowCount).toBeGreaterThanOrEqual(2);
      expect(summary.rows?.some((row) => row.alpha === 0 && Number.isFinite(row.cl) && Number.isFinite(row.cd))).toBe(true);
      expect(result.evidence[0]?.metadata).toMatchObject({ program: "xfoil-wasm", traceabilityKind: "tool_observation", sourceArtifactPath: "clarky.dat" });
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("blocks remote coordinate resolution through the shared public URL policy before fetch", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    await expect(
      resolveWasmAirfoilInput(
        {
          kind: "xfoil-wasm-polar",
          target: "xfoil-wasm",
          sourceUrl: "http://localhost/clarky.dat"
        },
        createSettings(),
        createInput([])
      )
    ).rejects.toThrow("blocked internal hostname");

    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
