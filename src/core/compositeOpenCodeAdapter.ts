import type { OpenCodeAdapter, OpenCodeRunInput, OpenCodeRunOutput } from "./types.js";

export class CompositeOpenCodeAdapter implements OpenCodeAdapter {
  constructor(private readonly adapters: OpenCodeAdapter[]) {}

  async run(input: OpenCodeRunInput): Promise<OpenCodeRunOutput> {
    let carried: OpenCodeRunOutput | undefined;
    for (const adapter of this.adapters) {
      const output = await adapter.run(input);
      if (!output.fallbackRecommended && output.run.status === "completed") {
        return mergeOutputs(carried, output);
      }
      carried = mergeOutputs(carried, output);
    }
    if (carried) {
      return carried;
    }
    throw new Error("No OpenCode adapter configured.");
  }
}

function mergeOutputs(previous: OpenCodeRunOutput | undefined, next: OpenCodeRunOutput): OpenCodeRunOutput {
  if (!previous) {
    return next;
  }
  return {
    ...next,
    run: {
      ...next.run,
      logs: [...previous.run.logs, ...next.run.logs],
      artifactIds: [...previous.run.artifactIds, ...next.run.artifactIds],
      evidenceIds: [...previous.run.evidenceIds, ...next.run.evidenceIds]
    },
    artifacts: [...previous.artifacts, ...next.artifacts],
    evidence: [...previous.evidence, ...next.evidence],
    sources: [...(previous.sources ?? []), ...(next.sources ?? [])],
    chunks: [...(previous.chunks ?? []), ...(next.chunks ?? [])],
    toolRuns: [...(previous.toolRuns ?? []), ...(next.toolRuns ?? [])],
    nextActions: [...(previous.nextActions ?? []), ...(next.nextActions ?? [])],
    needsMoreEvidence: previous.needsMoreEvidence || next.needsMoreEvidence,
    needsMoreAnalysis: previous.needsMoreAnalysis || next.needsMoreAnalysis
  };
}
