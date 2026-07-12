import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { normalizeProgramRequests, readyProgramRequests } from "../../../core/planning/engineeringRequestNormalizer.js";
import { settingsWithProjectArtifactRoot } from "../../../core/orchestration/projectArtifactSettings.js";
import { strictTestSettings } from "../../../core/testing/orchestratorTestHarness.js";
import type { ResearchProject, ResearchToolInput } from "../../../core/shared/types.js";
import { buildServerRuntimeToolDiagnostics } from "./runtimeEngineeringDiagnostics.js";
import { resolveWasmAirfoilInput } from "./engineeringProgramCoordinateResolver.js";

let root: string | undefined;

afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
  root = undefined;
});

describe("project-scoped engineering artifact planning", () => {
  it("validates and binds the immutable Clark-Y fixture as a ready WebXFOIL artifact candidate", async () => {
    root = mkdtempSync(join(tmpdir(), "aetherops-project-artifact-"));
    const project = projectAt(root);
    const settings = settingsWithProjectArtifactRoot({ ...strictTestSettings, allowCodeExecution: true }, project);
    const inputRoot = settings.engineeringTools.modeling.artifactRoot!;
    mkdirSync(inputRoot, { recursive: true });
    copyFileSync(join(process.cwd(), "src", "test", "fixtures", "airfoils", "clark-y.dat"), join(inputRoot, "clark-y.dat"));

    const diagnostics = buildServerRuntimeToolDiagnostics(settings);
    expect(diagnostics.engineeringArtifactCandidates).toContainEqual(
      expect.objectContaining({ relativePath: "clark-y.dat", format: "airfoil-coordinate", ready: true, validated: true })
    );

    const requests = readyProgramRequests(
      normalizeProgramRequests(
        [
          {
            kind: "xfoil-wasm-polar",
            target: "xfoil-wasm",
            artifactPath: "clark-y.dat",
            reynolds: 1_000_000,
            mach: 0,
            alphaStart: -2,
            alphaEnd: 2,
            alphaStep: 2
          }
        ],
        []
      ),
      diagnostics
    );
    expect(requests).toEqual([expect.objectContaining({ kind: "xfoil-wasm-polar", target: "xfoil-wasm", artifactPath: "clark-y.dat" })]);

    const resolved = await resolveWasmAirfoilInput(requests[0]!, settings, researchInput(project));
    expect(resolved).toMatchObject({ label: "clark-y", sourceKind: "artifact", sourceArtifactPath: "clark-y.dat" });
    expect(resolved.text).toContain("CLARK Y AIRFOIL");
  });
});

function projectAt(projectRoot: string): ResearchProject {
  return {
    id: "project-clark-y",
    goal: "Compute the Clark-Y polar with bundled WebXFOIL.",
    topic: "Clark-Y WebXFOIL",
    scope: "Offline immutable fixture only.",
    budget: "test",
    autonomyPolicy: { toolApproval: "suggested", allowExternalSearch: false, allowCodeExecution: true },
    status: "idle",
    currentStep: "CREATE_RESEARCH_DB",
    projectRoot,
    createdAt: "2026-07-11T00:00:00.000Z",
    updatedAt: "2026-07-11T00:00:00.000Z"
  };
}

function researchInput(project: ResearchProject): ResearchToolInput {
  return { project, questions: [], hypotheses: [], iteration: 1 };
}
