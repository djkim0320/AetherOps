import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  assessAerodynamicValidationDomain,
  generateTmrNaca0012Coordinates,
  parseLadsonForceDataset,
  validateAerodynamicPrediction
} from "../../../src/core/aerospace/aerodynamicValidation.js";
import {
  NACA0012_BASELINE_ID,
  NACA0012_LADSON_FIXTURE_PATH,
  NACA0012_LADSON_SHA256,
  naca0012LadsonPedigree,
  naca0012WebXfoilModelCard
} from "../../../src/core/testing/aerospace/naca0012ValidationFixture.js";

const hasher = { sha256Canonical: (value: unknown) => createHash("sha256").update(stableJson(value)).digest("hex") };
const sha = (value: string) => createHash("sha256").update(value).digest("hex");

describe("public-data aerodynamic validation contracts", () => {
  it("parses the immutable Ladson force data with pedigree and validates an in-domain recorded result", () => {
    const text = readFileSync(NACA0012_LADSON_FIXTURE_PATH, "utf8");
    const dataset = parseLadsonForceDataset({ text, pedigree: naca0012LadsonPedigree(sha(text)), hasher });
    const reference = dataset.zones["120 grit"] as readonly { alphaDeg: number; liftCoefficient: number; dragCoefficient: number }[];
    const predictions = reference
      .filter((point) => point.alphaDeg >= 0 && point.alphaDeg <= 12.2)
      .map((point) => ({ alpha: point.alphaDeg, cl: point.liftCoefficient + 0.005, cd: point.dragCoefficient + 0.0002 }));
    const validationInput = {
      dataset,
      selectedZone: "120 grit",
      predictionRows: predictions,
      predictionConditions: {
        reynoldsNumber: 6_000_000,
        mach: 0.15,
        transition: "forced" as const,
        coefficientConvention: dataset.pedigree.coefficientConvention
      },
      configurationBaselineId: NACA0012_BASELINE_ID,
      modelCard: naca0012WebXfoilModelCard(),
      acceptance: { maximumLiftRmse: 0.02, maximumDragRmse: 0.001 },
      run: {
        id: "run:recorded-validation",
        analysisCaseId: "case:naca0012-validation",
        toolId: "recorded-result-parser",
        toolVersion: "1.0.0",
        environmentHash: sha("environment"),
        inputArtifactHashes: [NACA0012_LADSON_SHA256],
        configurationHash: sha("configuration"),
        geometryHash: sha("tmr-altered-naca0012"),
        startTime: "2026-07-15T00:00:00.000Z",
        durationMs: 12,
        convergenceEvidence: [
          { metric: "recorded-result-readback", initialValue: 1, finalValue: 0, tolerance: 0, converged: true, evidenceKind: "reference_reproduction" }
        ],
        warningMessages: [],
        errorMessages: [],
        outputArtifactId: "artifact:recorded-validation"
      },
      hasher
    };
    const result = validateAerodynamicPrediction(validationInput);

    expect(Object.keys(dataset.zones)).toEqual(["120 grit", "180 grit", "80 grit"]);
    expect(result.status).toBe("validated_with_limits");
    expect(result.metrics.liftRmse).toBeCloseTo(0.005, 12);
    expect(result.experimentalUncertainty.status).toBe("not_quantified_in_fixture");
    expect(result.placards.join(" ")).toContain("not certification evidence");
    expect(result.simulationReceipt.exitStatus).toBe("completed");
    const freeTransition = validateAerodynamicPrediction({
      ...validationInput,
      predictionConditions: { ...validationInput.predictionConditions, transition: "free" }
    });
    expect(freeTransition.status).toBe("outside_domain");
    expect(freeTransition.placards.join(" ")).toContain("tripped reference data require forced solver transition");
  });

  it("rejects a corrupted reference fixture before parsing", () => {
    const text = `${readFileSync(NACA0012_LADSON_FIXTURE_PATH, "utf8")}\n0 0 0\n`;
    expect(() => parseLadsonForceDataset({ text, pedigree: naca0012LadsonPedigree(sha(text), NACA0012_LADSON_SHA256), hasher })).toThrow(/hash mismatch/);
  });

  it("places an explicit placard on an outside-domain use", () => {
    const assessment = assessAerodynamicValidationDomain({
      modelCard: naca0012WebXfoilModelCard(),
      configurationBaselineId: NACA0012_BASELINE_ID,
      reynoldsNumber: 1_000_000,
      mach: 0.15,
      alphaDeg: 8
    });
    expect(assessment.status).toBe("outside_verified_domain");
    expect(assessment.placard?.prohibitedDecisions).toContain("certification finding");
  });

  it("generates the published sharp-trailing-edge geometry deterministically", () => {
    const first = generateTmrNaca0012Coordinates(81);
    const second = generateTmrNaca0012Coordinates(81);
    const rows = first.trim().split("\n");
    expect(first).toBe(second);
    expect(rows[1]).toBe("1.0000000000 0.0000000000");
    expect(rows.at(-1)).toBe("1.0000000000 0.0000000000");
    expect(rows).toHaveLength(162);
  });
});

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
    .join(",")}}`;
}
