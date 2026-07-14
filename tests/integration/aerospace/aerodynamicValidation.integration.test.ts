import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { generateTmrNaca0012Coordinates, parseLadsonForceDataset, validateAerodynamicPrediction } from "../../../src/core/aerospace/aerodynamicValidation.js";
import {
  NACA0012_BASELINE_ID,
  NACA0012_LADSON_FIXTURE_PATH,
  naca0012LadsonPedigree,
  naca0012WebXfoilModelCard
} from "../../../src/core/testing/aerospace/naca0012ValidationFixture.js";
import type { EngineeringProgramRequest } from "../../../src/core/shared/types.js";
import { validateAirfoilCoordinateText } from "../../../src/server/runtime/engineering/engineeringProgramCoordinateResolver.js";
import { runXfoilWasmPolar } from "../../../src/server/runtime/engineering/engineeringProgramWebXfoilAdapter.js";
import { defaultSettings } from "../../../src/server/runtime/storage/settingsDefaults.js";
import { runInput } from "../tools/toolRunner.integration.support.js";

const hasher = { sha256Canonical: (value: unknown) => sha(stableJson(value)) };

describe("NACA 0012 public-data aerodynamic validation", () => {
  it("runs the bundled WebXFOIL adapter with source-bound transition and validates against NASA TMR data", async () => {
    const geometry = generateTmrNaca0012Coordinates(81);
    const geometryHash = sha(geometry);
    const pointCount = validateAirfoilCoordinateText(geometry).pointCount;
    const input = runInput(["EngineeringProgramTool"]);
    input.coordinateBindings = [
      {
        id: "binding:tmr-naca0012",
        sourceId: "source:nasa-tmr-naca0012-geometry",
        sourceUrl: "https://tmbwg.github.io/turbmodels/naca0012_val.html",
        label: "TMR altered NACA 0012",
        sha256: geometryHash,
        rawText: geometry,
        pointCount
      }
    ];
    const settings = {
      ...defaultSettings,
      allowCodeExecution: true,
      engineeringTools: { ...defaultSettings.engineeringTools, enabled: true }
    };
    const baseRequest: EngineeringProgramRequest = {
      kind: "xfoil-wasm-polar",
      target: "xfoil-wasm",
      coordinateBindingId: "binding:tmr-naca0012",
      reynolds: 6_000_000,
      mach: 0.15,
      alphaStart: 0,
      alphaEnd: 12,
      transition: {
        mode: "forced",
        upperXOverC: 0.05,
        lowerXOverC: 0.05,
        sourceEvidenceId: "NASA-TM-4074"
      },
      reason: "Reproduce the source-bound NASA TMR pre-stall validation condition."
    };
    const started = Date.now();
    const coarse = await runXfoilWasmPolar({ ...baseRequest, alphaStep: 2 }, settings, input);
    const fine = await runXfoilWasmPolar({ ...baseRequest, alphaStep: 1 }, settings, input);
    const durationMs = Date.now() - started;
    const commonPointDelta = maximumCommonPointDelta(coarse.rows, fine.rows);
    const referenceText = readFileSync(NACA0012_LADSON_FIXTURE_PATH, "utf8");
    const dataset = parseLadsonForceDataset({
      text: referenceText,
      pedigree: naca0012LadsonPedigree(sha(referenceText)),
      hasher
    });
    const result = validateAerodynamicPrediction({
      dataset,
      selectedZone: "120 grit",
      predictionRows: fine.rows,
      predictionConditions: {
        reynoldsNumber: fine.reynolds,
        mach: fine.mach,
        transition: fine.transition,
        coefficientConvention: dataset.pedigree.coefficientConvention
      },
      configurationBaselineId: NACA0012_BASELINE_ID,
      modelCard: naca0012WebXfoilModelCard(),
      acceptance: { maximumLiftRmse: 0.2, maximumDragRmse: 0.015 },
      run: {
        id: "run:webxfoil-naca0012-re6m-m015",
        analysisCaseId: "case:naca0012-public-validation",
        toolId: coarse.runtime,
        toolVersion: coarse.runtimeVersion,
        environmentHash: sha(`${coarse.runtime}@${coarse.runtimeVersion}:${coarse.runtimeLicense}`),
        inputArtifactHashes: [geometryHash, sha(referenceText)],
        configurationHash: sha(stableJson(baseRequest)),
        geometryHash,
        startTime: "2026-07-15T00:00:00.000Z",
        durationMs,
        convergenceEvidence: [
          {
            metric: "common-point coefficient delta between 2-degree and 1-degree alpha sequences",
            initialValue: commonPointDelta,
            finalValue: commonPointDelta,
            tolerance: 0.002,
            converged: commonPointDelta <= 0.002,
            evidenceKind: "reference_reproduction"
          }
        ],
        warningMessages: solverWarnings(coarse, fine),
        errorMessages: [],
        outputArtifactId: `artifact:${sha(stableJson(fine.rows))}`
      },
      hasher
    });

    expect(coarse.transition).toBe("forced");
    expect(coarse.transitionLocations).toMatchObject({ upperXOverC: 0.05, lowerXOverC: 0.05, sourceEvidenceId: "NASA-TM-4074" });
    expect(coarse.convergence).toEqual({ hasNaN: false, hasFortranError: false, hasConvergenceFail: false });
    expect(fine.rows.length).toBeGreaterThanOrEqual(10);
    expect(commonPointDelta).toBeLessThanOrEqual(0.002);
    expect(result.status).toBe("validated_with_limits");
    expect(result.metrics.liftRmse).toBeLessThanOrEqual(0.2);
    expect(result.metrics.dragRmse).toBeLessThanOrEqual(0.015);
    expect(result.simulationReceipt.reproducibilityStatus).toBe("reproducible_not_rerun");
  }, 60_000);
});

function maximumCommonPointDelta(
  coarse: readonly { alpha: number; cl: number; cd: number }[],
  fine: readonly { alpha: number; cl: number; cd: number }[]
): number {
  const fineByAlpha = new Map(fine.map((row) => [row.alpha, row]));
  const deltas = coarse.flatMap((row) => {
    const match = fineByAlpha.get(row.alpha);
    return match ? [Math.max(Math.abs(row.cl - match.cl), Math.abs(row.cd - match.cd))] : [];
  });
  if (!deltas.length) throw new Error("WebXFOIL alpha sequences produced no common points.");
  return Math.max(...deltas);
}

function solverWarnings(
  ...runs: readonly { convergence: { hasNaN: boolean; hasFortranError: boolean; hasConvergenceFail: boolean } }[]
): { code: string; message: string }[] {
  return runs.flatMap((run, index) => {
    const flags = Object.entries(run.convergence).filter(([, present]) => present);
    return flags.map(([flag]) => ({ code: `WEBXFOIL_${flag.toUpperCase()}`, message: `WebXFOIL run ${index + 1} reported ${flag}.` }));
  });
}

function sha(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
    .join(",")}}`;
}
