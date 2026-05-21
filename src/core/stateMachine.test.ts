import { describe, expect, it } from "vitest";
import { nextResearchLoopStep, RESEARCH_EXECUTION_SEQUENCE, RESEARCH_LOOP_SEQUENCE } from "./stateMachine.js";
import { normalizeResearchLoopStep, ResearchLoopStep } from "./types.js";

describe("research loop state machine", () => {
  it("keeps only the new 12-step enum values and maps legacy DB values through compatibility", () => {
    expect(Object.values(ResearchLoopStep)).toEqual([
      "CREATE_RESEARCH_DB",
      "INPUT_RESEARCH_QUESTION_HYPOTHESIS",
      "BUILD_RESEARCH_SPECIFICATION",
      "PLAN_RESEARCH",
      "EXECUTE_TOOLS",
      "NORMALIZE_DATA",
      "BUILD_VECTOR_INDEX",
      "BUILD_ONTOLOGY_GRAPH",
      "REASON_AND_VALIDATE",
      "SYNTHESIZE_AND_EVALUATE",
      "DECIDE_CONTINUATION",
      "FINALIZE_OUTPUTS"
    ]);
    expect(Object.values(ResearchLoopStep)).not.toContain("RUN_OPENCODE");
    expect(Object.values(ResearchLoopStep)).not.toContain("BUILD_RAG_CONTEXT");
    expect(Object.values(ResearchLoopStep)).not.toContain("DERIVE_EVIDENCE_BASED_RESULT");
    expect(normalizeResearchLoopStep("RUN_OPENCODE")).toBe(ResearchLoopStep.ExecuteTools);
    expect(normalizeResearchLoopStep("BUILD_RAG_CONTEXT")).toBe(ResearchLoopStep.BuildVectorIndex);
    expect(normalizeResearchLoopStep("DERIVE_EVIDENCE_BASED_RESULT")).toBe(ResearchLoopStep.SynthesizeAndEvaluate);
  });

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
    expect(nextResearchLoopStep(ResearchLoopStep.DecideContinuation, true)).not.toBe(ResearchLoopStep.ExecuteTools);
  });

  it("finalizes from step 11 when no extra research is needed", () => {
    expect(nextResearchLoopStep(ResearchLoopStep.DecideContinuation, false)).toBe(ResearchLoopStep.FinalizeOutputs);
  });
});
