import type { ResearchToolInput, ToolRun } from "../shared/types.js";
import type { ResearchToolResult } from "./researchToolTypes.js";

export type RollingResearchToolInput = ResearchToolInput & { toolRuns?: ToolRun[] };

export function accumulateToolResult(input: RollingResearchToolInput, result: ResearchToolResult): RollingResearchToolInput {
  return {
    ...input,
    evidence: [...(input.evidence ?? []), ...result.evidence],
    artifacts: [...(input.artifacts ?? []), ...result.artifacts],
    sources: [...(input.sources ?? []), ...result.sources],
    toolRuns: [...(input.toolRuns ?? []), result.toolRun]
  };
}

export function cloneRollingInput(input: RollingResearchToolInput): RollingResearchToolInput {
  return {
    ...input,
    evidence: [...(input.evidence ?? [])],
    artifacts: [...(input.artifacts ?? [])],
    sources: [...(input.sources ?? [])],
    sourceCandidates: [...(input.sourceCandidates ?? [])],
    toolRuns: [...(input.toolRuns ?? [])],
    normalizedRecords: [...(input.normalizedRecords ?? [])],
    validationResults: [...(input.validationResults ?? [])],
    projectContextSnapshots: [...(input.projectContextSnapshots ?? [])],
    results: [...(input.results ?? [])]
  };
}
