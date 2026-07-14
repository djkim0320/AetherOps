import { describe, expect, it } from "vitest";
import { ANGLE, AREA, FORCE, MASS, MOMENT, PRESSURE, VELOCITY, dimensionsEqual } from "./dimensions.js";
import { absolutePressureFromGauge, assertQuantityDimension, convertQuantity, createQuantity, formatQuantity } from "./quantity.js";
import { resolveUnit } from "./units.js";

const provenance = { sourceType: "user" as const, sourceId: "fixture-input" };

describe("aerospace engineering quantities", () => {
  it("keeps mass and force dimensions distinct across lbm, lbf and slug", () => {
    const lbm = createQuantity({ value: 10, unit: "lbm", provenance });
    const lbf = createQuantity({ value: 10, unit: "lbf", provenance });
    const slug = createQuantity({ value: 1, unit: "slug", provenance });
    expect(dimensionsEqual(lbm.dimension, MASS)).toBe(true);
    expect(dimensionsEqual(slug.dimension, MASS)).toBe(true);
    expect(dimensionsEqual(lbf.dimension, FORCE)).toBe(true);
    expect(() => assertQuantityDimension(lbm, FORCE, "weight")).toThrow(/expected mass length time\^-2/i);
  });

  it("parses compound wing-loading and moment units with dimensions", () => {
    expect(dimensionsEqual(resolveUnit("kg/m^2").dimension, resolveUnit("lbm/ft^2").dimension)).toBe(true);
    expect(dimensionsEqual(resolveUnit("N*m").dimension, MOMENT)).toBe(true);
    expect(dimensionsEqual(resolveUnit("lbf*ft").dimension, MOMENT)).toBe(true);
    expect(dimensionsEqual(resolveUnit("m^2").dimension, AREA)).toBe(true);
  });

  it("converts exact customary length and speed factors without confusing knot and ft/s", () => {
    const nauticalMile = createQuantity({ value: 1, unit: "nmi", provenance });
    const converted = convertQuantity(nauticalMile, "m");
    expect(converted.quantity.originalValue).toBe(1852);
    expect(converted.receipt.exactScale).toEqual({ numerator: 1852, denominator: 1 });
    const knot = createQuantity({ value: 1, unit: "knot", provenance });
    expect(knot.valueSI).toBeCloseTo(1852 / 3600, 14);
    expect(dimensionsEqual(knot.dimension, VELOCITY)).toBe(true);
    expect(createQuantity({ value: 1, unit: "ft/s", provenance }).valueSI).toBeCloseTo(0.3048, 14);
    expect(createQuantity({ value: 1, unit: "mi", provenance }).valueSI).toBeCloseTo(1609.344, 12);
  });

  it("distinguishes absolute temperature from temperature difference", () => {
    const absolute = createQuantity({ value: 20, unit: "degC", provenance });
    const delta = createQuantity({ value: 20, unit: "delta_degC", provenance });
    expect(absolute.valueSI).toBeCloseTo(293.15, 12);
    expect(delta.valueSI).toBe(20);
    expect(() => convertQuantity(absolute, "delta_degC")).toThrow(/semantics/i);
    expect(convertQuantity(absolute, "K").quantity.originalValue).toBeCloseTo(293.15, 12);
    expect(convertQuantity(createQuantity({ value: 18, unit: "delta_degF", provenance }), "delta_degC").quantity.originalValue).toBeCloseTo(10, 12);
  });

  it("requires an explicit absolute reference to convert gauge pressure", () => {
    const gauge = createQuantity({ value: 10, unit: "psig", provenance });
    const ambient = createQuantity({ value: 14.6959, unit: "psia", provenance });
    expect(() => convertQuantity(gauge, "psia")).toThrow(/semantics/i);
    const absolute = absolutePressureFromGauge(gauge, ambient);
    expect(absolute.semantic).toBe("absolute_pressure");
    expect(absolute.valueSI).toBeCloseTo(gauge.valueSI + ambient.valueSI, 8);
    expect(dimensionsEqual(absolute.dimension, PRESSURE)).toBe(true);
  });

  it("distinguishes degrees and radians while preserving angle dimension", () => {
    const degrees = createQuantity({ value: 180, unit: "deg", provenance });
    const radians = convertQuantity(degrees, "rad");
    expect(dimensionsEqual(degrees.dimension, ANGLE)).toBe(true);
    expect(radians.quantity.originalValue).toBeCloseTo(Math.PI, 14);
  });

  it("converts uncertainty with scale and formats precision from uncertainty", () => {
    const length = createQuantity({
      value: 10,
      unit: "ft",
      displayUnit: "m",
      uncertainty: { standardUncertainty: 0.1, kind: "epistemic", sourceId: "drawing-tolerance" },
      provenance
    });
    expect(length.uncertainty?.standardUncertaintySI).toBeCloseTo(0.03048, 14);
    expect(formatQuantity(length)).toBe("3.05 ± 0.03 m");
  });

  it("rejects unitless, nonfinite, incompatible and affine compound input", () => {
    expect(() => createQuantity({ value: 1, unit: "", provenance })).toThrow(/explicit unit/i);
    expect(() => createQuantity({ value: Number.NaN, unit: "m", provenance })).toThrow(/finite/i);
    expect(() => convertQuantity(createQuantity({ value: 1, unit: "kg", provenance }), "N")).toThrow(/dimension mismatch/i);
    expect(() => resolveUnit("degC/m")).toThrow(/cannot be compounded/i);
  });

  it("requires explicit dimensionless semantics for Mach and coefficients", () => {
    const mach = createQuantity({ value: 0.78, unit: "Mach", provenance });
    const coefficient = createQuantity({ value: 0.4, unit: "coef", provenance });
    expect(mach.semantic).toBe("mach");
    expect(coefficient.semantic).toBe("coefficient");
    expect(() => convertQuantity(mach, "1")).toThrow(/semantics/i);
  });
});
