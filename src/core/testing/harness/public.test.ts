import { describe, expect, it } from "vitest";
import { AETHERBENCH_A0727F2_FIXTURE_SUBJECT, createDefaultEvalCases, runDeterministicAetherBench } from "./public.js";

describe("deterministic AetherBench capabilities", () => {
  it("fails explicitly when an eval capability is unavailable", async () => {
    const evalCase = createDefaultEvalCases().find((candidate) => candidate.suite === "tool-composition");
    expect(evalCase).toBeDefined();

    await expect(
      runDeterministicAetherBench({
        cases: [evalCase!],
        capabilities: ["tool_catalog", "network"],
        subject: AETHERBENCH_A0727F2_FIXTURE_SUBJECT
      })
    ).rejects.toMatchObject({
      code: "MISSING_CAPABILITY",
      missingCapabilities: ["tool_execution"]
    });
  });
});
