import { commitStep, transitionTerminal } from "./jobAtomicOperations.js";
import type { StorageV2RepositorySet } from "./repositories.js";
import type {
  StorageCanonicalFinalState,
  StorageCanonicalBudgetCommitInput,
  StorageCanonicalRevisionPlanInput,
  StorageCanonicalRevisionPlanResult,
  StorageCanonicalStepCommitInput,
  StorageCanonicalStepCommitResult,
  StorageCanonicalTerminalTransitionInput,
  StorageCanonicalTerminalTransitionResult
} from "./runStateAtomicTypes.js";
import type { StorageCommitRunStateRevisionInput, StorageRunOwnership, StorageRunStateRevision } from "./runStateTypes.js";
import { parseStoredRunStateRevision } from "./runStatePayloadValidator.js";
import {
  assertCanonicalBudgetPlan,
  assertCanonicalCheckpointPlan,
  assertCanonicalResumePlan,
  assertCanonicalTerminalPlan,
  readCanonicalState
} from "./runStateTransitionValidator.js";

const terminalFenceStatuses = ["running", "pause_requested", "cancel_requested", "paused", "aborted", "blocked", "failed", "completed"] as const;
const maximumRevisionPlanLength = 32;

export function commitCanonicalRevisionPlan(
  repositories: StorageV2RepositorySet,
  input: StorageCanonicalRevisionPlanInput
): StorageCanonicalRevisionPlanResult {
  const job = repositories.jobs.assertFence(input.fence, ["running"]);
  const previous = readCanonicalState(repositories, input.owner);
  assertRevisionBatch(input.revisions, input.owner, input.exactReplay, job, maximumRevisionPlanLength);
  assertReplayState(repositories, input.owner, input.finalState, input.exactReplay);
  assertCanonicalResumePlan(previous, input.revisions, input.finalState, job, input.exactReplay);
  const revisions = commitRevisions(repositories, input.revisions);
  return { revisions, finalRevision: assertFinalState(repositories, input.owner, input.finalState) };
}

export function commitCanonicalBudget(repositories: StorageV2RepositorySet, input: StorageCanonicalBudgetCommitInput): StorageCanonicalRevisionPlanResult {
  const job = repositories.jobs.assertFence(input.fence, ["running"]);
  const previous = readCanonicalState(repositories, input.owner);
  assertRevisionBatch(input.revisions, input.owner, input.exactReplay, job, 2);
  assertReplayState(repositories, input.owner, input.finalState, input.exactReplay);
  assertCanonicalBudgetPlan(previous, input);
  const revisions = commitRevisions(repositories, input.revisions);
  return { revisions, finalRevision: assertFinalState(repositories, input.owner, input.finalState) };
}

export function commitCanonicalStep(repositories: StorageV2RepositorySet, input: StorageCanonicalStepCommitInput): StorageCanonicalStepCommitResult {
  const occurredAt = input.step.occurredAt ?? new Date().toISOString();
  const job = repositories.jobs.assertFence(input.step.fence, ["running", "completed"]);
  const previous = readCanonicalState(repositories, input.owner);
  if (job.status === "completed" && !input.exactReplay) throw new Error("Completed jobs reject new canonical checkpoint revisions.");
  assertRevisionBatch(input.revisions, input.owner, input.exactReplay, job, 1);
  assertReplayState(repositories, input.owner, input.finalState, input.exactReplay);
  const step = commitStep(repositories, { ...input.step, occurredAt });
  assertCanonicalCheckpointPlan(previous, input.revisions, input.finalState, step, input.exactReplay);
  const revisions = commitRevisions(repositories, input.revisions);
  assertFinalState(repositories, input.owner, input.finalState);
  return { step, revisions };
}

export function transitionCanonicalTerminal(
  repositories: StorageV2RepositorySet,
  input: StorageCanonicalTerminalTransitionInput
): StorageCanonicalTerminalTransitionResult {
  const occurredAt = input.terminal.occurredAt ?? new Date().toISOString();
  const job = repositories.jobs.assertFence(input.terminal.fence, terminalFenceStatuses);
  const previous = readCanonicalState(repositories, input.owner);
  assertRevisionBatch(input.revisions, input.owner, input.exactReplay, job, 4);
  assertReplayState(repositories, input.owner, input.finalState, input.exactReplay);
  const budgetRevisions = input.revisions.slice(0, input.budgetPrefix.revisionCount);
  const terminalRevisions = input.revisions.slice(input.budgetPrefix.revisionCount);
  const budgetExactReplay = budgetRevisions.length === 0;
  assertCanonicalBudgetPlan(previous, {
    fence: input.terminal.fence,
    owner: input.owner,
    finalState: input.budgetPrefix.finalState,
    exactReplay: budgetExactReplay,
    revisions: budgetRevisions,
    receiptHash: input.budgetPrefix.receiptHash,
    targetUsage: input.budgetPrefix.targetUsage
  });
  const budgetState = budgetExactReplay ? previous : parseStoredBudgetState(budgetRevisions);
  const terminal = transitionTerminal(repositories, { ...input.terminal, occurredAt });
  if (terminal.job.status !== input.terminal.status) throw new Error("Canonical terminal transition lost a control-race precedence check.");
  assertCanonicalTerminalPlan(repositories, budgetState, terminalRevisions, input.finalState, terminal, terminalRevisions.length === 0);
  const revisions = commitRevisions(repositories, input.revisions);
  assertFinalState(repositories, input.owner, input.finalState);
  return { terminal, revisions };
}

function parseStoredBudgetState(revisions: readonly StorageCommitRunStateRevisionInput[]) {
  const revision = revisions.at(-1);
  if (!revision) throw new Error("Canonical terminal budget prefix is missing its final revision.");
  return parseStoredRunStateRevision(revision.revision.data);
}

function assertRevisionBatch(
  revisions: readonly StorageCommitRunStateRevisionInput[],
  owner: StorageRunOwnership,
  exactReplay: boolean,
  job: { id: string; projectId: string },
  maximum: number
): void {
  if (owner.jobId !== job.id || owner.projectId !== job.projectId) throw new Error("Canonical run owner does not match the fenced job.");
  if ((exactReplay && revisions.length !== 0) || (!exactReplay && (revisions.length < 1 || revisions.length > maximum))) {
    throw new Error(`Canonical state commit requires an exact replay or between 1 and ${maximum} revisions.`);
  }
  for (const input of revisions) {
    if (input.revision.jobId !== job.id || input.revision.projectId !== job.projectId || input.revision.runId !== owner.runId) {
      throw new Error("Canonical state revision does not belong to the fenced job.");
    }
  }
}

function assertReplayState(repositories: StorageV2RepositorySet, owner: StorageRunOwnership, expected: StorageCanonicalFinalState, exactReplay: boolean): void {
  if (exactReplay) assertFinalState(repositories, owner, expected);
}

function commitRevisions(repositories: StorageV2RepositorySet, revisions: readonly StorageCommitRunStateRevisionInput[]): StorageRunStateRevision[] {
  return revisions.map((revision) => repositories.runState.commitRevision(revision));
}

function assertFinalState(repositories: StorageV2RepositorySet, owner: StorageRunOwnership, expected: StorageCanonicalFinalState): StorageRunStateRevision {
  const latest = repositories.runState.latestRevision(owner);
  if (!latest || latest.revision !== expected.revision || latest.stateHash !== expected.stateHash) {
    throw new Error("Canonical state batch did not reach its declared final revision and hash.");
  }
  return latest;
}
