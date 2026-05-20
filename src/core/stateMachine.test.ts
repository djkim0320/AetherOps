import { describe, expect, it } from "vitest";
import { nextResearchLoopStep, RESEARCH_EXECUTION_SEQUENCE, RESEARCH_LOOP_SEQUENCE } from "./stateMachine.js";
import { ResearchLoopStep } from "./types.js";

describe("research loop state machine", () => {
  it("keeps the 12-step loop and returns from decision to planning when more work is needed", () => {
    expect(RESEARCH_EXECUTION_SEQUENCE).toEqual([
      ResearchLoopStep.ExecuteTools,
      ResearchLoopStep.NormalizeData,
      ResearchLoopStep.BuildVectorIndex,
      ResearchLoopStep.BuildOntologyGraph,
      ResearchLoopStep.ReasonAndValidate,
      ResearchLoopStep.SynthesizeAndEvaluate,
      ResearchLoopStep.DecideContinuation
    ]);
    expect(RESEARCH_LOOP_SEQUENCE[0]).toBe(ResearchLoopStep.PlanResearch);
    expect(nextResearchLoopStep(ResearchLoopStep.PlanResearch, true)).toBe(ResearchLoopStep.ExecuteTools);
    expect(nextResearchLoopStep(ResearchLoopStep.DecideContinuation, true)).toBe(ResearchLoopStep.PlanResearch);
  });

  it("finalizes from step 11 when no extra research is needed", () => {
    expect(nextResearchLoopStep(ResearchLoopStep.DecideContinuation, false)).toBe(ResearchLoopStep.FinalizeOutputs);
  });
});
