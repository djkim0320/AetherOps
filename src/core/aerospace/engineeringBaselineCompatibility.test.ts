import { describe, expect, it } from "vitest";
import type { EngineeringQuantity } from "./quantity.js";
import type { ConfigurationBaseline } from "./configurationBaseline.js";
import {
  ENGINEERING_BASELINE_TARGETS,
  engineeringPromotionRuntimeReceiptSupport,
  engineeringBaselineRequirement,
  validateEngineeringBaselineCompatibility,
  validateEngineeringPromotionReadiness,
  type EngineeringBaselineTarget
} from "./engineeringBaselineCompatibility.js";

describe("engineering configuration baseline compatibility", () => {
  it.each(ENGINEERING_BASELINE_TARGETS)("accepts a complete active baseline for %s", (target) => {
    const assessment = validateEngineeringBaselineCompatibility(target, baseline());

    expect(assessment).toMatchObject({ target, ready: true, issues: [], missingAspects: [], solverVersion: { version: "1.0.0" } });
    expect(assessment.requiredAspects).toEqual(engineeringBaselineRequirement(target).requiredAspects);
  });

  it.each([
    ["codex", "codex"],
    ["webxfoil", "xfoil-wasm"],
    ["xfoil", "xfoil"],
    ["su2", "su2"],
    ["openvsp", "openvsp"],
    ["xflr5", "xflr5"],
    ["mesh", "modeling"]
  ] as const)("rejects %s when solver version %s is absent", (target, solverKey) => {
    const value = baseline();
    const { [solverKey]: _removed, ...solverVersions } = value.solverVersions;
    void _removed;

    const assessment = validateEngineeringBaselineCompatibility(target, { ...value, solverVersions });

    expect(assessment).toMatchObject({ ready: false, missingAspects: expect.arrayContaining(["solver"]) });
    expect(assessment.solverVersion).toBeUndefined();
    expect(assessment.issues).toEqual(expect.arrayContaining([expect.objectContaining({ code: "MISSING_SOLVER_VERSION", aspect: "solver" })]));
  });

  it.each([
    ["codex", "source_revision", (value: ConfigurationBaseline) => ({ ...value, sourceRevisionIds: [] })],
    ["webxfoil", "airfoil_geometry", (value: ConfigurationBaseline) => ({ ...value, airfoilGeometryHash: undefined })],
    ["xfoil", "aerodynamic_reference", (value: ConfigurationBaseline) => ({ ...value, aerodynamicReference: undefined })],
    ["su2", "mass_properties", (value: ConfigurationBaseline) => ({ ...value, massProperties: undefined, massPropertiesHash: undefined })],
    ["openvsp", "atmosphere", (value: ConfigurationBaseline) => ({ ...value, atmosphereModelId: undefined })],
    ["xflr5", "geometry", (value: ConfigurationBaseline) => ({ ...value, geometryHash: undefined })],
    ["mesh", "material", (value: ConfigurationBaseline) => ({ ...value, materialRevisionIds: [] })]
  ] as const)("rejects %s when required aspect %s is absent", (target, aspect, mutate) => {
    const assessment = validateEngineeringBaselineCompatibility(target, mutate(baseline()));

    expect(assessment).toMatchObject({ ready: false, missingAspects: expect.arrayContaining([aspect]) });
    expect(assessment.issues).toEqual(expect.arrayContaining([expect.objectContaining({ code: "MISSING_BASELINE_ASPECT", aspect })]));
  });

  it("rejects inactive and structurally invalid baselines without throwing", () => {
    expect(validateEngineeringBaselineCompatibility("codex", { ...baseline(), status: "superseded" })).toMatchObject({
      ready: false,
      issues: [expect.objectContaining({ code: "BASELINE_NOT_ACTIVE" })]
    });
    expect(validateEngineeringBaselineCompatibility("codex", { ...baseline(), contentHash: "invalid" })).toMatchObject({
      ready: false,
      issues: [expect.objectContaining({ code: "INVALID_BASELINE" })]
    });
  });

  it("accepts the explicit WebXFOIL alias but rejects conflicting alias versions", () => {
    const value = baseline();
    const withoutCanonical = { ...value.solverVersions };
    delete withoutCanonical["xfoil-wasm"];
    expect(validateEngineeringBaselineCompatibility("webxfoil", { ...value, solverVersions: { ...withoutCanonical, webxfoil: "0.1.1" } })).toMatchObject({
      ready: true,
      solverVersion: { key: "webxfoil", version: "0.1.1" }
    });
    expect(
      validateEngineeringBaselineCompatibility("webxfoil", {
        ...value,
        solverVersions: { ...value.solverVersions, webxfoil: "0.2.0" }
      })
    ).toMatchObject({ ready: false, issues: [expect.objectContaining({ code: "AMBIGUOUS_SOLVER_VERSION" })] });
  });

  it("fails closed for a target outside the declared catalog", () => {
    const assessment = validateEngineeringBaselineCompatibility("unknown" as EngineeringBaselineTarget, baseline());
    expect(assessment).toMatchObject({ ready: false, requiredAspects: [], issues: [expect.objectContaining({ code: "UNSUPPORTED_TARGET" })] });
  });

  it("allows promotion only for pinned Codex and WebXFOIL runtimes", () => {
    expect(engineeringPromotionRuntimeReceiptSupport("codex")).toEqual({ supported: true });
    expect(engineeringPromotionRuntimeReceiptSupport("webxfoil")).toEqual({ supported: true });
    expect(engineeringPromotionRuntimeReceiptSupport("xfoil")).toMatchObject({ supported: false, reason: expect.stringContaining("NOT_READY") });
    expect(engineeringPromotionRuntimeReceiptSupport("all")).toMatchObject({ supported: false, reason: expect.stringContaining("all") });

    const value = baseline();
    expect(validateEngineeringPromotionReadiness("webxfoil", value, "1.0.0")).toMatchObject({ ready: true });
    expect(validateEngineeringPromotionReadiness("webxfoil", value, "0.1.1")).toMatchObject({
      ready: false,
      issues: expect.arrayContaining([expect.objectContaining({ code: "RUNTIME_VERSION_MISMATCH" })])
    });
    expect(validateEngineeringPromotionReadiness("su2", value)).toMatchObject({
      ready: false,
      issues: expect.arrayContaining([expect.objectContaining({ code: "RUNTIME_RECEIPT_UNSUPPORTED" })])
    });
  });
});

function baseline(): ConfigurationBaseline {
  return {
    id: "baseline-complete-v1",
    projectId: "project-baseline-compatibility",
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
    propulsionModelId: "electric-propulsion-v1",
    unitConventionId: "si-v1",
    coordinateConventionId: "right-handed-cartesian-v1",
    solverVersions: { codex: "1.0.0", "xfoil-wasm": "1.0.0", xfoil: "1.0.0", su2: "1.0.0", openvsp: "1.0.0", xflr5: "1.0.0", modeling: "1.0.0" },
    materialRevisionIds: ["material:composite-v1"],
    sourceRevisionIds: ["source:geometry-v1"],
    equationVersionIds: ["equation:aero-v1"],
    contentHash: "4".repeat(64),
    createdAt: "2026-07-16T00:00:00.000Z",
    createdBy: "engineering-baseline-compatibility-test",
    provenance: [{ id: "source:geometry-v1", contentHash: "5".repeat(64) }]
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
