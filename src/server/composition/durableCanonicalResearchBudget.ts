import type { CanonicalHasher } from "../../core/orchestration/orchestrationSchemas.js";
import type { CanonicalRunRuntime } from "./canonicalRunRuntime.js";
import type { CanonicalRevisionPlan, CanonicalRunOwner } from "./canonicalRunTypes.js";
import { observeCanonicalBudget, type CanonicalBudgetTracePort } from "./canonicalBudgetAccounting.js";
import type { DurableJobRecord } from "./durableJobTypes.js";

export async function prepareDurableCanonicalBudget(input: {
  port: CanonicalBudgetTracePort;
  jobs: DurableJobRecord[];
  owner: CanonicalRunOwner;
  runtime: CanonicalRunRuntime;
  hasher: CanonicalHasher;
  recordedAt: string;
}): Promise<CanonicalRevisionPlan> {
  const observation = await observeCanonicalBudget({
    port: input.port,
    jobs: input.jobs,
    projectId: input.owner.projectId,
    runId: input.owner.runId,
    activeJobId: input.owner.jobId,
    observedAt: input.recordedAt,
    hasher: input.hasher
  });
  const { state } = await input.runtime.readCurrentRun(input.owner);
  return input.runtime.prepareBudgetRevision({
    owner: input.owner,
    expectedState: { revision: state.revision, stateHash: state.stateHash },
    ...observation,
    recordedAt: input.recordedAt
  });
}
