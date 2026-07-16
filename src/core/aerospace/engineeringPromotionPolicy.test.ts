import { describe, expect, it } from "vitest";
import type { ConfigurationBaseline } from "./configurationBaseline.js";
import { validateEngineeringPromotion, type EngineeringPromotionCandidate } from "./engineeringPromotionPolicy.js";
import { createQuantity } from "./quantity.js";

const HASH = "a".repeat(64);

describe("engineering promotion policy", () => {
  it("accepts a converged polar only with an active baseline and complete coefficient references", () => {
    expect(validateEngineeringPromotion(candidate())).toEqual({ ok: true, reference: baseline().aerodynamicReference });
  });

  it.each([
    [
      "reference area",
      (value: EngineeringPromotionCandidate) => ({ ...value, baseline: { ...value.baseline, aerodynamicReference: undefined } }),
      "REFERENCE_GEOMETRY_MISSING"
    ],
    [
      "moment reference point",
      (value: EngineeringPromotionCandidate) => ({
        ...value,
        baseline: {
          ...value.baseline,
          aerodynamicReference: { ...value.baseline.aerodynamicReference!, momentReferencePointId: undefined }
        }
      }),
      "REFERENCE_GEOMETRY_MISSING"
    ],
    [
      "current baseline",
      (value: EngineeringPromotionCandidate) => ({ ...value, baseline: { ...value.baseline, status: "superseded" as const } }),
      "BASELINE_MISMATCH"
    ],
    [
      "geometry identity",
      (value: EngineeringPromotionCandidate) => ({ ...value, metadata: { ...value.metadata, geometryHash: "b".repeat(64) } }),
      "BASELINE_MISMATCH"
    ],
    [
      "active airfoil geometry identity",
      (value: EngineeringPromotionCandidate) => ({ ...value, baseline: { ...value.baseline, airfoilGeometryHash: "b".repeat(64) } }),
      "BASELINE_MISMATCH"
    ],
    ["convergence", (value: EngineeringPromotionCandidate) => ({ ...value, metadata: { ...value.metadata, convergence: "failed" as const } }), "NON_CONVERGED"],
    [
      "verified domain",
      (value: EngineeringPromotionCandidate) => ({ ...value, metadata: { ...value.metadata, domainAssessment: "not_assessed" as const } }),
      "DOMAIN_UNASSESSED"
    ],
    [
      "postcondition receipt",
      (value: EngineeringPromotionCandidate) => ({ ...value, tool: { ...value.tool, postconditionReceiptHash: "" } }),
      "POSTCONDITION_MISSING"
    ],
    [
      "dimensionless unit definition",
      (value: EngineeringPromotionCandidate) => ({ ...value, metadata: { ...value.metadata, unitDefinition: undefined } }),
      "UNIT_DEFINITION_MISSING"
    ]
  ])("rejects a polar without %s", (_label, mutate, code) => {
    expect(validateEngineeringPromotion(mutate(candidate()))).toMatchObject({ ok: false, code });
  });

  it("requires units and frames for dimensional engineering results", () => {
    const value = candidate();
    value.metadata = {
      ...value.metadata,
      resultKind: "dimensional_force",
      coefficientTypes: undefined,
      unitDefinition: undefined,
      coordinateFrameId: undefined,
      convergence: "not_applicable",
      domainAssessment: "not_assessed"
    };
    expect(validateEngineeringPromotion(value)).toMatchObject({ ok: false, code: "UNIT_DEFINITION_MISSING" });
    value.metadata.unitDefinition = { unit: "N", dimension: "mass length time^-2" };
    expect(validateEngineeringPromotion(value)).toMatchObject({ ok: false, code: "COORDINATE_FRAME_MISSING" });
    value.metadata.coordinateFrameId = "body-axes-v1";
    expect(validateEngineeringPromotion(value)).toMatchObject({ ok: false, code: "COORDINATE_FRAME_MISSING" });
    value.metadata.coordinateFrameId = value.baseline.coordinateConventionId;
    expect(validateEngineeringPromotion(value)).toMatchObject({ ok: true });
  });

  it("requires the full polar dependency set and an explicit dimensionless definition", () => {
    const missingSource = candidate();
    missingSource.metadata.dependencyAspects = missingSource.metadata.dependencyAspects.filter((aspect) => aspect !== "source_revision");
    expect(validateEngineeringPromotion(missingSource)).toMatchObject({ ok: false, code: "INVALID_RESULT_METADATA" });

    const missingAirfoilGeometry = candidate();
    missingAirfoilGeometry.metadata.dependencyAspects = missingAirfoilGeometry.metadata.dependencyAspects.filter((aspect) => aspect !== "airfoil_geometry");
    expect(validateEngineeringPromotion(missingAirfoilGeometry)).toMatchObject({ ok: false, code: "INVALID_RESULT_METADATA" });

    const wrongDimension = candidate();
    wrongDimension.metadata.unitDefinition = { unit: "m", dimension: "length" };
    expect(validateEngineeringPromotion(wrongDimension)).toMatchObject({ ok: false, code: "UNIT_DEFINITION_MISSING" });
  });

  it.each([
    ["unknown result kind", { resultKind: "unknown_result" }],
    ["unknown baseline aspect", { dependencyAspects: ["geometry", "unknown_aspect"] }],
    ["duplicate baseline aspect", { dependencyAspects: ["geometry", "geometry"] }],
    ["unknown convergence state", { convergence: "unknown" }],
    ["unknown domain state", { domainAssessment: "unknown" }],
    ["unknown sensitivity", { sensitivity: "unknown" }]
  ])("rejects %s at the runtime trust boundary", (_label, override) => {
    const value = candidate();
    value.metadata = { ...value.metadata, ...override } as typeof value.metadata;
    expect(validateEngineeringPromotion(value)).toMatchObject({ ok: false, code: "INVALID_RESULT_METADATA" });
  });
});

