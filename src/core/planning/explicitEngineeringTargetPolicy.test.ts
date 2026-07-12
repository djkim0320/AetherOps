import { describe, expect, it } from "vitest";
import { detectExplicitEngineeringTarget, requestMatchesExplicitTarget } from "./explicitEngineeringTargetPolicy.js";

describe("explicit engineering target policy", () => {
  it("uses the affirmative goal before scope text that names forbidden alternatives", () => {
    expect(
      detectExplicitEngineeringTarget({
        goal: "Run the configured SU2 case and block if SU2 is unavailable.",
        topic: "Unavailable SU2 without solver fallback",
        scope: "SU2 is required. Do not select WebXFOIL, XFLR5, OpenVSP, or native XFOIL."
      })
    ).toBe("su2");
  });

  it("does not accept an all-target toolchain probe for an explicit solver", () => {
    expect(requestMatchesExplicitTarget({ kind: "toolchain-check", target: "all" }, "su2")).toBe(false);
    expect(requestMatchesExplicitTarget({ kind: "toolchain-check", target: "su2" }, "su2")).toBe(false);
    expect(requestMatchesExplicitTarget({ kind: "su2-case-run", target: "su2" }, "su2")).toBe(true);
    expect(requestMatchesExplicitTarget({ kind: "xfoil-wasm-polar", target: "xfoil-wasm" }, "xfoil-wasm")).toBe(true);
  });

  it("does not infer solver execution from a literature-only mention", () => {
    expect(
      detectExplicitEngineeringTarget({ goal: "Review literature about SU2 methods.", topic: "SU2 publications", scope: "Metadata review only." })
    ).toBeUndefined();
  });

  it("does not pin one solver when the affirmative goal requests a comparison", () => {
    expect(
      detectExplicitEngineeringTarget({ goal: "Run and compare SU2 and XFOIL.", topic: "SU2 comparison", scope: "Execute both solvers." })
    ).toBeUndefined();
  });
});
