import { describe, expect, it } from "vitest";
import { BrowserResourceLimitError, enforceCaptureBudget } from "./browserResourceBudget.js";

describe("browser resource budgets", () => {
  it("accepts captures within both per-item and aggregate limits", () => {
    expect(enforceCaptureBudget("screenshot", 4, 5, 8, 3)).toBe(7);
  });

  it("rejects an oversized individual capture", () => {
    expect(() => enforceCaptureBudget("screenshot", 6, 5, 20, 0)).toThrow(BrowserResourceLimitError);
  });

  it("rejects an aggregate capture overflow", () => {
    expect(() => enforceCaptureBudget("screenshot", 4, 5, 8, 5)).toThrow(/aggregate/);
  });
});
