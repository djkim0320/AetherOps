import { ResearchLoopStep } from "../shared/types.js";

export const RESEARCH_DESIGN_SEQUENCE: ResearchLoopStep[] = [
  ResearchLoopStep.CreateResearchDb,
  ResearchLoopStep.InputResearchQuestionHypothesis,
  ResearchLoopStep.BuildResearchSpecification,
  ResearchLoopStep.PlanResearch
];

export const RESEARCH_EXECUTION_SEQUENCE: ResearchLoopStep[] = [
  ResearchLoopStep.ExecuteTools,
  ResearchLoopStep.NormalizeData,
  ResearchLoopStep.BuildVectorIndex,
  ResearchLoopStep.BuildOntologyGraph,
  ResearchLoopStep.ReasonAndValidate,
  ResearchLoopStep.SynthesizeAndEvaluate,
  ResearchLoopStep.DecideContinuation
];

export const RESEARCH_LOOP_SEQUENCE: ResearchLoopStep[] = [
  ResearchLoopStep.PlanResearch,
  ...RESEARCH_EXECUTION_SEQUENCE
];

export const RESEARCH_OUTPUT_SEQUENCE: ResearchLoopStep[] = [ResearchLoopStep.FinalizeOutputs];

export function nextResearchLoopStep(
  step: ResearchLoopStep,
  shouldContinue: boolean
): ResearchLoopStep {
  if (step === ResearchLoopStep.DecideContinuation) {
    return shouldContinue ? ResearchLoopStep.PlanResearch : ResearchLoopStep.FinalizeOutputs;
  }

  const designIndex = RESEARCH_DESIGN_SEQUENCE.indexOf(step);
  if (designIndex >= 0) {
    return RESEARCH_DESIGN_SEQUENCE[designIndex + 1] ?? ResearchLoopStep.ExecuteTools;
  }

  const executionIndex = RESEARCH_EXECUTION_SEQUENCE.indexOf(step);
  if (executionIndex >= 0) {
    return RESEARCH_EXECUTION_SEQUENCE[executionIndex + 1] ?? ResearchLoopStep.DecideContinuation;
  }

  return ResearchLoopStep.CreateResearchDb;
}

export function isResearchLoopStep(step: ResearchLoopStep): boolean {
  return RESEARCH_LOOP_SEQUENCE.includes(step);
}

export function isTerminalStep(step: ResearchLoopStep): boolean {
  return step === ResearchLoopStep.FinalizeOutputs;
}
