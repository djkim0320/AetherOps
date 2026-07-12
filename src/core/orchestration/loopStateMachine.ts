import type { ResearchSnapshot } from "../shared/types.js";

export const INTERNAL_LOOP_SAFETY_CAP = 8;

export function nextIteration(snapshot: ResearchSnapshot): number {
  return Math.max(snapshot.results.length, snapshot.legacyAgentRuns.length, snapshot.researchPlans.length) + 1;
}

export function nextExecutionIteration(snapshot: ResearchSnapshot): number {
  return Math.max(snapshot.results.length, latestCompletedLegacyAgentIteration(snapshot.legacyAgentRuns)) + 1;
}

export function latestCompletedLegacyAgentIteration(legacyAgentRuns: ResearchSnapshot["legacyAgentRuns"]): number {
  let latest = 0;
  for (const run of legacyAgentRuns) {
    if (run.status === "completed" && run.iteration > latest) latest = run.iteration;
  }
  return latest;
}

export function resolveSafetyCapIterations(maxLoopIterations: number | undefined): number {
  if (typeof maxLoopIterations === "number" && Number.isFinite(maxLoopIterations) && maxLoopIterations > 0) {
    return Math.max(1, Math.floor(maxLoopIterations));
  }
  return INTERNAL_LOOP_SAFETY_CAP;
}
