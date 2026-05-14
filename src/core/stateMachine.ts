import { ResearchLoopStep } from "./types.js";

export const INITIALIZATION_SEQUENCE: ResearchLoopStep[] = [
  ResearchLoopStep.CreateProject,
  ResearchLoopStep.CreateSubSessions,
  ResearchLoopStep.CreateResearchDb,
  ResearchLoopStep.GenerateQuestionsHypothesesEvidence
];

export const RESEARCH_LOOP_SEQUENCE: ResearchLoopStep[] = [
  ResearchLoopStep.RunOpenCode,
  ResearchLoopStep.StoreResults,
  ResearchLoopStep.BuildRagContext,
  ResearchLoopStep.DeriveEvidenceBasedResult
];

export function nextInitializationStep(step: ResearchLoopStep): ResearchLoopStep {
  const index = INITIALIZATION_SEQUENCE.indexOf(step);
  if (index === -1 || index === INITIALIZATION_SEQUENCE.length - 1) {
    return ResearchLoopStep.RunOpenCode;
  }
  return INITIALIZATION_SEQUENCE[index + 1];
}

export function nextResearchLoopStep(
  step: ResearchLoopStep,
  shouldContinue: boolean
): ResearchLoopStep {
  if (step === ResearchLoopStep.DeriveEvidenceBasedResult) {
    return shouldContinue ? ResearchLoopStep.RunOpenCode : ResearchLoopStep.FinalizeResearchOutputs;
  }

  const index = RESEARCH_LOOP_SEQUENCE.indexOf(step);
  if (index === -1) {
    return ResearchLoopStep.RunOpenCode;
  }

  return RESEARCH_LOOP_SEQUENCE[index + 1] ?? ResearchLoopStep.DeriveEvidenceBasedResult;
}

export function isResearchLoopStep(step: ResearchLoopStep): boolean {
  return RESEARCH_LOOP_SEQUENCE.includes(step);
}

export function isTerminalStep(step: ResearchLoopStep): boolean {
  return step === ResearchLoopStep.FinalizeResearchOutputs;
}
