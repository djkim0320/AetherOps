import type { StorageCanonicalRevisionPlanResult } from "../runtime/storage/v2/runStateAtomicTypes.js";
import { LeaseLostError } from "../runtime/storage/v2/leaseFence.js";
import type { StorageRunOwnership } from "../runtime/storage/v2/runStateTypes.js";
import type { StorageWorkerClient } from "../runtime/storage/worker/typedRuntime.js";
import type { CanonicalBudgetUsage } from "../../core/orchestration/budgetAccounting.js";
import type { CanonicalRevisionPlan } from "./canonicalRunTypes.js";
import { storageCanonicalRevisionPlan } from "./durableCanonicalRunGateway.js";
import type { DurableJobExecutionScope } from "./durableJobExecutionContext.js";

export async function commitDurableCanonicalBudget(
  client: StorageWorkerClient,
  requireActive: () => DurableJobExecutionScope,
  owner: StorageRunOwnership,
  preparePlan: (recordedAt: string) => Promise<CanonicalRevisionPlan>,
  recordedAt: string
): Promise<StorageCanonicalRevisionPlanResult> {
  const preparing = requireActive();
  assertActiveOwner(preparing, owner);
  const plan = await preparePlan(recordedAt);
  const active = requireActive();
  assertActiveOwner(active, owner);
  assertSameFence(preparing, active, owner.jobId);
  const receipt = budgetReceipt(plan.finalState);
  return client.request({
    name: "canonical.commitBudget",
    input: {
      fence: active.fence,
      occurredAt: recordedAt,
      owner,
      finalState: { revision: plan.finalState.revision, stateHash: plan.finalState.stateHash },
      exactReplay: plan.exactReplay,
      revisions: storageCanonicalRevisionPlan(owner, plan),
      receiptHash: receipt.hash,
      targetUsage: plan.finalState.budgetUsage as CanonicalBudgetUsage
    }
  });
}

function budgetReceipt(state: CanonicalRevisionPlan["finalState"]): { hash: string } {
  const decision = [...state.decisions].reverse().find((item) => item.decisionId.startsWith("budget-accounting-v1:"));
  const hash = decision?.decisionId.split(":").at(-1);
  if (!hash || !/^[a-f0-9]{64}$/.test(hash)) throw new Error("Canonical budget plan lacks its immutable accounting receipt hash.");
  return { hash };
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
