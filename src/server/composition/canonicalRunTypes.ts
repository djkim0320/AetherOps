import type {
  ContextArtifactCandidate,
  ContextBudget,
  ContextCandidateSelectionReceipts,
  ContextMemoryCandidate,
  ContextPack,
  ContextPackPersistenceReceipt,
  ContextPriorOutput,
  ContextProviderIdentity,
  ContextRuntimeMetadata,
  ContextSkillCandidate,
  ContextTextCandidate
} from "../../core/context/public.js";
import type { CanonicalHasher } from "../../core/orchestration/orchestrationSchemas.js";
import type { RunStateRevision } from "../../core/orchestration/runStateCapsule.js";
import type { TaskContract } from "../../core/orchestration/taskContract.js";
import type { ResearchSnapshot } from "../../core/shared/evaluationTypes.js";
import type { ResearchSpecification } from "../../core/shared/researchTypes.js";
import type { StorageCapabilitySet, StorageJobToolPolicy } from "../runtime/storage/v2/types.js";

export interface CanonicalRunOwner {
  projectId: string;
  runId: string;
  jobId: string;
}

export type CanonicalExternalEffectStatus = "queued" | "running" | "committed" | "quarantined" | "failed" | "interrupted";

export interface CanonicalExternalEffect {
  attemptId: string;
  status: CanonicalExternalEffectStatus;
}

export interface CanonicalRunPolicy {
  requestedCapabilities: StorageCapabilitySet;
  effectiveCapabilities: StorageCapabilitySet;
  toolPolicy: StorageJobToolPolicy;
  externalSideEffects: CanonicalExternalEffect[];
}

export interface CanonicalTaskLimits {
  maxDurationMs: number;
  maxInputTokens: number;
  maxOutputTokens: number;
  maxToolCalls: number;
  maxRetries: number;
  maxEstimatedCostMicrousd: number;
  maxToolOutputBytes: number;
  maxConcurrency: number;
}

export type CanonicalToolSideEffect = "network" | "filesystem" | "process";

export interface CanonicalPlanningTool {
  name: string;
  version: string;
  summary: string;
  inputContractHash: string;
  requiredCapabilities: Array<keyof StorageCapabilitySet>;
  sideEffects: CanonicalToolSideEffect[];
  priority: number;
}

export interface CanonicalPlanningEvidence extends ContextTextCandidate {
  projectId: string;
}

export interface CanonicalPlanningArtifact extends ContextArtifactCandidate {
  projectId: string;
}

export interface CanonicalPlanningMemory extends ContextMemoryCandidate {
  projectId: string;
}

export interface CanonicalPlanningPriorOutput extends ContextPriorOutput {
  projectId: string;
}

export interface PrepareCanonicalRunInput {
  owner: CanonicalRunOwner;
  rootJobId: string;
  rootJobCreatedAt: string;
  snapshot: ResearchSnapshot;
  specification?: ResearchSpecification;
  policy: CanonicalRunPolicy;
  taskLimits: CanonicalTaskLimits;
  preparedAt: string;
  initializationAnchor?: unknown;
}

export interface CanonicalStateExpectation {
  revision: number;
  stateHash: string;
}

export interface CompilePlanningContextInput {
  owner: CanonicalRunOwner;
  snapshot: ResearchSnapshot;
  specification?: ResearchSpecification;
  iteration: number;
  provider: ContextProviderIdentity;
  selectedTools: CanonicalPlanningTool[];
  policyInstructions: ContextTextCandidate[];
  evidence: CanonicalPlanningEvidence[];
  artifactHandles: CanonicalPlanningArtifact[];
  memories: CanonicalPlanningMemory[];
  priorOutputs: CanonicalPlanningPriorOutput[];
  candidateSelections: ContextCandidateSelectionReceipts;
  selectedSkill?: ContextSkillCandidate;
  budget: ContextBudget;
  runtime?: ContextRuntimeMetadata;
  checkpointId?: string;
  expectedState: CanonicalStateExpectation;
  compiledAt: string;
  policy: CanonicalRunPolicy;
  resumeContextBinding?: ContextPackPersistenceReceipt;
}

export interface PreparedCanonicalRun {
  taskContract: TaskContract;
  state: RunStateRevision;
}

export interface RecordCanonicalCheckpointInput {
  owner: CanonicalRunOwner;
  checkpointId: string;
  stepReceiptId: string;
  recordedAt: string;
  expectedState: CanonicalStateExpectation;
}

