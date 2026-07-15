import type { JobStatus } from "../../contracts/api-v2/jobs.js";
import type { StorageCanonicalBudgetPrefix, StorageCanonicalTerminalTransitionResult } from "../runtime/storage/v2/runStateAtomicTypes.js";
import { storageStepCheckpointId } from "../runtime/storage/v2/jobAtomicOperations.js";
import { LeaseLostError } from "../runtime/storage/v2/leaseFence.js";
import type { StorageRunOwnership } from "../runtime/storage/v2/runStateTypes.js";
import type { StorageCompletedStepInput } from "../runtime/storage/v2/types.js";
import type { StorageOutputPromotion, StorageTerminalQuarantinedStepInput, StorageTerminalTransitionResult } from "../runtime/storage/v2/jobAtomicTypes.js";
import type { StorageWorkerClient } from "../runtime/storage/worker/typedRuntime.js";
import type { CanonicalRevisionPlan } from "./canonicalRunTypes.js";
import { storageCanonicalRevisionPlan } from "./durableCanonicalRunGateway.js";

interface ActiveCanonicalTerminalScope {
  fence: { jobId: string; attempt: number; leaseOwner: string; leaseGeneration: number };
  job: { projectId: string };
}

type CanonicalDurableTerminalStatus = Extract<JobStatus, "paused" | "aborted" | "interrupted" | "blocked" | "failed" | "completed">;

export interface DurableCanonicalTerminalTransition {
  owner: StorageRunOwnership;
  prepareRevision(input: {
    status: CanonicalDurableTerminalStatus;
    recordedAt: string;
    completedStepCheckpointId?: string;
    completedStep?: StorageCompletedStepInput;
  }): Promise<
    CanonicalRevisionPlan & {
      budgetPrefix: StorageCanonicalBudgetPrefix;
      budgetExceededDimensions?: string[];
    }
  >;
}

export interface DurableCanonicalTerminalInput {
  status: CanonicalDurableTerminalStatus;
  projectRevision: number;
  reason?: string;
  promotions?: StorageOutputPromotion[];
  completedStep?: StorageCompletedStepInput;
  quarantinedStep?: StorageTerminalQuarantinedStepInput;
}

export async function transitionDurableCanonicalTerminal(
  client: StorageWorkerClient,
  requireActive: () => ActiveCanonicalTerminalScope,
  transition: DurableCanonicalTerminalTransition,
  terminal: DurableCanonicalTerminalInput,
  recordedAt: string
): Promise<StorageTerminalTransitionResult> {
  const preparing = requireActive();
  assertActiveOwner(preparing, transition.owner);
  const completedStepCheckpointId = terminal.completedStep ? storageStepCheckpointId(preparing.fence, terminal.completedStep.step) : undefined;
  const plan = await transition.prepareRevision({
    status: terminal.status,
    recordedAt,
    ...(completedStepCheckpointId ? { completedStepCheckpointId } : {}),
    ...(terminal.completedStep ? { completedStep: terminal.completedStep } : {})
  });
  const active = requireActive();
  assertActiveOwner(active, transition.owner);
  assertSameFence(preparing, active, transition.owner.jobId);
  const effectiveTerminal = terminalAfterBudgetEnforcement(terminal, plan.budgetExceededDimensions);
  const result = await client.request<StorageCanonicalTerminalTransitionResult>({
    name: "canonical.transitionTerminal",
    input: {
      terminal: { fence: active.fence, ...effectiveTerminal, occurredAt: recordedAt },
      owner: transition.owner,
      finalState: { revision: plan.finalState.revision, stateHash: plan.finalState.stateHash },
      exactReplay: plan.exactReplay,
      revisions: storageCanonicalRevisionPlan(transition.owner, plan),
      budgetPrefix: plan.budgetPrefix
    }
  });
  return result.terminal;
}

function terminalAfterBudgetEnforcement(terminal: DurableCanonicalTerminalInput, exceeded: readonly string[] | undefined): DurableCanonicalTerminalInput {
  if (!exceeded?.length) return terminal;
  if (!(["completed", "blocked", "failed"] as const).includes(terminal.status as "completed" | "blocked" | "failed")) {
    throw new Error("A budget-exceeded terminal plan cannot override pause, interruption, or explicit abort precedence.");
  }
  return {
    ...terminal,
    status: "blocked",
    reason: `Canonical resource budget exceeded: ${[...exceeded].sort().join(", ")}.`
  };
}

function assertActiveOwner(active: ActiveCanonicalTerminalScope, owner: StorageRunOwnership): void {
  if (active.fence.jobId !== owner.jobId || active.job.projectId !== owner.projectId) throw new LeaseLostError(owner.jobId);
}

function assertSameFence(left: ActiveCanonicalTerminalScope, right: ActiveCanonicalTerminalScope, jobId: string): void {
  if (
    left.fence.attempt !== right.fence.attempt ||
    left.fence.leaseGeneration !== right.fence.leaseGeneration ||
    left.fence.leaseOwner !== right.fence.leaseOwner
  ) {
    throw new LeaseLostError(jobId);
  }
}
