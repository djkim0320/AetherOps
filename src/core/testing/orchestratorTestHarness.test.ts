import { describe, expect, it } from "vitest";
import { strictResearchInput, strictTestSettings } from "./orchestratorTestHarness.js";

describe("orchestrator test harness", () => {
  it("provides explicit strict test fixtures", () => {
    expect(strictTestSettings.embedding.provider).toBe("openai");
    expect(strictResearchInput.initialHypotheses.length).toBeGreaterThan(0);
  });
});
