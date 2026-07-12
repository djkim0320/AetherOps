import { describe, expect, it } from "vitest";
import type { AppSettings, CfdRunSpec } from "../../../core/shared/types.js";
import { normalizeEngineeringProgramRequests, validateCfdRunSpecForTarget } from "./engineeringProgramRequestValidator.js";

describe("engineering program request validation", () => {
  it("rejects request kind and target mismatches", () => {
    expect(() => normalizeEngineeringProgramRequests([{ kind: "xfoil-wasm-polar", target: "xflr5" }])).toThrow(/requires target=xfoil-wasm/);
  });

  it("rejects solver/target mismatches and unidentified configured cases", () => {
    const base: CfdRunSpec = {
      target: "su2",
      geometry: { source: "configuredCase" },
      flightCondition: {},
      solver: { name: "su2" }
    };
    expect(() => validateCfdRunSpecForTarget(base, "su2", {} as AppSettings)).toThrow(/configuredCaseId/);
    expect(() =>
      validateCfdRunSpecForTarget(
        { ...base, geometry: { source: "configuredCase", configuredCaseId: "case-1" }, solver: { name: "xflr5" } },
        "su2",
        {} as AppSettings
      )
    ).toThrow(/incompatible solver/);
  });

  it("rejects unknown runtime kinds, targets, and malformed CFD specs instead of dropping them", () => {
    expect(() => normalizeEngineeringProgramRequests([{ kind: "unknown" }])).toThrow(/Unsupported.*kind/);
    expect(() => normalizeEngineeringProgramRequests([{ kind: "toolchain-check", target: "automatic" }])).toThrow(/Unsupported.*target/);
    expect(() => normalizeEngineeringProgramRequests([{ kind: "xfoil-wasm-polar", target: "xfoil-wasm", cfdRunSpec: {} }])).toThrow(/invalid cfdRunSpec/);
  });
});
