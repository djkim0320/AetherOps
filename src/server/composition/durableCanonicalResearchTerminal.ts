import type { ResearchSnapshot, ValidationResult } from "../../core/shared/evaluationTypes.js";
import { exceededBudgetDimensions } from "../../core/orchestration/budgetAccounting.js";
import type { CanonicalHasher } from "../../core/orchestration/orchestrationSchemas.js";
import type { StorageOutputPromotion } from "../runtime/storage/v2/jobAtomicTypes.js";
import type { StorageCanonicalBudgetPrefix } from "../runtime/storage/v2/runStateAtomicTypes.js";
import {
  CANONICAL_POLICY_CRITERION,
  CANONICAL_TRACEABILITY_CRITERION,
  type StorageCanonicalTerminalVerifierReceipt,
  type StorageCanonicalTerminalVerifyInput,
  type StorageCanonicalTerminalVerifyResult,
  type StorageTerminalCriterionCandidate,
  type StorageTerminalResourceCandidate
} from "../runtime/storage/v2/terminalReceiptTypes.js";
import type { DurableCanonicalTerminalTransition } from "./durableCanonicalTerminalTransition.js";
import { CanonicalRunRuntime } from "./canonicalRunRuntime.js";
import { CanonicalRunRuntimeError, type CanonicalRevisionPlan } from "./canonicalRunTypes.js";
import type { DurableJobRecord } from "./durableJobTypes.js";

interface CanonicalResearchTerminalInput {
  runtime: CanonicalRunRuntime;
  owner: { projectId: string; runId: string; jobId: string };
  job: DurableJobRecord;
  snapshot: ResearchSnapshot;
  promotions: StorageOutputPromotion[];
  hasher: CanonicalHasher;
  precedingPlan: CanonicalRevisionPlan;
  verifyTerminal(input: Omit<StorageCanonicalTerminalVerifyInput, "fence">): Promise<StorageCanonicalTerminalVerifyResult>;
}

export function canonicalResearchTerminalTransition(input: CanonicalResearchTerminalInput): DurableCanonicalTerminalTransition {
  assertTerminalScope(input);
  return {
    owner: input.owner,
    prepareRevision: (terminal) => prepareTerminalRevision(input, terminal)
  };
}

async function prepareTerminalRevision(
  input: CanonicalResearchTerminalInput,
  terminal: Parameters<DurableCanonicalTerminalTransition["prepareRevision"]>[0]
): Promise<
  CanonicalRevisionPlan & {
    budgetPrefix: StorageCanonicalBudgetPrefix;
    budgetExceededDimensions?: string[];
  }
> {
  const { state: storedState, taskContract } = await input.runtime.readCurrentRun(input.owner);
  const preceding = input.precedingPlan;
  if (preceding.expectedRevision !== storedState.revision || (preceding.revisions[0]?.parentRevisionHash ?? storedState.stateHash) !== storedState.stateHash) {
    throw new CanonicalRunRuntimeError("CANONICAL_STATE_STALE", "Terminal budget prefix no longer starts from the stored canonical revision.");
  }
  const state = preceding.finalState;
  const expectedState = { revision: state.revision, stateHash: state.stateHash };
  const budgetExceeded = exceededBudgetDimensions(state);
  let terminalPlan: CanonicalRevisionPlan;
  if (terminal.status === "paused" || terminal.status === "interrupted") {
    terminalPlan = { expectedRevision: state.revision, revisions: [], finalState: state, exactReplay: true };
  } else if (budgetExceeded.length || terminal.status === "blocked" || terminal.status === "failed") {
    terminalPlan = input.runtime.prepareResumableBlockerRevisionFromState(
      {
        owner: input.owner,
        expectedState,
        reasonCode: budgetExceeded.length ? "BUDGET_EXHAUSTED" : terminal.status === "blocked" ? "JOB_BLOCKED" : "RECOVERABLE_JOB_FAILURE",
        sourceReceiptId: input.job.id,
        recordedAt: terminal.recordedAt
      },
      state
    );
  } else if (terminal.status === "aborted") {
    terminalPlan = input.runtime.prepareTerminalRevisionsFromState(
      {
        owner: input.owner,
        expectedState,
        outcome: "cancelled",
        reasonCode: "USER_ABORTED",
        recordedAt: terminal.recordedAt,
        terminalAuthorization: "explicit_abort"
      },
      taskContract,
      state
    );
  } else {
    terminalPlan = await prepareCompletedTerminalPlan(input, terminal, taskContract, state, expectedState);
  }
  return mergePrecedingPlan(preceding, terminalPlan, budgetExceeded);
}

