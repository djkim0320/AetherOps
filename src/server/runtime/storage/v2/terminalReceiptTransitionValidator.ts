import type { RunStateRevision } from "../../../../core/orchestration/runStateCapsule.js";
import { assertToolAttemptOutputPromotionAllowed } from "./toolPostcondition.js";
import { terminalAttemptSourceReceiptIds, terminalCheckpointOutputHash, terminalPolicyOutputHash } from "./terminalReceiptIntegrity.js";
import { CANONICAL_POLICY_CRITERION, CANONICAL_TRACEABILITY_CRITERION, type StorageCanonicalTerminalVerifierReceipt } from "./terminalReceiptTypes.js";
import { parseStoredTaskContract, storageCanonicalHasher } from "./runStatePayloadValidator.js";
import type { StorageTerminalTransitionResult } from "./jobAtomicTypes.js";
import type { StorageV2RepositorySet } from "./repositories.js";
import type { StorageTerminalResultAttestation } from "./terminalAttestationTypes.js";
import { normalizeTerminalClaim } from "./terminalResultReadbackRepository.js";
import type { StorageToolAttempt } from "./traceTypes.js";
import { createHash } from "node:crypto";
import { readCompleteTerminalCapabilityAudits, readCompleteTerminalLlmInvocations, readCompleteTerminalToolAttempts } from "./terminalBoundedReadback.js";

export function assertAuthoritativeTerminalReceipts(
  repositories: StorageV2RepositorySet,
  previous: RunStateRevision,
  final: RunStateRevision,
  terminal: StorageTerminalTransitionResult
): void {
  if (readCompleteTerminalLlmInvocations(repositories, terminal.job.id, "transition").some((invocation) => invocation.status === "running")) {
    throw new Error("Canonical terminal transition rejects dangling running LLM invocations.");
  }
  const nodeReceipt = final.completedNodeReceipts.at(-1);
  const terminalReceipt = final.terminalReceipt;
  const checkpoint = terminal.stepDisposition?.checkpoint;
  if (!nodeReceipt || terminalReceipt?.outcome !== "completed" || !checkpoint) {
    throw new Error("Canonical completion lacks receipt-bearing node, run, or checkpoint state.");
  }
  const ids = nodeReceipt.verifierReceiptIds;
  const receipts = repositories.terminalReceipts.listByIds(ids);
  if (receipts.length !== ids.length || new Set(ids).size !== ids.length)
    throw new Error("Canonical completion references missing or duplicate verifier receipts.");
  const requestHashes = new Set(receipts.map((receipt) => receipt.requestHash));
  if (requestHashes.size !== 1 || receipts.some((receipt) => !sameOwner(receipt, final, terminal.job.id))) {
    throw new Error("Canonical terminal verifier receipts cross an immutable batch or owner boundary.");
  }
  const requestHash = receipts[0]?.requestHash;
  if (!requestHash || !sameIds(repositories.terminalReceipts.listByRequest(terminal.job.id, requestHash), receipts)) {
    throw new Error("Canonical terminal completion omitted a receipt from its immutable verification batch.");
  }
  const contractRow = repositories.runState.getTaskContract(final.projectId, final.taskContractId);
  if (!contractRow || contractRow.contentHash !== final.taskContractHash) throw new Error("Canonical terminal task-contract readback is missing.");
  const contract = parseStoredTaskContract(contractRow.data);
  const traceCriterion = requiredCriterion(contract.acceptanceCriteria, CANONICAL_TRACEABILITY_CRITERION);
  const policyCriterion = requiredCriterion(contract.acceptanceCriteria, CANONICAL_POLICY_CRITERION);
  const checkpointReceipt = only(receipts, (receipt) => receipt.receiptKind === "checkpoint", "checkpoint verifier receipt");
  const policyReceipt = only(receipts, (receipt) => receipt.receiptKind === "policy", "policy verifier receipt");
  const attestations = repositories.terminalAttestations.listByJob(terminal.job.id);
  const resourceReceiptCount = receipts.filter((receipt) => receipt.receiptKind === "artifact" || receipt.receiptKind === "evidence").length;
  const requiresAttestations = nodeReceipt.artifactRefs.length + nodeReceipt.evidenceRefs.length + terminal.links.length + resourceReceiptCount > 0;
  if (
    (requiresAttestations && !attestations.length) ||
    (attestations.length > 0 &&
      (new Set(attestations.map((value) => value.batchHash)).size !== 1 ||
        attestations.some((value) => value.projectId !== final.projectId || value.runId !== final.runId || value.jobId !== terminal.job.id)))
  ) {
    throw new Error("Canonical completion requires one immutable terminal attestation batch.");
  }
  repositories.terminalAttestations.assertCas(attestations);
  const byAttestationId = new Map(attestations.map((value) => [value.id, value]));
  assertCompleteAttestationReferences(nodeReceipt, receipts, attestations);
  assertCheckpointReceipt(repositories, previous, terminal, checkpointReceipt, traceCriterion.id);
  assertPolicyReceipt(repositories, terminal, policyReceipt, policyCriterion.id, contract.contentHash);
  const resourceReceipts = assertResourceReceipts(repositories, terminal, nodeReceipt, receipts, traceCriterion.id, byAttestationId);
  assertAcceptanceReceipts(
    contract.acceptanceCriteria,
    terminalReceipt.acceptanceReceiptIds,
    receipts,
    checkpointReceipt,
    policyReceipt,
    resourceReceipts,
    byAttestationId
  );
}

