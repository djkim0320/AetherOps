import type { ContextPack } from "../../core/context/public.js";
import type { RunStateRevision } from "../../core/orchestration/runStateCapsule.js";
import type { TaskContract } from "../../core/orchestration/taskContract.js";
import { CanonicalRunRuntimeError, type CompilePlanningContextInput } from "./canonicalRunTypes.js";

export function assertCanonicalContextPack(input: CompilePlanningContextInput, contract: TaskContract, state: RunStateRevision, pack: ContextPack): void {
  if (
    pack.schemaVersion !== 1 ||
    pack.projectId !== input.owner.projectId ||
    pack.runId !== input.owner.runId ||
    pack.stateRevision !== state.revision ||
    pack.task.id !== contract.id ||
    pack.task.contentHash !== contract.contentHash
  ) {
    mismatch("Compiled ContextPack identity does not match its canonical task and run state.");
  }
  if (pack.budget.usedTokens > pack.budget.tokenBudget || pack.budget.usedChars > pack.budget.maxChars) {
    mismatch("Compiled ContextPack exceeded its recorded budget.");
  }
}

export function assertCanonicalContextPackReadback(value: unknown, expected: ContextPack): void {
  if (!value || typeof value !== "object") mismatch("ContextPack readback is missing.");
  const pack = value as Partial<ContextPack>;
  if (
    pack.id !== expected.id ||
    pack.canonicalHash !== expected.canonicalHash ||
    pack.runId !== expected.runId ||
    pack.projectId !== expected.projectId ||
    pack.stateRevision !== expected.stateRevision ||
    pack.finalInputHash !== expected.finalInputHash
  ) {
    mismatch("ContextPack readback changed identity, ownership, revision, or hash.");
  }
}

function mismatch(message: string): never {
  throw new CanonicalRunRuntimeError("CANONICAL_READBACK_MISMATCH", message);
}
