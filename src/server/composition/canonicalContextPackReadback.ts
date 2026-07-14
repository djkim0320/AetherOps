import { parseContextPackPersistenceReceipt, type ContextPackPersistenceReceipt } from "../../core/context/public.js";
import { CanonicalRunRuntimeError, type CanonicalRunOwner, type CanonicalRunRuntimeDependencies } from "./canonicalRunTypes.js";

export async function readCanonicalContextPack(
  dependencies: CanonicalRunRuntimeDependencies,
  owner: CanonicalRunOwner,
  predecessorJobId: string,
  contextPackId: string
): Promise<ContextPackPersistenceReceipt> {
  const stored = await dependencies.gateway.getResumeContextPack?.(owner, predecessorJobId, contextPackId);
  if (!stored) throw new CanonicalRunRuntimeError("CANONICAL_RUN_NOT_READY", "Canonical resume ContextPack is missing from durable storage.");
  const pack = parseContextPackPersistenceReceipt(stored, dependencies.hasher);
  if (pack.id !== contextPackId || pack.projectId !== owner.projectId || pack.runId !== owner.runId) {
    throw new CanonicalRunRuntimeError("CANONICAL_RUN_OWNERSHIP_MISMATCH", "Canonical resume ContextPack ownership or identity changed.");
  }
  return pack;
}
