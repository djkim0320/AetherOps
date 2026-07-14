import { randomUUID } from "node:crypto";
import { assertToolAttemptOutputPromotionAllowed } from "./toolPostcondition.js";
import {
  assertHash,
  assertUnique,
  terminalAttemptSourceReceiptIds,
  terminalCheckpointOutputHash,
  terminalPolicyOutputHash,
  terminalReceiptHash
} from "./terminalReceiptIntegrity.js";
import {
  type StorageCanonicalTerminalVerifierReceipt,
  type StorageCanonicalTerminalVerifyInput,
  type StorageCanonicalTerminalVerifyResult,
  type StorageTerminalCriterionCandidate,
  type StorageTerminalResourceCandidate
} from "./terminalReceiptTypes.js";
import { storageStepCheckpointId } from "./jobAtomicOperations.js";
import { parseStoredTaskContract, storageCanonicalHasher } from "./runStatePayloadValidator.js";
import type { StorageV2RepositorySet } from "./repositories.js";
import type { StorageTerminalAttestationResolution } from "./terminalAttestationRepository.js";
import type { StorageTerminalResultAttestation } from "./terminalAttestationTypes.js";
import type { StorageJob } from "./types.js";
import type { StorageToolAttempt, StorageToolOutputLink } from "./traceTypes.js";
import { assertTerminalResourceOrigins } from "./terminalReceiptOriginValidator.js";
import { verifyTerminalCriteria } from "./terminalAcceptanceValidator.js";
import {
  readCompleteTerminalCapabilityAudits,
  readCompleteTerminalLlmInvocations,
  readCompleteTerminalOutputLinks,
  readCompleteTerminalToolAttempts
} from "./terminalBoundedReadback.js";

interface VerifiedResource extends StorageTerminalResourceCandidate {
  attempt: StorageToolAttempt;
  link: StorageToolOutputLink;
  outputHash: string;
  sourceReceiptIds: string[];
  attestation: StorageTerminalResultAttestation;
  validationAttestation?: StorageTerminalResultAttestation;
}

interface VerificationFacts {
  job: StorageJob;
  checkpointOutputHash: string;
  checkpointSourceIds: string[];
  policyOutputHash: string;
  policySourceIds: string[];
  resources: VerifiedResource[];
  criteria: StorageTerminalCriterionCandidate[];
  traceabilityCriterionId: string;
  policyCriterionId: string;
  taskContractHash: string;
  stateHash: string;
  attestations: StorageTerminalAttestationResolution;
}

export function verifyCanonicalTerminal(
  repositories: StorageV2RepositorySet,
  input: StorageCanonicalTerminalVerifyInput
): StorageCanonicalTerminalVerifyResult {
  const facts = verifyPersistedFacts(repositories, input);
  const requestHash = verificationRequestHash(input, facts);
  const existing = repositories.terminalReceipts.listByRequest(input.owner.jobId, requestHash);
  const expectedCount = 2 + facts.resources.length + facts.criteria.length;
  if (existing.length) {
    if (existing.length !== expectedCount) throw new Error("Canonical terminal verifier replay has an incomplete immutable receipt batch.");
    return {
      requestHash,
      receipts: existing,
      attestationBatchHash: facts.attestations.batchHash,
      attestations: facts.attestations.attestations,
      exactReplay: true
    };
  }
  const receipts = issueReceipts(input, requestHash, facts);
  for (const receipt of receipts) repositories.terminalReceipts.save(receipt);
  const readback = repositories.terminalReceipts.listByRequest(input.owner.jobId, requestHash);
  if (readback.length !== receipts.length || readback.some((receipt, index) => receipt.receiptHash !== sortReceipts(receipts)[index]?.receiptHash)) {
    throw new Error("Canonical terminal verifier receipt readback changed after issuance.");
  }
  return {
    requestHash,
    receipts: readback,
    attestationBatchHash: facts.attestations.batchHash,
    attestations: facts.attestations.attestations,
    exactReplay: false
  };
}

