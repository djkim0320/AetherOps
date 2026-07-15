import { describe, expect, it } from "vitest";
import { isNacaSeries, normalizeNacaSeries } from "./airfoilIdentity.js";

describe("canonical NACA airfoil identity", () => {
  it.each([
    ["0012", "0012"],
    ["NACA0012", "0012"],
    ["naca 23012", "23012"]
  ])("normalizes %s for every solver adapter", (input, expected) => {
    expect(isNacaSeries(input)).toBe(true);
    expect(normalizeNacaSeries(input)).toBe(expected);
  });

  it.each(["012", "NACA 123456", "Clark Y", "NACA 00 12"])('rejects invalid identity "%s"', (input) => {
    expect(isNacaSeries(input)).toBe(false);
    expect(() => normalizeNacaSeries(input)).toThrow(/NACA airfoil/);
  });
});
