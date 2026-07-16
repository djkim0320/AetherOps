import { describe, expect, it, vi } from "vitest";
import type { ConfigurationBaseline } from "../../core/aerospace/configurationBaseline.js";
import type { EngineeringQuantity } from "../../core/aerospace/quantity.js";
import { RuntimeRequirementError } from "../../core/tools/runtimeRequirements.js";
import { strictTestSettings } from "../../core/testing/orchestratorTestHarness.js";
import { executeDurableEngineeringJob } from "./durableEngineeringJobHandler.js";
import { assertPromotionReadyForAction } from "./registerDurableResearchLoopHandler.js";

describe("durable research engineering promotion readiness", () => {
  it("turns a planner-selected native target into a structured blocked requirement", () => {
    const error = capture(() =>
      assertPromotionReadyForAction(
        "EngineeringProgramTool",
        { programRequests: [{ kind: "xfoil-polar", target: "xfoil", naca: "0012" }] },
        baseline({ xfoil: "6.99" })
      )
    );

    expect(error).toBeInstanceOf(RuntimeRequirementError);
    expect(error).toMatchObject({
      step: "EXECUTE_TOOLS",
      unmetRequirements: [
        expect.objectContaining({ key: "engineering.runtimeReceipt.xfoil", isSatisfied: false, message: expect.stringContaining("NOT_READY") })
      ]
    });
  });

  it("rejects a mismatched WebXFOIL baseline before the tool adapter and accepts the pinned version", () => {
    expect(() =>
      assertPromotionReadyForAction(
        "EngineeringProgramTool",
        { programRequests: [{ kind: "xfoil-wasm-polar", target: "xfoil-wasm", naca: "0012" }] },
        baseline({ "xfoil-wasm": "0.1.0" })
      )
    ).toThrow(RuntimeRequirementError);

    expect(() =>
      assertPromotionReadyForAction(
        "EngineeringProgramTool",
        { programRequests: [{ kind: "xfoil-wasm-polar", target: "xfoil-wasm", naca: "0012" }] },
        baseline({ "xfoil-wasm": "0.1.1" })
      )
    ).not.toThrow();
  });

  it("rechecks the pinned Codex version in the direct job handler before invoking the adapter", async () => {
    const active = baseline({ codex: "0.143.0" });
    const run = vi.fn();

    await expect(
      executeDurableEngineeringJob(
        {
          id: "job-codex-readiness",
          projectId: active.projectId,
          kind: "engineering_run",
          status: "running",
          projectRevision: 1,
          idempotencyKey: "codex-readiness",
          effectiveCapabilities: { agent: true, engineering: true, search: false },
          createdAt: active.createdAt,
          updatedAt: active.createdAt
        },
        [{ target: "codex", objective: "Produce a local report.", inputs: { inputArtifactIds: [], outputs: [{ relativePath: "report.md", kind: "report" }] } }],
        { id: active.id, revision: active.revision, contentHash: active.contentHash },
        { signal: new AbortController().signal, requestedControl: () => undefined },
        {
          dataRoot: "unused-before-readiness-check",
          orchestrator: { getSnapshot: vi.fn().mockResolvedValue(snapshot(active.projectId)) },
          settingsStore: { getRuntimeSettings: vi.fn().mockResolvedValue({ ...strictTestSettings, allowCodeExecution: true }) },
          jobs: { engineering: { activeBaseline: vi.fn().mockResolvedValue(active) } },
          codexCli: { run },
          authorizeAction: vi.fn()
        } as never
      )
    ).rejects.toBeInstanceOf(RuntimeRequirementError);
    expect(run).not.toHaveBeenCalled();
  });
});

function capture(run: () => void): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  throw new Error("Expected readiness guard to throw.");
}

function baseline(solverVersions: Record<string, string>): ConfigurationBaseline {
  return {
    id: "baseline-readiness",
    projectId: "project-readiness",
    revision: 1,
    status: "active",
    geometryHash: "1".repeat(64),
    airfoilGeometryHash: "2".repeat(64),
    aerodynamicReference: {
      area: quantity(12, "m^2"),
      chord: quantity(1.5, "m"),
      span: quantity(8, "m"),
      axisConventionId: "wind-axes-v1",
      dynamicPressureDefinition: "q=0.5*rho*V^2"
    },
    massPropertiesHash: "3".repeat(64),
    atmosphereModelId: "isa-1976",
    unitConventionId: "si-v1",
    coordinateConventionId: "right-handed-cartesian-v1",
    solverVersions,
    materialRevisionIds: ["material:v1"],
    sourceRevisionIds: ["source:v1"],
    equationVersionIds: [],
    contentHash: "4".repeat(64),
    createdAt: "2026-07-16T00:00:00.000Z",
    createdBy: "test",
    provenance: [{ id: "source:v1", contentHash: "5".repeat(64) }]
  };
}

function quantity(valueSI: number, unit: string): EngineeringQuantity {
  return {
    kind: "scalar",
    valueSI,
    dimension: { mass: 0, length: unit === "m^2" ? 2 : 1, time: 0, temperature: 0, current: 0, amount: 0, luminousIntensity: 0, angle: 0 },
    semantic: "generic",
    originalValue: valueSI,
    originalUnit: unit,
    displayUnit: unit,
    provenance: { sourceType: "calculation", sourceId: "baseline-test" },
    serializationVersion: 1
  };
}

function snapshot(projectId: string) {
  return {
    project: {
      id: projectId,
      name: "Readiness project",
      description: "Direct handler receipt guard",
      status: "running",
      currentStep: "EXECUTE_TOOLS",
      maxIterations: 1,
      convergenceThreshold: 1,
      autoRunOpenCode: false,
      autonomyPolicy: { allowAgent: true, allowCodeExecution: true, allowExternalSearch: false },
      createdAt: "2026-07-16T00:00:00.000Z",
      updatedAt: "2026-07-16T00:00:00.000Z"
    },
    questions: [],
    hypotheses: [],
    evidence: [],
    artifacts: [],
    sources: [],
    researchPlans: []
  };
}
