import { createHash } from "node:crypto";
import { assertHash, assertUnique } from "./terminalReceiptIntegrity.js";
import { CANONICAL_POLICY_CRITERION, CANONICAL_TRACEABILITY_CRITERION, type StorageTerminalCriterionCandidate } from "./terminalReceiptTypes.js";
import type { StorageTerminalAttestationResolution } from "./terminalAttestationRepository.js";
import { normalizeTerminalClaim } from "./terminalResultReadbackRepository.js";

export function verifyTerminalCriteria(
  candidates: StorageTerminalCriterionCandidate[],
  contractCriteria: ReadonlyArray<{ id: string; description: string; verifierKind: string }>,
  readback: StorageTerminalAttestationResolution
): StorageTerminalCriterionCandidate[] {
  assertUnique(
    candidates.map((candidate) => candidate.criterionId),
    "acceptance criterion"
  );
  if (candidates.length !== contractCriteria.length) throw new Error("Canonical terminal verifier criteria do not cover the immutable task contract.");
  const byId = new Map(candidates.map((candidate) => [candidate.criterionId, candidate]));
  return contractCriteria.map((criterion) => {
    const candidate = byId.get(criterion.id);
    if (!candidate || criterion.verifierKind === "human") {
      throw new Error(`Canonical acceptance criterion is not deterministically verifiable: ${criterion.id}`);
    }
    if (criterion.description === CANONICAL_TRACEABILITY_CRITERION && candidate.verificationKind !== "traceability") criterionMismatch(criterion.id);
    if (criterion.description === CANONICAL_POLICY_CRITERION && candidate.verificationKind !== "policy") criterionMismatch(criterion.id);
    if (
      criterion.description !== CANONICAL_TRACEABILITY_CRITERION &&
      criterion.description !== CANONICAL_POLICY_CRITERION &&
      candidate.verificationKind !== "validation"
    ) {
      criterionMismatch(criterion.id);
    }
    if (candidate.verificationKind !== "validation") return candidate;
    assertHash(candidate.validationResultHash, "acceptance validation result");
    assertUnique(candidate.sourceEvidenceIds, "acceptance evidence source");
    if (!candidate.sourceEvidenceIds.length) throw new Error(`Canonical acceptance criterion has no verified evidence source: ${criterion.id}`);
    const validation = readback.validations.get(candidate.validationResultId);
    if (
      !validation ||
      (!readback.exactReplay && validation.contentHash !== candidate.validationResultHash) ||
      !sameStrings(validation.supportingEvidenceIds, candidate.sourceEvidenceIds) ||
      !validation.supportedClaimHashes.includes(claimHash(criterion.description))
    ) {
      throw new Error(`Canonical acceptance validation does not match persisted readback: ${criterion.id}`);
    }
    return { ...candidate, validationResultHash: validation.contentHash };
  });
}

function criterionMismatch(criterionId: string): never {
  throw new Error(`Canonical terminal verifier kind does not match task criterion ${criterionId}.`);
}

function claimHash(value: string): string {
  return createHash("sha256").update(normalizeTerminalClaim(value), "utf8").digest("hex");
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && [...left].sort().every((value, index) => value === [...right].sort()[index]);
}