async function prepareCompletedTerminalPlan(
  input: CanonicalResearchTerminalInput,
  terminal: Parameters<DurableCanonicalTerminalTransition["prepareRevision"]>[0],
  taskContract: Awaited<ReturnType<CanonicalRunRuntime["readCurrentRun"]>>["taskContract"],
  state: Awaited<ReturnType<CanonicalRunRuntime["readCurrentRun"]>>["state"],
  expectedState: { revision: number; stateHash: string }
): Promise<CanonicalRevisionPlan> {
  if (!terminal.completedStepCheckpointId || !terminal.completedStep) {
    throw new CanonicalRunRuntimeError("MISSING_ACCEPTANCE_VERIFIER", "Canonical completion requires the durable completed-step checkpoint receipt.");
  }
  const candidates = completionCandidates(input);
  const criteria = criterionCandidates(taskContract.acceptanceCriteria, input.snapshot, input.hasher);
  const verified = await input.verifyTerminal({
    owner: input.owner,
    checkpointId: terminal.completedStepCheckpointId,
    completedStep: terminal.completedStep,
    resources: candidates.resources,
    criteria,
    verifiedAt: terminal.recordedAt
  });
  const resources = verifiedCompletionResources(input, candidates, verified);
  const acceptanceVerifiers = acceptanceReceipts(taskContract.acceptanceCriteria, verified.receipts);
  const nodeVerifierReceiptIds = verified.receipts.map((receipt) => receipt.id).sort();
  return input.runtime.prepareTerminalRevisionsFromState(
    {
      owner: input.owner,
      expectedState,
      outcome: "completed",
      artifactRefs: resources.artifactRefs,
      evidenceRefs: resources.evidenceRefs,
      nodeVerifierReceiptIds,
      acceptanceVerifiers,
      completedAt: terminal.recordedAt,
      terminatedAt: terminal.recordedAt
    },
    taskContract,
    state
  );
}

function mergePrecedingPlan(
  preceding: CanonicalRevisionPlan,
  terminal: CanonicalRevisionPlan,
  budgetExceeded: string[]
): CanonicalRevisionPlan & { budgetPrefix: StorageCanonicalBudgetPrefix; budgetExceededDimensions?: string[] } {
  if (terminal.expectedRevision !== preceding.finalState.revision) {
    throw new CanonicalRunRuntimeError("CANONICAL_STATE_STALE", "Terminal plan does not continue from its budget-accounting prefix.");
  }
  return {
    expectedRevision: preceding.expectedRevision,
    revisions: [...preceding.revisions, ...terminal.revisions],
    finalState: terminal.finalState,
    exactReplay: preceding.exactReplay && terminal.exactReplay,
    budgetPrefix: budgetPrefix(preceding),
    ...(budgetExceeded.length ? { budgetExceededDimensions: [...budgetExceeded].sort() } : {})
  };
}

function budgetPrefix(plan: CanonicalRevisionPlan): StorageCanonicalBudgetPrefix {
  const decision = [...plan.finalState.decisions].reverse().find((item) => item.decisionId.startsWith("budget-accounting-v1:"));
  const receiptHash = decision?.decisionId.split(":").at(-1);
  if (!receiptHash || !/^[a-f0-9]{64}$/.test(receiptHash)) {
    throw new CanonicalRunRuntimeError("CANONICAL_RUN_NOT_READY", "Terminal transition lacks an immutable cumulative budget receipt.");
  }
  return {
    revisionCount: plan.revisions.length,
    finalState: { revision: plan.finalState.revision, stateHash: plan.finalState.stateHash },
    receiptHash,
    targetUsage: { ...plan.finalState.budgetUsage }
  };
}