function verifyPersistedFacts(repositories: StorageV2RepositorySet, input: StorageCanonicalTerminalVerifyInput): VerificationFacts {
  assertVerifyInput(input);
  const job = repositories.jobs.assertFence(input.fence, ["running"]);
  if (job.id !== input.owner.jobId || job.projectId !== input.owner.projectId)
    throw new Error("Canonical terminal verifier owner does not match the fenced job.");
  const state = repositories.runState.latestRevision(input.owner);
  if (!state) throw new Error("Canonical terminal verifier requires a persisted run-state readback.");
  const storedContract = repositories.runState.getTaskContract(input.owner.projectId, state.taskContractId);
  if (!storedContract || storedContract.contentHash !== state.taskContractHash)
    throw new Error("Canonical terminal verifier task-contract readback is missing.");
  const contract = parseStoredTaskContract(storedContract.data);
  const expectedCheckpointId = storageStepCheckpointId(input.fence, input.completedStep.step);
  if (input.checkpointId !== expectedCheckpointId) throw new Error("Canonical terminal verifier checkpoint identity is not worker-derived.");
  const attempts = readCompleteTerminalToolAttempts(repositories, job.id, "verifier");
  if (attempts.some((attempt) => attempt.status === "queued" || attempt.status === "running")) {
    throw new Error("Canonical terminal verifier rejects dangling non-terminal tool attempts.");
  }
  if (readCompleteTerminalLlmInvocations(repositories, job.id, "verifier").some((invocation) => invocation.status === "running")) {
    throw new Error("Canonical terminal verifier rejects dangling running LLM invocations.");
  }
  const expectedStep = {
    step: input.completedStep.step,
    checkpointData: {
      phase: "execute_tools_completed",
      attempts: attempts
        .filter((attempt) => attempt.status === "completed")
        .sort((left, right) => left.ordinal - right.ordinal || left.id.localeCompare(right.id))
        .map((attempt) => ({ id: attempt.id, inputHash: attempt.inputHash, outputHash: attempt.outputHash }))
    }
  };
  if (storageCanonicalHasher.sha256Canonical(input.completedStep) !== storageCanonicalHasher.sha256Canonical(expectedStep)) {
    throw new Error("Canonical terminal verifier completed-step input does not match persisted tool-attempt readback.");
  }
  assertTerminalResourceOrigins(repositories, job, attempts, input.resources);
  const requiresAttestation = input.resources.length > 0 || input.criteria.some((criterion) => criterion.verificationKind === "validation");
  if (requiresAttestation && !repositories.terminalAttestations.listByJob(job.id).length && repositories.terminalReceipts.listByJob(job.id).length) {
    throw new Error("Canonical terminal v8 verifier receipts cannot be replayed without an immutable attestation; replan is required.");
  }
  const attestations = repositories.terminalAttestations.resolveOrCreate({
    owner: input.owner,
    resources: input.resources,
    criteria: input.criteria,
    attestedAt: input.verifiedAt
  });
  const criteria = verifyTerminalCriteria(input.criteria, contract.acceptanceCriteria, attestations);
  const resources = verifyResources(repositories, job, attempts, input.resources, attestations);
  const audits = readCompleteTerminalCapabilityAudits(repositories, job.id, "verifier");
  if (audits.some((audit) => audit.projectId !== job.projectId || audit.jobId !== job.id))
    throw new Error("Canonical terminal capability audit scope changed.");
  const traceabilityCriterion = criteria.find((criterion) => criterion.verificationKind === "traceability");
  const policyCriterion = criteria.find((criterion) => criterion.verificationKind === "policy");
  if (!traceabilityCriterion || !policyCriterion) throw new Error("Canonical terminal verifier requires traceability and policy criteria.");
  return {
    job,
    checkpointOutputHash: terminalCheckpointOutputHash(input.completedStep),
    checkpointSourceIds: completedAttemptSources(attempts),
    policyOutputHash: terminalPolicyOutputHash(job),
    policySourceIds: [job.id, ...audits.map((audit) => audit.id)].sort(),
    resources,
    criteria,
    traceabilityCriterionId: traceabilityCriterion.criterionId,
    policyCriterionId: policyCriterion.criterionId,
    taskContractHash: contract.contentHash,
    stateHash: state.stateHash,
    attestations
  };
}

