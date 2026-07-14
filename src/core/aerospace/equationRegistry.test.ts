import { describe, expect, it } from "vitest";
import { AREA, FORCE, PRESSURE, VELOCITY, dimension } from "./dimensions.js";
import { EquationRegistry, checkEquationDimensions, executeEquation, type EquationSpec } from "./equationRegistry.js";
import { createQuantity } from "./quantity.js";

describe("aerospace equation registry", () => {
  it("dimension-checks and executes dynamic pressure with a receipt", () => {
    const registry = new EquationRegistry();
    const spec = dynamicPressure();
    expect(registry.register(spec).passed).toBe(true);
    registry.activate(spec.id, spec.version);
    const receipt = executeEquation({
      spec: registry.get(spec.id, spec.version),
      variables: {
        rho: createQuantity({ value: 1.225, unit: "kg/m^3", provenance: { sourceType: "source", sourceId: "atmosphere-1" } }),
        velocity: createQuantity({ value: 100, unit: "m/s", provenance: { sourceType: "measurement", sourceId: "airspeed-1" } })
      },
      sanityChecks: [(value) => ({ name: "positive", passed: value > 0, detail: "Dynamic pressure must be positive." })]
    });
    expect(receipt.valueSI).toBeCloseTo(6125, 12);
    expect(receipt.passed).toBe(true);
    expect(receipt.sanityChecks).toEqual([{ name: "positive", passed: true, detail: "Dynamic pressure must be positive." }]);
  });

  it("rejects dimensionally invalid active equations", () => {
    const invalid = { ...dynamicPressure(), output: { id: "q", description: "wrong", dimension: FORCE } };
    expect(checkEquationDimensions(invalid).passed).toBe(false);
    expect(() => new EquationRegistry().register(invalid)).toThrow(/dimension check failed/i);
  });

  it("requires source and implementation evidence before activation", () => {
    const spec = { ...dynamicPressure(), sourceEvidenceIds: [] };
    const registry = new EquationRegistry();
    registry.register({ ...spec, status: "candidate" });
    expect(() => registry.activate(spec.id, spec.version)).toThrow(/source and implementation evidence/i);
  });

  it("rejects missing dimensions, receipts and failed sanity checks", () => {
    const registry = new EquationRegistry();
    registry.register(dynamicPressure());
    registry.activate("dynamic-pressure", "1");
    const active = registry.get("dynamic-pressure", "1");
    expect(() => executeEquation({ spec: active, variables: {} })).toThrow(/input is missing/i);
    expect(() =>
      executeEquation({
        spec: active,
        variables: {
          rho: createQuantity({ value: 1, unit: "kg", provenance: { sourceType: "user", sourceId: "bad" } }),
          velocity: createQuantity({ value: 1, unit: "m/s", provenance: { sourceType: "user", sourceId: "v" } })
        }
      })
    ).toThrow(/dimension mismatch/i);
    expect(() =>
      executeEquation({
        spec: active,
        variables: {
          rho: createQuantity({ value: 1.225, unit: "kg/m^3", provenance: { sourceType: "solver", sourceId: "solver-output" } }),
          velocity: createQuantity({ value: 100, unit: "m/s", provenance: { sourceType: "user", sourceId: "v" } })
        }
      })
    ).toThrow(/requires a receipt/i);
  });

  it("distinguishes pressure from coefficient normalization dimensions", () => {
    expect(checkEquationDimensions(dynamicPressure()).expectedDimension).toContain("mass");
    expect(AREA.length).toBe(2);
  });
});

function dynamicPressure(): EquationSpec {
  return {
    id: "dynamic-pressure",
    version: "1",
    name: "Dynamic pressure",
    expressionText: "0.5 * rho * velocity^2",
    expression: {
      type: "multiply",
      left: { type: "constant", valueSI: 0.5, dimension: dimension() },
      right: { type: "multiply", left: { type: "variable", id: "rho" }, right: { type: "power", value: { type: "variable", id: "velocity" }, exponent: 2 } }
    },
    variables: [
      { id: "rho", description: "density", dimension: dimension({ mass: 1, length: -3 }) },
      { id: "velocity", description: "true airspeed", dimension: VELOCITY }
    ],
    output: { id: "q", description: "dynamic pressure", dimension: PRESSURE },
    assumptions: ["continuum flow"],
    applicability: "Classical flight-condition calculation within input model domains.",
    excludedEffects: [],
    sourceEvidenceIds: ["source-fluid-mechanics"],
    implementationTestIds: ["dynamic-pressure-reference"],
    status: "implementation_verified"
  };
}
