import { describe, expect, it } from "vitest";
import { assertValidWebXfoilResult } from "./webXfoilResultValidation.js";

describe("WebXFOIL result validation", () => {
  it("accepts a complete finite polar with the requested alpha sequence", () => {
    expect(() =>
      assertValidWebXfoilResult({
        alphaStart: -2,
        alphaEnd: 2,
        alphaStep: 2,
        rows: [
          { alpha: -2, cl: -0.2, cd: 0.01 },
          { alpha: 0, cl: 0, cd: 0.008 },
          { alpha: 2, cl: 0.2, cd: 0.01 }
        ],
        convergence: { hasNaN: false, hasFortranError: false, hasConvergenceFail: false }
      })
    ).not.toThrow();
  });

  it.each(["hasNaN", "hasFortranError", "hasConvergenceFail"] as const)("rejects solver flag %s", (flag) => {
    expect(() =>
      assertValidWebXfoilResult({
        alphaStart: 0,
        alphaEnd: 0,
        alphaStep: 1,
        rows: [{ alpha: 0, cl: 0, cd: 0.01 }],
        convergence: { hasNaN: false, hasFortranError: false, hasConvergenceFail: false, [flag]: true }
      })
    ).toThrow(flag);
  });

  it("rejects incomplete, duplicate, misordered, and negative-drag rows", () => {
    const convergence = { hasNaN: false, hasFortranError: false, hasConvergenceFail: false };
    expect(() => assertValidWebXfoilResult({ alphaStart: 0, alphaEnd: 1, alphaStep: 1, rows: [{ alpha: 0, cl: 0, cd: 0.01 }], convergence })).toThrow(
      /incomplete/i
    );
    expect(() =>
      assertValidWebXfoilResult({
        alphaStart: 0,
        alphaEnd: 1,
        alphaStep: 1,
        rows: [
          { alpha: 0, cl: 0, cd: 0.01 },
          { alpha: 0, cl: 0.1, cd: 0.02 }
        ],
        convergence
      })
    ).toThrow(/duplicate/i);
    expect(() =>
      assertValidWebXfoilResult({
        alphaStart: 0,
        alphaEnd: 1,
        alphaStep: 1,
        rows: [
          { alpha: 1, cl: 0.1, cd: 0.01 },
          { alpha: 0, cl: 0, cd: 0.01 }
        ],
        convergence
      })
    ).toThrow(/sequence mismatch/i);
    expect(() => assertValidWebXfoilResult({ alphaStart: 0, alphaEnd: 0, alphaStep: 1, rows: [{ alpha: 0, cl: 0, cd: -0.01 }], convergence })).toThrow(
      /negative drag/i
    );
  });
});
