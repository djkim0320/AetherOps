import { describe, expect, it } from "vitest";
import { deterministicTestHasher } from "../testing/deterministicTestHasher.js";
import { createQuantity } from "./quantity.js";
import { defineFlightCondition, isaTroposphere } from "./flightCondition.js";

const hasher = deterministicTestHasher;

describe("atmosphere and flight-condition contracts", () => {
  it("computes a source-bound ISA troposphere state and dimensioned flight condition", () => {
    const altitude = quantity(3_000, "m", "mission:altitude");
    const atmosphere = isaTroposphere(altitude, "source:isa-1976", hasher);
    const condition = defineFlightCondition({
      id: "fc:cruise",
      frameId: "frame:wind",
      trueAirspeed: quantity(70, "m/s", "mission:speed"),
      referenceLength: quantity(1.5, "m", "baseline:chord"),
      dynamicViscosity: quantity(0.0000175, "Pa*s", "source:viscosity"),
      atmosphere,
      hasher
    });

    expect(atmosphere.temperature.valueSI).toBeCloseTo(268.65, 8);
    expect(condition.dynamicPressure.valueSI).toBeGreaterThan(0);
    expect(condition.mach.valueSI).toBeGreaterThan(0.2);
    expect(condition.reynoldsNumber.valueSI).toBeGreaterThan(4_000_000);
    expect(condition.receipt.contentHash).toMatch(/^[a-f0-9]{64}$/);
    expect(condition.frameId).toBe("frame:wind");
  });

  it("fails closed outside the implemented atmosphere domain", () => {
    expect(() => isaTroposphere(quantity(12_000, "m", "mission:altitude"), "source:isa-1976", hasher)).toThrow(/11,000 m/);
  });
});

function quantity(value: number, unit: string, sourceId: string) {
  return createQuantity({ value, unit, provenance: { sourceType: "source", sourceId } });
}