function candidate(): EngineeringPromotionCandidate {
  return {
    projectId: "project-1",
    baseline: baseline(),
    baselineDependencyHash: "b".repeat(64),
    metadata: {
      resultKind: "polar",
      dependencyAspects: [
        "geometry",
        "airfoil_geometry",
        "aerodynamic_reference",
        "atmosphere",
        "solver",
        "source_revision",
        "unit_convention",
        "coordinate_convention"
      ],
      geometryHash: HASH,
      coefficientTypes: ["CL", "CD", "CM"],
      unitDefinition: { unit: "1", dimension: "dimensionless" },
      modelCardId: "model-card:webxfoil-0.1.1",
      simulationRunReceiptId: "simulation:attempt-1",
      convergence: "converged",
      domainAssessment: "within_declared_domain",
      sensitivity: "project"
    },
    content: {
      sha256: "c".repeat(64),
      byteLength: 1024,
      mediaType: "application/json",
      casLocator: `terminal-cas/sha256/cc/${"c".repeat(64)}`
    },
    tool: {
      toolName: "EngineeringProgramTool",
      toolVersion: "1",
      executionMedia: "webxfoil-wasm@0.1.1",
      postconditionReceiptHash: "d".repeat(64)
    }
  };
}

function baseline(): ConfigurationBaseline {
  return {
    id: "baseline-1",
    projectId: "project-1",
    revision: 1,
    status: "active",
    geometryHash: HASH,
    airfoilGeometryHash: HASH,
    aerodynamicReference: {
      area: quantity(1, "m^2"),
      chord: quantity(1, "m"),
      span: quantity(1, "m"),
      momentReferencePointId: "quarter-chord",
      axisConventionId: "wind-axes-right-handed-v1",
      dynamicPressureDefinition: "q=0.5*rho*V^2"
    },
    unitConventionId: "si-v1",
    coordinateConventionId: "wind-axes-right-handed-v1",
    solverVersions: { "xfoil-wasm": "0.1.1" },
    materialRevisionIds: [],
    sourceRevisionIds: ["source-1"],
    equationVersionIds: ["aero-coefficients-v1"],
    contentHash: "e".repeat(64),
    createdAt: "2026-07-16T00:00:00.000Z",
    createdBy: "test",
    provenance: [{ id: "source-1", contentHash: "f".repeat(64) }]
  };
}

function quantity(value: number, unit: string) {
  return createQuantity({ value, unit, provenance: { sourceType: "user", sourceId: "baseline-fixture" } });
}