function assertCompleteAttestationReferences(
  nodeReceipt: RunStateRevision["completedNodeReceipts"][number],
  receipts: StorageCanonicalTerminalVerifierReceipt[],
  attestations: StorageTerminalResultAttestation[]
): void {
  const known = new Set(attestations.map((value) => value.id));
  const referenced = new Set([
    ...nodeReceipt.artifactRefs.flatMap((value) => (value.attestationId ? [value.attestationId] : [])),
    ...nodeReceipt.evidenceRefs.flatMap((value) => (value.attestationId ? [value.attestationId] : [])),
    ...receipts.flatMap((receipt) => [receipt.subjectId, ...receipt.sourceReceiptIds]).filter((id) => known.has(id))
  ]);
  if (!equalStrings([...known], [...referenced])) {
    throw new Error("Canonical completion omitted an immutable terminal attestation from its batch.");
  }
}

function assertCheckpointReceipt(
  repositories: StorageV2RepositorySet,
  previous: RunStateRevision,
  terminal: StorageTerminalTransitionResult,
  receipt: StorageCanonicalTerminalVerifierReceipt,
  criterionId: string
): void {
  const checkpoint = terminal.stepDisposition!.checkpoint;
  const attempts = readCompleteTerminalToolAttempts(repositories, terminal.job.id, "transition");
  const sources = completedAttemptSources(attempts);
  if (
    receipt.criterionId !== criterionId ||
    receipt.subjectKind !== "step_checkpoint" ||
    receipt.subjectId !== checkpoint.id ||
    !matchesCanonicalStateHash(repositories, previous, receipt) ||
    receipt.outputHash !==
      terminalCheckpointOutputHash({
        step: checkpoint.step,
        checkpointData: checkpoint.data,
        ...(checkpoint.outputRef ? { outputRef: checkpoint.outputRef } : {})
      }) ||
    !equalStrings(receipt.sourceReceiptIds, sources)
  ) {
    throw new Error("Canonical checkpoint verifier receipt does not match committed checkpoint readback.");
  }
}

function matchesCanonicalStateHash(
  repositories: StorageV2RepositorySet,
  previous: RunStateRevision,
  receipt: StorageCanonicalTerminalVerifierReceipt
): boolean {
  if (receipt.subjectHash === previous.stateHash) return true;
  return repositories.runState
    .listRevisions({ projectId: receipt.projectId, runId: receipt.runId, jobId: receipt.jobId }, -1, 1_000)
    .some((revision) => revision.stateHash === receipt.subjectHash);
}

function assertPolicyReceipt(
  repositories: StorageV2RepositorySet,
  terminal: StorageTerminalTransitionResult,
  receipt: StorageCanonicalTerminalVerifierReceipt,
  criterionId: string,
  taskContractHash: string
): void {
  const sources = [terminal.job.id, ...readCompleteTerminalCapabilityAudits(repositories, terminal.job.id, "transition").map((audit) => audit.id)].sort();
  if (
    receipt.criterionId !== criterionId ||
    receipt.subjectKind !== "immutable_job_policy" ||
    receipt.subjectId !== terminal.job.id ||
    receipt.subjectHash !== taskContractHash ||
    receipt.outputHash !== terminalPolicyOutputHash(terminal.job) ||
    !equalStrings(receipt.sourceReceiptIds, sources)
  ) {
    throw new Error("Canonical policy verifier receipt does not match persisted job policy and audits.");
  }
}

