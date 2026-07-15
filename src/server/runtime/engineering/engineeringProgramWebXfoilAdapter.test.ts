import { describe, expect, it } from "vitest";
import { strictTestSettings } from "../../../core/testing/orchestratorTestHarness.js";
import { ResearchLoopStep, type ResearchToolInput } from "../../../core/shared/types.js";
import { runXfoilWasmPolar } from "./engineeringProgramWebXfoilAdapter.js";

describe("WebXFOIL runtime acceptance", () => {
  it("rejects the real non-converged NACA 0012 extreme polar instead of emitting evidence", async () => {
    await expect(
      runXfoilWasmPolar(
        {
          kind: "xfoil-wasm-polar",
          target: "xfoil-wasm",
          naca: "0012",
          reynolds: 1_000,
          mach: 0.8,
          alphaStart: -30,
          alphaEnd: 30,
          alphaStep: 10
        },
        { ...strictTestSettings, allowCodeExecution: true },
        input()
      )
    ).rejects.toThrow(/invalid solver terminal state|incomplete/i);
  }, 30_000);
});

function input(): ResearchToolInput {
  const createdAt = "2026-07-15T00:00:00.000Z";
  return {
    project: {
      id: "project-webxfoil-rejection",
      goal: "Reject invalid solver output.",
      topic: "WebXFOIL convergence",
      scope: "Offline bundled solver validation",
      budget: "bounded",
      autonomyPolicy: { toolApproval: "suggested", allowExternalSearch: false, allowCodeExecution: true },
      createdAt,
      updatedAt: createdAt,
      currentStep: ResearchLoopStep.ExecuteTools,
      status: "running",
      projectRoot: ".aetherops/test-webxfoil-rejection"
    },
    questions: [],
    hypotheses: [],
    evidence: [],
    artifacts: [],
    sources: [],
    iteration: 1
  };
}
