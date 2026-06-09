import { describe, expect, it } from "vitest";
import { normalizeResearchLoopStep, ResearchLoopStep } from "./types.js";

describe("ResearchLoopStep compatibility", () => {
  it("keeps the canonical 12-step loop and maps legacy stored step values", () => {
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
    expect(normalizeResearchLoopStep("RUN_OPENCODE")).toBe(ResearchLoopStep.ExecuteTools);
    expect(normalizeResearchLoopStep("BUILD_RAG_CONTEXT")).toBe(ResearchLoopStep.BuildVectorIndex);
    expect(normalizeResearchLoopStep("DERIVE_EVIDENCE_BASED_RESULT")).toBe(ResearchLoopStep.SynthesizeAndEvaluate);
    expect(() => normalizeResearchLoopStep("UNKNOWN_STEP")).toThrow("Unknown research loop step");
  });
});