function assertResourceReceipts(
  repositories: StorageV2RepositorySet,
  terminal: StorageTerminalTransitionResult,
  nodeReceipt: RunStateRevision["completedNodeReceipts"][number],
  receipts: StorageCanonicalTerminalVerifierReceipt[],
  criterionId: string,
  attestations: Map<string, StorageTerminalResultAttestation>
): StorageCanonicalTerminalVerifierReceipt[] {
  const resourceReceipts = receipts.filter((receipt) => receipt.receiptKind === "artifact" || receipt.receiptKind === "evidence");
  if (resourceReceipts.length !== terminal.links.length) throw new Error("Canonical resource verifier receipt count does not match promoted output readback.");
  for (const link of terminal.links) {
    const attempt = repositories.trace.getToolAttempt(link.attemptId);
    if (!attempt || attempt.status !== "completed" || !attempt.outputHash)
      throw new Error(`Canonical resource origin attempt is unavailable: ${link.outputId}`);
    assertToolAttemptOutputPromotionAllowed(attempt);
    const artifactReference = link.outputKind === "artifact" ? nodeReceipt.artifactRefs.find((item) => item.artifactId === link.outputId) : undefined;
    const evidenceReference = link.outputKind === "evidence" ? nodeReceipt.evidenceRefs.find((item) => item.evidenceId === link.outputId) : undefined;
    const reference = artifactReference ?? evidenceReference;
    const attestation = reference?.attestationId ? attestations.get(reference.attestationId) : undefined;
    const receipt = only(resourceReceipts, (item) => item.receiptKind === link.outputKind && item.subjectId === attestation?.id, `resource ${link.outputId}`);
    const receiptId = artifactReference?.promotionReceiptId ?? evidenceReference?.verificationReceiptId;
    const baseSources = terminalAttemptSourceReceiptIds(attempt, link.id);
    const validation = attestation?.validationAttestationId ? attestations.get(attestation.validationAttestationId) : undefined;
    const expectedSources = [...baseSources, ...(attestation ? [attestation.id] : []), ...(validation ? [validation.id] : [])].sort();
    const expectedOutputHash =
      link.outputKind === "artifact"
        ? storageCanonicalHasher.sha256Canonical({
            originOutputHash: attempt.outputHash,
            contentHash: attestation?.contentHash,
            attestationHash: attestation?.attestationHash
          })
        : storageCanonicalHasher.sha256Canonical({
            originOutputHash: attempt.outputHash,
            contentHash: attestation?.contentHash,
            attestationHash: attestation?.attestationHash,
            validationAttestationHash: validation?.attestationHash
          });
    if (
      !reference ||
      !attestation ||
      receiptId !== receipt.id ||
      receipt.criterionId !== criterionId ||
      receipt.subjectKind !== `${link.outputKind}_attestation` ||
      receipt.subjectHash !== attestation.attestationHash ||
      reference.attestationHash !== attestation.attestationHash ||
      reference.contentHash !== attestation.contentHash ||
      attestation.subjectKind !== link.outputKind ||
      attestation.subjectId !== link.outputId ||
      attestation.attemptId !== attempt.id ||
      attestation.outputLinkId !== link.id ||
      (receipt.receiptKind === "evidence" &&
        (!validation ||
          (!validation.supportingEvidenceIds.includes(link.outputId) && !validation.contradictingEvidenceIds.includes(link.outputId)) ||
          validation.subjectKind !== "validation_result")) ||
      receipt.outputHash !== expectedOutputHash ||
      !equalStrings(receipt.sourceReceiptIds, expectedSources)
    ) {
      throw new Error(`Canonical resource verifier receipt does not match promotion readback: ${link.outputId}`);
    }
  }
  return resourceReceipts;
}