export interface CanonicalArtifactReferenceInput {
  artifactId: string;
  projectId: string;
  contentHash: string;
  attestationId: string;
  attestationHash: string;
  promotionReceiptId: string;
}

export interface CanonicalEvidenceReferenceInput {
  evidenceId: string;
  projectId: string;
  contentHash: string;
  attestationId: string;
  attestationHash: string;
  verificationReceiptId: string;
}

export interface CanonicalAcceptanceVerifierInput {
  criterionId: string;
  verifierReceiptId: string;
}

export interface RecordCanonicalCompletionInput {
  owner: CanonicalRunOwner;
  expectedState: CanonicalStateExpectation;
  artifactRefs: CanonicalArtifactReferenceInput[];
  evidenceRefs: CanonicalEvidenceReferenceInput[];
  nodeVerifierReceiptIds: string[];
  acceptanceVerifiers: CanonicalAcceptanceVerifierInput[];
  completedAt: string;
  terminatedAt: string;
}

export interface RecordCanonicalNonCompletionInput {
  owner: CanonicalRunOwner;
  expectedState: CanonicalStateExpectation;
  reasonCode: string;
  recordedAt: string;
  terminalAuthorization: "explicit_permanent_failure" | "explicit_abort";
}

export interface RecordCanonicalBlockerInput {
  owner: CanonicalRunOwner;
  expectedState: CanonicalStateExpectation;
  reasonCode: string;
  sourceReceiptId: string;
  recordedAt: string;
}

export interface CanonicalBlockerClearanceInput {
  sourceReceiptId: string;
  dispositionReceiptId: string;
}

interface PrepareCanonicalResumeBaseInput {
  owner: CanonicalRunOwner;
  expectedState: CanonicalStateExpectation;
  resumeAuthorizationReceiptId: string;
  blockerClearances: CanonicalBlockerClearanceInput[];
  recordedAt: string;
}

export type PrepareCanonicalResumeInput = PrepareCanonicalResumeBaseInput &
  ({ mode?: "checkpoint"; predecessorCheckpointId: string; predecessorCheckpointReceiptId: string } | { mode: "bootstrap" });

export type RecordCanonicalTerminalInput =
  (RecordCanonicalCompletionInput & { outcome: "completed" }) | (RecordCanonicalNonCompletionInput & { outcome: "failed" | "cancelled" });

export interface CanonicalRevisionPlan {
  expectedRevision: number;
  revisions: RunStateRevision[];
  finalState: RunStateRevision;
  exactReplay: boolean;
}

export interface CanonicalRunGateway {
  saveTaskContract(owner: CanonicalRunOwner, contract: TaskContract): Promise<unknown>;
  getTaskContract(projectId: string, taskContractId: string): Promise<unknown | undefined>;
  latestRunState(owner: CanonicalRunOwner): Promise<unknown | undefined>;
  commitRunState(owner: CanonicalRunOwner, expectedRevision: number | null, revision: RunStateRevision): Promise<unknown>;
  saveContextPack(owner: CanonicalRunOwner, expectedRevision: number, pack: ContextPack): Promise<unknown>;
  getResumeContextPack?(owner: CanonicalRunOwner, predecessorJobId: string, contextPackId: string): Promise<unknown | undefined>;
}

export interface CanonicalRunRuntimeDependencies {
  gateway: CanonicalRunGateway;
  hasher: CanonicalHasher;
}

export type CanonicalRunRuntimeErrorCode =
  | "INVALID_CANONICAL_RUN_INPUT"
  | "CANONICAL_RUN_OWNERSHIP_MISMATCH"
  | "CANONICAL_TASK_MISMATCH"
  | "CANONICAL_STATE_STALE"
  | "CANONICAL_RUN_NOT_READY"
  | "PENDING_EXTERNAL_SIDE_EFFECT"
  | "TOOL_POLICY_VIOLATION"
  | "CANONICAL_READBACK_MISMATCH"
  | "MISSING_ACCEPTANCE_VERIFIER"
  | "CANONICAL_TERMINAL_CONFLICT"
  | "CANONICAL_RESUME_CONFLICT";

export class CanonicalRunRuntimeError extends Error {
  constructor(
    readonly code: CanonicalRunRuntimeErrorCode,
    message: string
  ) {
    super(message);
    this.name = "CanonicalRunRuntimeError";
  }
}