function verifyResources(
  repositories: StorageV2RepositorySet,
  job: StorageJob,
  attempts: StorageToolAttempt[],
  candidates: StorageTerminalResourceCandidate[],
  readback: StorageTerminalAttestationResolution
): VerifiedResource[] {
  assertUnique(
    candidates.map((candidate) => candidate.outputLinkId),
    "terminal resource output link"
  );
  assertUnique(
    candidates.map((candidate) => `${candidate.outputKind}\u0000${candidate.outputId}`),
    "terminal resource"
  );
  const completed = new Map(attempts.filter((attempt) => attempt.status === "completed").map((attempt) => [attempt.id, attempt]));
  const persistedLinks = readCompleteTerminalOutputLinks(repositories, [...completed.keys()], "verifier")
    .filter((link) => link.outputKind !== "source")
    .sort(compareLinks);
  const verified = candidates
    .map((candidate) => {
      assertHash(candidate.contentHash, "terminal resource content");
      if (candidate.validationResultHash) assertHash(candidate.validationResultHash, "terminal validation result");
      const attempt = completed.get(candidate.attemptId);
      const link = persistedLinks.find((entry) => entry.id === candidate.outputLinkId);
      if (!attempt || !attempt.outputHash || !link || link.promoted)
        throw new Error(`Canonical terminal resource lacks an unpromoted persisted origin: ${candidate.outputId}`);
      assertHash(attempt.outputHash, "terminal attempt output");
      if (
        link.jobId !== job.id ||
        link.projectId !== job.projectId ||
        link.attemptId !== attempt.id ||
        link.outputKind !== candidate.outputKind ||
        link.outputId !== candidate.outputId
      ) {
        throw new Error(`Canonical terminal resource origin linkage is invalid: ${candidate.outputId}`);
      }
      assertToolAttemptOutputPromotionAllowed(attempt);
      if (candidate.outputKind === "evidence" && (!candidate.validationResultId || !candidate.validationResultHash)) {
        throw new Error(`Canonical evidence ${candidate.outputId} requires a hash-bound validation result.`);
      }
      const authoritativeResource =
        candidate.outputKind === "artifact" ? readback.artifacts.get(candidate.outputId) : readback.evidence.get(candidate.outputId);
      if (!authoritativeResource || (!readback.exactReplay && authoritativeResource.contentHash !== candidate.contentHash)) {
        throw new Error(`Canonical terminal resource hash does not match persisted readback: ${candidate.outputId}`);
      }
      if (candidate.outputKind === "evidence") {
        const validation = readback.validations.get(candidate.validationResultId!);
        if (
          !validation ||
          (!readback.exactReplay && validation.contentHash !== candidate.validationResultHash) ||
          (!validation.supportingEvidenceIds.includes(candidate.outputId) && !validation.contradictingEvidenceIds.includes(candidate.outputId))
        ) {
          throw new Error(`Canonical evidence validation does not match persisted readback: ${candidate.outputId}`);
        }
      }
      const validationAttestation = candidate.validationResultId ? readback.validations.get(candidate.validationResultId) : undefined;
      const sourceReceiptIds = terminalAttemptSourceReceiptIds(attempt, link.id);
      const outputHash =
        candidate.outputKind === "evidence"
          ? storageCanonicalHasher.sha256Canonical({
              originOutputHash: attempt.outputHash,
              contentHash: authoritativeResource.contentHash,
              attestationHash: authoritativeResource.attestationHash,
              validationAttestationHash: validationAttestation!.attestationHash
            })
          : storageCanonicalHasher.sha256Canonical({
              originOutputHash: attempt.outputHash,
              contentHash: authoritativeResource.contentHash,
              attestationHash: authoritativeResource.attestationHash
            });
      return {
        ...candidate,
        contentHash: authoritativeResource.contentHash,
        ...(validationAttestation ? { validationResultHash: validationAttestation.contentHash } : {}),
        attempt,
        link,
        outputHash,
        attestation: authoritativeResource,
        ...(validationAttestation ? { validationAttestation } : {}),
        sourceReceiptIds: [...sourceReceiptIds, authoritativeResource.id, ...(validationAttestation ? [validationAttestation.id] : [])].sort()
      };
    })
    .sort((left, right) => compareLinks(left.link, right.link));
  if (persistedLinks.length !== verified.length || persistedLinks.some((link, index) => link.id !== verified[index]?.link.id)) {
    throw new Error("Canonical terminal verifier resource candidates do not cover every promotable persisted output.");
  }
  return verified;
}