function assertAcceptanceReceipts(
  criteria: ReadonlyArray<{ id: string; description: string }>,
  acceptanceIds: readonly string[],
  receipts: StorageCanonicalTerminalVerifierReceipt[],
  checkpoint: StorageCanonicalTerminalVerifierReceipt,
  policy: StorageCanonicalTerminalVerifierReceipt,
  resources: StorageCanonicalTerminalVerifierReceipt[],
  attestations: Map<string, StorageTerminalResultAttestation>
): void {
  const acceptance = receipts.filter((receipt) => receipt.receiptKind === "acceptance");
  if (
    acceptance.length !== criteria.length ||
    !equalStrings(
      acceptanceIds,
      acceptance.map((receipt) => receipt.id)
    )
  ) {
    throw new Error("Canonical acceptance receipt set does not match the immutable task contract.");
  }
  const evidenceIds = new Set(resources.filter((receipt) => receipt.receiptKind === "evidence").map((receipt) => receipt.id));
  for (const criterion of criteria) {
    const receipt = only(acceptance, (item) => item.criterionId === criterion.id, `acceptance criterion ${criterion.id}`);
    const expectedSources =
      criterion.description === CANONICAL_TRACEABILITY_CRITERION
        ? [checkpoint.id, ...resources.map((resource) => resource.id)].sort()
        : criterion.description === CANONICAL_POLICY_CRITERION
          ? [policy.id]
          : receipt.sourceReceiptIds;
    const baseIdentityMatches =
      criterion.description === CANONICAL_TRACEABILITY_CRITERION
        ? receipt.subjectKind === "acceptance_criterion" && receipt.subjectId === checkpoint.subjectId && receipt.subjectHash === checkpoint.receiptHash
        : criterion.description === CANONICAL_POLICY_CRITERION
          ? receipt.subjectKind === "acceptance_criterion" && receipt.subjectId === policy.subjectId && receipt.subjectHash === policy.receiptHash
          : true;
    const validation = receipt.subjectKind === "validation_attestation" ? attestations.get(receipt.subjectId) : undefined;
    const sourceEvidenceIds = receipt.sourceReceiptIds
      .map((id) => resources.find((resource) => resource.id === id))
      .filter((resource): resource is StorageCanonicalTerminalVerifierReceipt => resource?.receiptKind === "evidence")
      .map((resource) => attestations.get(resource.subjectId)?.subjectId)
      .filter((id): id is string => Boolean(id))
      .sort();
    if (
      !expectedSources.length ||
      !baseIdentityMatches ||
      !equalStrings(receipt.sourceReceiptIds, expectedSources) ||
      receipt.outputHash !== sourceReceiptOutputHash(expectedSources, receipts) ||
      (criterion.description !== CANONICAL_TRACEABILITY_CRITERION &&
        criterion.description !== CANONICAL_POLICY_CRITERION &&
        (receipt.subjectKind !== "validation_attestation" ||
          receipt.sourceReceiptIds.some((id) => !evidenceIds.has(id)) ||
          !validation ||
          validation.attestationHash !== receipt.subjectHash ||
          !equalStrings(validation.supportingEvidenceIds, sourceEvidenceIds) ||
          !validation.supportedClaimHashes.includes(terminalClaimHash(criterion.description))))
    ) {
      throw new Error(`Canonical acceptance receipt is not backed by authoritative source receipts: ${criterion.id}`);
    }
  }
}

function sourceReceiptOutputHash(sourceIds: readonly string[], receipts: StorageCanonicalTerminalVerifierReceipt[]): string {
  const byId = new Map(receipts.map((receipt) => [receipt.id, receipt.receiptHash]));
  const hashes = sourceIds.map((id) => byId.get(id));
  if (hashes.some((hash) => !hash)) throw new Error("Canonical acceptance references a source outside its verifier batch.");
  return storageCanonicalHasher.sha256Canonical((hashes as string[]).sort());
}

function terminalClaimHash(value: string): string {
  return createHash("sha256").update(normalizeTerminalClaim(value), "utf8").digest("hex");
}

function completedAttemptSources(attempts: StorageToolAttempt[]): string[] {
  return attempts
    .filter((attempt) => attempt.status === "completed")
    .flatMap((attempt) => [attempt.id, ...(attempt.postconditionReceipt ? [attempt.postconditionReceipt.receiptId] : [])])
    .sort();
}

function only(
  receipts: StorageCanonicalTerminalVerifierReceipt[],
  predicate: (receipt: StorageCanonicalTerminalVerifierReceipt) => boolean,
  label: string
): StorageCanonicalTerminalVerifierReceipt {
  const matches = receipts.filter(predicate);
  if (matches.length !== 1) throw new Error(`Canonical completion requires exactly one ${label}.`);
  return matches[0]!;
}

function requiredCriterion(criteria: ReadonlyArray<{ id: string; description: string }>, description: string): { id: string } {
  const matches = criteria.filter((criterion) => criterion.description === description);
  if (matches.length !== 1) throw new Error("Canonical terminal task contract lacks one required system criterion.");
  return matches[0]!;
}

function sameOwner(receipt: StorageCanonicalTerminalVerifierReceipt, state: RunStateRevision, jobId: string): boolean {
  return receipt.projectId === state.projectId && receipt.runId === state.runId && receipt.jobId === jobId;
}

function sameIds(left: StorageCanonicalTerminalVerifierReceipt[], right: StorageCanonicalTerminalVerifierReceipt[]): boolean {
  return equalStrings(
    left.map((receipt) => receipt.id),
    right.map((receipt) => receipt.id)
  );
}

function equalStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && [...left].sort().every((value, index) => value === [...right].sort()[index]);
}
