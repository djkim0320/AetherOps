import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { ResearchToolInput, ResearchPlan } from "../../../core/shared/types.js";
import { bindFetchedAirfoilCoordinates } from "./airfoilCoordinateBinder.js";
import { resolveWasmAirfoilInput } from "./engineeringProgramCoordinateResolver.js";

const url = "https://m-selig.ae.illinois.edu/ads/coord/clarky.dat";

describe("airfoil coordinate binder", () => {
  it("creates a verified deterministic binding from a completed WebFetch source", () => {
    const first = bindFetchedAirfoilCoordinates(input(readFileSync(resolve("src/test/fixtures/airfoils/clark-y.dat"), "utf8")));
    const second = bindFetchedAirfoilCoordinates(input(readFileSync(resolve("src/test/fixtures/airfoils/clark-y.dat"), "utf8")));
    expect(first.coordinateBindings).toHaveLength(1);
    expect(first.coordinateBindings?.[0]).toMatchObject({ sourceId: "source-clark-y", sourceUrl: url });
    expect(first.coordinateBindings?.[0]?.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(first.coordinateBindings?.[0]?.id).toBe(second.coordinateBindings?.[0]?.id);
    expect(first.researchPlan?.programRequests?.[0]?.coordinateBindingId).toBe(first.coordinateBindings?.[0]?.id);
  });

  it("rejects missing or invalid fetched coordinate sources", () => {
    expect(() => bindFetchedAirfoilCoordinates({ ...input("not coordinates"), sources: [] })).toThrow(/no matching completed WebFetchTool source/);
    expect(() => bindFetchedAirfoilCoordinates(input("not coordinates"))).toThrow(/coordinate file|numeric points/i);
  });

  it("rejects a binding whose verified coordinate text was changed", async () => {
    const bound = bindFetchedAirfoilCoordinates(input(readFileSync(resolve("src/test/fixtures/airfoils/clark-y.dat"), "utf8")));
    const binding = bound.coordinateBindings?.[0];
    expect(binding).toBeDefined();
    if (!binding) return;
    bound.coordinateBindings = [{ ...binding, rawText: `${binding.rawText}\n0.5 0.5` }];
    await expect(
      resolveWasmAirfoilInput(bound.researchPlan?.programRequests?.[0] ?? { kind: "xfoil-wasm-polar", target: "xfoil-wasm" }, {} as never, bound)
    ).rejects.toThrow(/hash mismatch/);
  });
});

function input(rawText: string): ResearchToolInput {
  const plan: ResearchPlan = {
    id: "plan-1",
    projectId: "project-1",
    iteration: 1,
    objective: "Run Clark-Y with WebXFOIL",
    targetQuestions: [],
    targetHypotheses: [],
    requiredTools: ["WebFetchTool", "EngineeringProgramTool"],
    expectedSources: [],
    expectedArtifacts: [],
    executionSteps: [],
    stopCriteria: [],
    fetchCandidateUrls: [url],
    programRequests: [
      {
        kind: "xfoil-wasm-polar",
        target: "xfoil-wasm",
        sourceUrl: url,
        cfdRunSpec: {
          target: "xfoil-wasm",
          geometry: { source: "sourceUrl", sourceUrl: url },
          flightCondition: { reynolds: 1_000_000, mach: 0, alphaStart: -4, alphaEnd: 12, alphaStep: 2 },
          solver: { name: "webxfoil-wasm" }
        }
      }
    ],
    createdAt: "2026-07-11T00:00:00.000Z"
  };
  return {
    project: {
      id: "project-1",
      goal: "test",
      topic: "Clark-Y",
      scope: "offline test",
      budget: "short",
      autonomyPolicy: { toolApproval: "automatic", allowExternalSearch: true, allowCodeExecution: true },
      createdAt: "2026-07-11T00:00:00.000Z",
      updatedAt: "2026-07-11T00:00:00.000Z",
      currentStep: "EXECUTE_TOOLS",
      status: "running",
      projectRoot: ".aetherops/projects/project-1"
    },
    questions: [],
    hypotheses: [],
    sources: [
      {
        id: "source-clark-y",
        projectId: "project-1",
        kind: "web",
        title: "Clark-Y coordinates",
        url,
        retrievedAt: "2026-07-11T00:00:00.000Z",
        metadata: { fetchStatus: "fetched", rawText }
      }
    ],
    researchPlan: plan,
    iteration: 1
  };
}