function issueReceipts(input: StorageCanonicalTerminalVerifyInput, requestHash: string, facts: VerificationFacts): StorageCanonicalTerminalVerifierReceipt[] {
  const checkpoint = receipt(input, requestHash, {
    receiptKind: "checkpoint",
    criterionId: facts.traceabilityCriterionId,
    subjectKind: "step_checkpoint",
    subjectId: input.checkpointId,
    subjectHash: facts.stateHash,
    outputHash: facts.checkpointOutputHash,
    sourceReceiptIds: facts.checkpointSourceIds
  });
  const policy = receipt(input, requestHash, {
    receiptKind: "policy",
    criterionId: facts.policyCriterionId,
    subjectKind: "immutable_job_policy",
    subjectId: input.owner.jobId,
    subjectHash: facts.taskContractHash,
    outputHash: facts.policyOutputHash,
    sourceReceiptIds: facts.policySourceIds
  });
  const resources = facts.resources.map((resource) =>
    receipt(input, requestHash, {
      receiptKind: resource.outputKind,
      criterionId: facts.traceabilityCriterionId,
      subjectKind: `${resource.outputKind}_attestation`,
      subjectId: resource.attestation.id,
      subjectHash: resource.attestation.attestationHash,
      outputHash: resource.outputHash,
      sourceReceiptIds: resource.sourceReceiptIds
    })
  );
  const resourceByEvidence = new Map(
    facts.resources.map((resource, index) => [resource.outputId, resources[index]!] as const).filter(([, receipt]) => receipt.receiptKind === "evidence")
  );
  const acceptance = facts.criteria.map((criterion) => {
    const sources = acceptanceSources(criterion, checkpoint, policy, resources, resourceByEvidence);
    const validation = criterion.verificationKind === "validation" ? facts.attestations.validations.get(criterion.validationResultId) : undefined;
    if (criterion.verificationKind === "validation" && !validation) {
      throw new Error(`Canonical acceptance validation attestation is missing: ${criterion.criterionId}`);
    }
    const subjectHash = validation?.attestationHash ?? sources[0]!.receiptHash;
    const subjectId = validation?.id ?? sources[0]!.subjectId;
    return receipt(input, requestHash, {
      receiptKind: "acceptance",
      criterionId: criterion.criterionId,
      subjectKind: criterion.verificationKind === "validation" ? "validation_attestation" : "acceptance_criterion",
      subjectId,
      subjectHash,
      outputHash: storageCanonicalHasher.sha256Canonical(sources.map((source) => source.receiptHash).sort()),
      sourceReceiptIds: sources.map((source) => source.id).sort()
    });
  });
  return sortReceipts([checkpoint, policy, ...resources, ...acceptance]);
}

function acceptanceSources(
  criterion: StorageTerminalCriterionCandidate,
  checkpoint: StorageCanonicalTerminalVerifierReceipt,
  policy: StorageCanonicalTerminalVerifierReceipt,
  resources: StorageCanonicalTerminalVerifierReceipt[],
  evidence: Map<string, StorageCanonicalTerminalVerifierReceipt>
): StorageCanonicalTerminalVerifierReceipt[] {
  if (criterion.verificationKind === "traceability") return [checkpoint, ...resources];
  if (criterion.verificationKind === "policy") return [policy];
  const sources = criterion.sourceEvidenceIds.map((id) => evidence.get(id));
  if (sources.some((source) => !source)) throw new Error(`Canonical acceptance validation references unpromoted evidence: ${criterion.criterionId}`);
  return sources as StorageCanonicalTerminalVerifierReceipt[];
}

