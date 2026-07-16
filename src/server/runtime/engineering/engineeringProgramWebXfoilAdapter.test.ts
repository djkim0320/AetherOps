import { describe, expect, it } from "vitest";
import { strictTestSettings } from "../../../core/testing/orchestratorTestHarness.js";
import { ResearchLoopStep, type ResearchToolInput } from "../../../core/shared/types.js";
import { runXfoilWasmPolar } from "./engineeringProgramWebXfoilAdapter.js";
import { xfoilWasmPolarArtifact, xfoilWasmPolarEvidence } from "./engineeringProgramObservationMappers.js";

const NACA_0012_POST_PANE_GEOMETRY_HASH = "99324fe31b74dcfaf49e011b6382adb9884fdb5945bfdac2414fb25c89a22593";

describe("WebXFOIL runtime acceptance", () => {
  it("binds a successful polar and both observations to the deterministic post-PANE geometry receipt", async () => {
    const researchInput = input();
    const summary = await runXfoilWasmPolar(
      {
        kind: "xfoil-wasm-polar",
        target: "xfoil-wasm",
        naca: "0012",
        reynolds: 1_000_000,
        mach: 0,
        alphaStart: 0,
        alphaEnd: 0,
        alphaStep: 1
      },
      { ...strictTestSettings, allowCodeExecution: true },
      researchInput
    );

    expect(summary).toMatchObject({
      airfoil: "NACA 0012",
      geometryContentHash: NACA_0012_POST_PANE_GEOMETRY_HASH,
      geometryPointCount: 240,
      geometryReceiptVersion: "webxfoil-paneled-airfoil-v1",
      polarResultReceiptVersion: "webxfoil-polar-result-v1"
    });
    expect(summary.polarResultHash).toMatch(/^[a-f0-9]{64}$/);
    const artifact = xfoilWasmPolarArtifact(researchInput, summary, "2026-07-15T00:00:01.000Z");
    const evidence = xfoilWasmPolarEvidence(researchInput, summary, "2026-07-15T00:00:01.000Z");
    for (const output of [artifact, evidence]) {
      expect(output.metadata).toMatchObject({
        geometryContentHash: summary.geometryContentHash,
        geometryPointCount: 240,
        geometryReceiptVersion: "webxfoil-paneled-airfoil-v1",
        polarResultHash: summary.polarResultHash,
        polarResultReceiptVersion: "webxfoil-polar-result-v1"
      });
    }
  }, 30_000);

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