function completionCandidates(input: CanonicalResearchTerminalInput) {
  const artifactById = new Map(input.snapshot.artifacts.map((item) => [item.id, item]));
  const evidenceById = new Map(input.snapshot.evidence.map((item) => [item.id, item]));
  const resources: StorageTerminalResourceCandidate[] = [];
  for (const promotion of [...input.promotions].sort((left, right) => left.link.id.localeCompare(right.link.id))) {
    assertPromotionOwner(input, promotion);
    if (promotion.link.outputKind === "source") {
      throw new CanonicalRunRuntimeError("MISSING_ACCEPTANCE_VERIFIER", "Raw source observations cannot be promoted as verified canonical results.");
    }
    if (promotion.link.outputKind === "artifact") {
      const artifact = artifactById.get(promotion.link.outputId);
      const contentHash = artifact?.metadata?.sha256;
      if (!artifact || typeof contentHash !== "string" || !/^[a-f0-9]{64}$/i.test(contentHash)) {
        throw new CanonicalRunRuntimeError("MISSING_ACCEPTANCE_VERIFIER", `Promoted artifact ${promotion.link.outputId} lacks a hash-verified readback.`);
      }
      resources.push({
        outputKind: "artifact",
        outputId: artifact.id,
        outputLinkId: promotion.link.id,
        attemptId: promotion.link.attemptId,
        contentHash: contentHash.toLowerCase()
      });
      continue;
    }
    const evidence = evidenceById.get(promotion.link.outputId);
    const verification = evidence ? evidenceVerification(input.snapshot.validationResults, evidence.id) : undefined;
    if (!evidence || !verification) {
      throw new CanonicalRunRuntimeError("MISSING_ACCEPTANCE_VERIFIER", `Promoted evidence ${promotion.link.outputId} lacks a validation receipt.`);
    }
    resources.push({
      outputKind: "evidence",
      outputId: evidence.id,
      outputLinkId: promotion.link.id,
      attemptId: promotion.link.attemptId,
      contentHash: input.hasher.sha256Canonical(canonicalEvidencePayload(evidence)),
      validationResultId: verification.id,
      validationResultHash: input.hasher.sha256Canonical(verification)
    });
  }
  return { resources, artifactById, evidenceById };
}

function criterionCandidates(
  criteria: ReadonlyArray<{ id: string; description: string }>,
  snapshot: ResearchSnapshot,
  hasher: CanonicalHasher
): StorageTerminalCriterionCandidate[] {
  const results = [...snapshot.validationResults].sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id));
  const used = new Set<string>();
  return criteria.map((criterion) => {
    if (criterion.description === CANONICAL_TRACEABILITY_CRITERION) return { criterionId: criterion.id, verificationKind: "traceability" };
    if (criterion.description === CANONICAL_POLICY_CRITERION) return { criterionId: criterion.id, verificationKind: "policy" };
    const validation = criterionValidation(criterion.description, results, used);
    if (!validation || used.has(validation.id)) {
      throw new CanonicalRunRuntimeError("MISSING_ACCEPTANCE_VERIFIER", `Acceptance criterion ${criterion.id} has no unique deterministic verifier receipt.`);
    }
    used.add(validation.id);
    return {
      criterionId: criterion.id,
      verificationKind: "validation",
      validationResultId: validation.id,
      validationResultHash: hasher.sha256Canonical(validation),
      sourceEvidenceIds: [...validation.supportingEvidenceIds].sort()
    };
  });
}

function criterionValidation(description: string, results: ValidationResult[], used: Set<string>): ValidationResult | undefined {
  const normalized = normalize(description);
  return results.find(
    (result) => !used.has(result.id) && result.claimScorecard?.claims.some((claim) => normalize(claim.claim) === normalized && claim.status === "supported")
  );
}

function acceptanceReceipts(criteria: ReadonlyArray<{ id: string }>, receipts: StorageCanonicalTerminalVerifierReceipt[]) {
  return criteria.map((criterion) => {
    const matches = receipts.filter((receipt) => receipt.receiptKind === "acceptance" && receipt.criterionId === criterion.id);
    if (matches.length !== 1) {
      throw new CanonicalRunRuntimeError("MISSING_ACCEPTANCE_VERIFIER", `Acceptance criterion ${criterion.id} lacks one worker-issued receipt.`);
    }
    return { criterionId: criterion.id, verifierReceiptId: matches[0]!.id };
  });
}

