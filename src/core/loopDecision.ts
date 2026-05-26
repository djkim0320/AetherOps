import { createId, nowIso } from "./ids.js";
import type { ContinuationDecision, EvidenceBasedResult, ResearchSnapshot } from "./types.js";

export class LoopDecisionEngine {
  decide(input: {
    snapshot: ResearchSnapshot;
    result: EvidenceBasedResult;
    iteration: number;
    safetyCapIterations: number;
    beforeCounts: { evidence: number; artifacts: number; chunks: number; entities: number; relations: number };
  }): ContinuationDecision {
    const after = input.snapshot;
    const growth = {
      evidence: after.evidence.length - input.beforeCounts.evidence,
      artifacts: after.artifacts.length - input.beforeCounts.artifacts,
      chunks: after.chunks.length - input.beforeCounts.chunks,
      entities: after.ontologyEntities.length - input.beforeCounts.entities,
      relations: after.ontologyRelations.length - input.beforeCounts.relations
    };
    const evidenceGaps = [
      ...input.result.nextQuestions,
      ...after.validationResults.slice(-after.hypotheses.length).flatMap((result) => result.evidenceGaps)
    ].filter(Boolean);
    const repeatedLowGrowth = input.iteration > 1 && Object.values(growth).every((value) => value <= 0);
    const hitSafetyCap = input.iteration >= input.safetyCapIterations;
    const statusBlocked = after.project.status === "aborted" || after.project.status === "paused";
    const shouldContinue =
      !hitSafetyCap &&
      !statusBlocked &&
      !repeatedLowGrowth &&
      (input.result.needsMoreEvidence || input.result.needsMoreAnalysis || input.result.nextQuestions.length > 0);

    return {
      id: createId("decision"),
      projectId: after.project.id,
      iteration: input.iteration,
      shouldContinue,
      reason: reason({ hitSafetyCap, statusBlocked, repeatedLowGrowth, result: input.result, growth }),
      nextObjective: shouldContinue
        ? `Resolve ${evidenceGaps[0] ?? "remaining evidence gaps"} and improve citation coverage for priority hypotheses.`
        : undefined,
      nextQuestions: shouldContinue ? [...new Set(input.result.nextQuestions)].slice(0, 5) : [],
      evidenceGaps: [...new Set(evidenceGaps)].slice(0, 8),
      forceStop: hitSafetyCap,
      planRevisionHints: shouldContinue
        ? [
            "Return to Step 4 and revise the research plan before executing tools again.",
            "Prioritize traceable sources over additional seed or untraceable artifacts.",
            growth.evidence <= 0 ? "Previous iteration produced little or no new evidence; change tool/source strategy." : "Use new evidence to narrow validation targets."
          ]
        : [],
      createdAt: nowIso()
    };
  }
}

function reason(input: {
  hitSafetyCap: boolean;
  statusBlocked: boolean;
  repeatedLowGrowth: boolean;
  result: EvidenceBasedResult;
  growth: Record<string, number>;
}): string {
  if (input.hitSafetyCap) return "Internal loop safety cap reached; finalize with explicit limitations.";
  if (input.statusBlocked) return "Project is paused or aborted.";
  if (input.repeatedLowGrowth) return "No meaningful new evidence, artifact, vector chunk, or graph relation was produced.";
  if (input.result.needsMoreEvidence || input.result.needsMoreAnalysis || input.result.nextQuestions.length) {
    return `More research is needed. Growth: ${JSON.stringify(input.growth)}.`;
  }
  return "Current evidence and analysis are sufficient for final output.";
}