function receipt(
  input: StorageCanonicalTerminalVerifyInput,
  requestHash: string,
  fields: Omit<
    StorageCanonicalTerminalVerifierReceipt,
    "id" | "projectId" | "runId" | "jobId" | "requestHash" | "verifierVersion" | "verifiedAt" | "receiptHash"
  >
): StorageCanonicalTerminalVerifierReceipt {
  const withoutHash = {
    id: `terminal-receipt:${randomUUID()}`,
    projectId: input.owner.projectId,
    runId: input.owner.runId,
    jobId: input.owner.jobId,
    requestHash,
    ...fields,
    sourceReceiptIds: [...new Set(fields.sourceReceiptIds)].sort(),
    verifierVersion: "storage-worker-terminal-verifier-v1" as const,
    verifiedAt: input.verifiedAt
  };
  return { ...withoutHash, receiptHash: terminalReceiptHash(withoutHash) };
}

function verificationRequestHash(input: StorageCanonicalTerminalVerifyInput, facts: VerificationFacts): string {
  return storageCanonicalHasher.sha256Canonical({
    schema: "aetherops.canonical-terminal-verification.v1",
    owner: input.owner,
    checkpointId: input.checkpointId,
    checkpointOutputHash: facts.checkpointOutputHash,
    checkpointSourceIds: facts.checkpointSourceIds,
    policyOutputHash: facts.policyOutputHash,
    policySourceIds: facts.policySourceIds,
    taskContractHash: facts.taskContractHash,
    stateHash: facts.stateHash,
    attestationBatchHash: facts.attestations.batchHash,
    resources: facts.resources.map(
      ({ outputKind, outputId, outputLinkId, attemptId, contentHash, validationResultId, validationResultHash, outputHash, attestation }) => ({
        outputKind,
        outputId,
        outputLinkId,
        attemptId,
        contentHash,
        validationResultId: validationResultId ?? null,
        validationResultHash: validationResultHash ?? null,
        outputHash,
        attestationId: attestation.id,
        attestationHash: attestation.attestationHash
      })
    ),
    criteria: facts.criteria
  });
}

function completedAttemptSources(attempts: StorageToolAttempt[]): string[] {
  return attempts
    .filter((attempt) => attempt.status === "completed")
    .flatMap((attempt) => [attempt.id, ...(attempt.postconditionReceipt ? [attempt.postconditionReceipt.receiptId] : [])])
    .sort();
}

function assertVerifyInput(input: StorageCanonicalTerminalVerifyInput): void {
  if (!Number.isFinite(Date.parse(input.verifiedAt))) throw new Error("Canonical terminal verifier timestamp is invalid.");
  if (input.resources.length > 128 || input.criteria.length > 64) throw new Error("Canonical terminal verifier input exceeds bounded limits.");
  for (const value of [input.owner.projectId, input.owner.runId, input.owner.jobId, input.checkpointId, input.completedStep.step]) {
    if (!value || value.length > 320) throw new Error("Canonical terminal verifier identity is malformed.");
  }
}

function sortReceipts(receipts: StorageCanonicalTerminalVerifierReceipt[]): StorageCanonicalTerminalVerifierReceipt[] {
  return [...receipts].sort(
    (left, right) =>
      left.receiptKind.localeCompare(right.receiptKind) ||
      left.criterionId.localeCompare(right.criterionId) ||
      left.subjectKind.localeCompare(right.subjectKind) ||
      left.subjectId.localeCompare(right.subjectId) ||
      left.id.localeCompare(right.id)
  );
}

function compareLinks(left: StorageToolOutputLink, right: StorageToolOutputLink): number {
  return left.id.localeCompare(right.id);
}