function verifiedCompletionResources(
  input: CanonicalResearchTerminalInput,
  candidates: ReturnType<typeof completionCandidates>,
  verified: StorageCanonicalTerminalVerifyResult
) {
  const artifactRefs = [] as Array<{
    artifactId: string;
    projectId: string;
    contentHash: string;
    attestationId: string;
    attestationHash: string;
    promotionReceiptId: string;
  }>;
  const evidenceRefs = [] as Array<{
    evidenceId: string;
    projectId: string;
    contentHash: string;
    attestationId: string;
    attestationHash: string;
    verificationReceiptId: string;
  }>;
  for (const candidate of candidates.resources) {
    const attestations = verified.attestations.filter(
      (attestation) => attestation.subjectKind === candidate.outputKind && attestation.subjectId === candidate.outputId
    );
    if (attestations.length !== 1)
      throw new CanonicalRunRuntimeError("MISSING_ACCEPTANCE_VERIFIER", `Resource ${candidate.outputId} lacks one worker-issued attestation.`);
    const attestation = attestations[0]!;
    const matches = verified.receipts.filter(
      (receipt) => receipt.receiptKind === candidate.outputKind && receipt.subjectId === attestation.id && receipt.subjectHash === attestation.attestationHash
    );
    if (matches.length !== 1)
      throw new CanonicalRunRuntimeError("MISSING_ACCEPTANCE_VERIFIER", `Resource ${candidate.outputId} lacks one worker-issued receipt.`);
    if (candidate.outputKind === "artifact") {
      const artifact = candidates.artifactById.get(candidate.outputId)!;
      artifactRefs.push({
        artifactId: artifact.id,
        projectId: artifact.projectId,
        contentHash: attestation.contentHash,
        attestationId: attestation.id,
        attestationHash: attestation.attestationHash,
        promotionReceiptId: matches[0]!.id
      });
    } else {
      const evidence = candidates.evidenceById.get(candidate.outputId)!;
      evidenceRefs.push({
        evidenceId: evidence.id,
        projectId: evidence.projectId,
        contentHash: attestation.contentHash,
        attestationId: attestation.id,
        attestationHash: attestation.attestationHash,
        verificationReceiptId: matches[0]!.id
      });
    }
  }
  assertTerminalScope(input);
  return { artifactRefs, evidenceRefs };
}

function evidenceVerification(results: ValidationResult[], evidenceId: string): ValidationResult | undefined {
  return [...results]
    .filter((item) => item.supportingEvidenceIds.includes(evidenceId) || item.contradictingEvidenceIds.includes(evidenceId))
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id))
    .at(-1);
}

function canonicalEvidencePayload(evidence: ResearchSnapshot["evidence"][number]) {
  return {
    id: evidence.id,
    projectId: evidence.projectId,
    category: evidence.category,
    title: evidence.title,
    summary: evidence.summary,
    sourceId: evidence.sourceId,
    sourceUri: evidence.sourceUri,
    citation: evidence.citation,
    quote: evidence.quote,
    doi: evidence.doi,
    keywords: [...evidence.keywords].sort(),
    linkedHypothesisIds: [...evidence.linkedHypothesisIds].sort(),
    reliabilityScore: evidence.reliabilityScore,
    relevanceScore: evidence.relevanceScore,
    evidenceStrength: evidence.evidenceStrength,
    limitations: [...(evidence.limitations ?? [])].sort(),
    createdAt: evidence.createdAt
  };
}

function assertTerminalScope(input: CanonicalResearchTerminalInput): void {
  if (input.owner.projectId !== input.job.projectId || input.owner.jobId !== input.job.id || input.snapshot.project.id !== input.job.projectId) {
    throw new CanonicalRunRuntimeError("CANONICAL_RUN_OWNERSHIP_MISMATCH", "Canonical terminal input does not belong to the active durable job.");
  }
}

function assertPromotionOwner(input: CanonicalResearchTerminalInput, promotion: StorageOutputPromotion): void {
  if (!promotion.link.promoted || promotion.link.projectId !== input.job.projectId || promotion.link.jobId !== input.job.id) {
    throw new CanonicalRunRuntimeError("CANONICAL_RUN_OWNERSHIP_MISMATCH", "Canonical completion contains an unpromoted or cross-job output link.");
  }
}

function normalize(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLocaleLowerCase("en-US");
}
