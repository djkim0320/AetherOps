import type { RunStateRevision } from "../../core/orchestration/runStateCapsule.js";
import type { StorageCanonicalRevisionPlanResult } from "../runtime/storage/v2/runStateAtomicTypes.js";
import { LeaseLostError } from "../runtime/storage/v2/leaseFence.js";
import type { StorageRunOwnership } from "../runtime/storage/v2/runStateTypes.js";
import type { StorageWorkerClient } from "../runtime/storage/worker/typedRuntime.js";
import type { DurableJobExecutionScope } from "./durableJobExecutionContext.js";
import { storageCanonicalRevisionPlan } from "./durableCanonicalRunGateway.js";
import type { CanonicalRevisionPlan } from "./canonicalRunTypes.js";

export async function commitDurableCanonicalRevisionPlan(
  client: StorageWorkerClient,
  requireActive: () => DurableJobExecutionScope,
  owner: StorageRunOwnership,
  preparePlan: () => Promise<CanonicalRevisionPlan>
): Promise<RunStateRevision> {
  const preparing = requireActive();
  assertActiveOwner(preparing, owner);
  const plan = await preparePlan();
  const active = requireActive();
  assertActiveOwner(active, owner);
  assertSameFence(preparing, active, owner.jobId);
  const result = await client.request<StorageCanonicalRevisionPlanResult>({
    name: "canonical.commitPlan",
    input: {
      fence: active.fence,
      owner,
      finalState: { revision: plan.finalState.revision, stateHash: plan.finalState.stateHash },
      exactReplay: plan.exactReplay,
      revisions: storageCanonicalRevisionPlan(owner, plan)
    }
  });
  return result.finalRevision.data as RunStateRevision;
}

function assertActiveOwner(active: DurableJobExecutionScope, owner: StorageRunOwnership): void {
  if (active.fence.jobId !== owner.jobId || active.job.projectId !== owner.projectId) throw new LeaseLostError(owner.jobId);
}

function assertSameFence(left: DurableJobExecutionScope, right: DurableJobExecutionScope, jobId: string): void {
  if (
    left.fence.attempt !== right.fence.attempt ||
    left.fence.leaseGeneration !== right.fence.leaseGeneration ||
    left.fence.leaseOwner !== right.fence.leaseOwner
  ) {
    throw new LeaseLostError(jobId);
  }
}
