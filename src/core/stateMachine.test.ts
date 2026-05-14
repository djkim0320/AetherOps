import { describe, expect, it } from "vitest";
import { nextResearchLoopStep, RESEARCH_LOOP_SEQUENCE } from "./stateMachine.js";
import { ResearchLoopStep } from "./types.js";

describe("research loop state machine", () => {
  it("keeps the exact 5 -> 6 -> 7 -> 8 -> 5 loop when more work is needed", () => {
    expect(RESEARCH_LOOP_SEQUENCE).toEqual([
      ResearchLoopStep.RunOpenCode,
      ResearchLoopStep.StoreResults,
      ResearchLoopStep.BuildRagContext,
      ResearchLoopStep.DeriveEvidenceBasedResult
    ]);

    expect(nextResearchLoopStep(ResearchLoopStep.RunOpenCode, true)).toBe(ResearchLoopStep.StoreResults);
    expect(nextResearchLoopStep(ResearchLoopStep.StoreResults, true)).toBe(ResearchLoopStep.BuildRagContext);
    expect(nextResearchLoopStep(ResearchLoopStep.BuildRagContext, true)).toBe(ResearchLoopStep.DeriveEvidenceBasedResult);
    expect(nextResearchLoopStep(ResearchLoopStep.DeriveEvidenceBasedResult, true)).toBe(ResearchLoopStep.RunOpenCode);
  });

  it("finalizes from step 8 when no extra evidence or analysis is needed", () => {
    expect(nextResearchLoopStep(ResearchLoopStep.DeriveEvidenceBasedResult, false)).toBe(
      ResearchLoopStep.FinalizeResearchOutputs
    );
  });
});
