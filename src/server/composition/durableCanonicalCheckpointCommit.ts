import type { StorageCanonicalStepCommitResult } from "../runtime/storage/v2/runStateAtomicTypes.js";
import { storageStepCheckpointId } from "../runtime/storage/v2/jobAtomicOperations.js";
import { LeaseLostError } from "../runtime/storage/v2/leaseFence.js";
import type { StorageRunOwnership } from "../runtime/storage/v2/runStateTypes.js";
import type { StorageContextPack } from "../runtime/storage/v2/runStateTypes.js";
import type { StorageCompletedStepInput } from "../runtime/storage/v2/types.js";
import type { StorageWorkerClient } from "../runtime/storage/worker/typedRuntime.js";
import type { CanonicalRevisionPlan } from "./canonicalRunTypes.js";
import { storageCanonicalRevisionPlan } from "./durableCanonicalRunGateway.js";
import type { DurableJobExecutionScope } from "./durableJobExecutionContext.js";

export interface DurableCanonicalCheckpointCommitInput {
  owner: StorageRunOwnership;
  step: string;
  projectRevision: number;
  requireContextPack?: boolean;
  prepareRevision(input: { checkpointId: string; recordedAt: string }): Promise<CanonicalRevisionPlan>;
}

export async function commitDurableCanonicalCheckpoint(
  client: StorageWorkerClient,
  requireActive: () => DurableJobExecutionScope,
  input: DurableCanonicalCheckpointCommitInput,
  recordedAt: string,
  completedStep: StorageCompletedStepInput
): Promise<StorageCanonicalStepCommitResult> {
  const preparing = requireActive();
  assertActiveOwner(preparing, input.owner);
  const checkpointId = storageStepCheckpointId(preparing.fence, input.step);
  const plan = await input.prepareRevision({ checkpointId, recordedAt });
  const contextPack = input.requireContextPack
    ? await client.request<StorageContextPack | undefined>({ name: "contextPack.latestForJob", owner: input.owner })
    : undefined;
  if (input.requireContextPack && !contextPack) throw new Error("Canonical checkpoint commit requires a persisted ContextPack for the active job.");
  const active = requireActive();
  assertActiveOwner(active, input.owner);
  assertSameFence(preparing, active, input.owner.jobId);
  return client.request({
    name: "canonical.commitStep",
    input: {
      step: {
        fence: active.fence,
        ...completedStep,
        ...(contextPack ? { checkpointData: contextCheckpointData(completedStep.checkpointData, contextPack.id) } : {}),
        projectRevision: input.projectRevision,
        occurredAt: recordedAt
      },
      owner: input.owner,
      finalState: { revision: plan.finalState.revision, stateHash: plan.finalState.stateHash },
      exactReplay: plan.exactReplay,
      revisions: storageCanonicalRevisionPlan(input.owner, plan, contextPack?.id)
    }
  });
}

function contextCheckpointData(value: unknown, contextPackId: string): Record<string, unknown> {
  if (isRecord(value) && value.canonicalContextPackId !== undefined && value.canonicalContextPackId !== contextPackId) {
    throw new Error("Checkpoint metadata attempted to replace its canonical ContextPack binding.");
  }
  return {
    phase: "step_completed",
    ...(isRecord(value) ? value : value === undefined ? {} : { stepData: value }),
    canonicalContextPackId: contextPackId
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
