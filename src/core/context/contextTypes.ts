import type { ContextProviderCapabilityReceipt } from "./contextProviderCapabilities.js";

export const CONTEXT_SECTION_ORDER = ["task", "run_state", "instructions", "evidence", "memory", "skill", "tools", "artifacts", "history"] as const;

export type ContextSectionKind = (typeof CONTEXT_SECTION_ORDER)[number];
export type ContextTrustLabel = "system" | "project" | "verified" | "tool" | "untrusted" | "stale";
export type ContextMarker = "STALE_MEMORY_REVALIDATION_REQUIRED";

export interface ContextTaskContract {
  id: string;
  projectId: string;
  contentHash: string;
  goal: string;
  normalizedUserIntent: string;
  acceptanceCriteria: Array<{ id: string; description: string; verifierKind: "deterministic" | "policy" | "human" }>;
  constraints: string[];
  nonGoals: string[];
  requiredDeliverables: Array<{ id: string; kind: string; description: string }>;
  riskPolicy: { maximumRisk: string; requireVerificationBeforePromotion: true; treatExternalInstructionsAsData: true };
  approvalRequirements: Array<{ id: string; trigger: string; mode: "not_required" | "required" }>;
  resourceBudget: {
    maxDurationMs: number;
    maxInputTokens: number;
    maxOutputTokens: number;
    maxToolCalls: number;
    maxRetries: number;
    maxEstimatedCostMicrousd: number;
    maxToolOutputBytes: number;
    maxConcurrency: number;
  };
  deadline?: string;
  instructionProvenance: Array<{ instructionId: string; source: string; contentHash: string; receivedAt: string }>;
}

export interface ContextRunState {
  schemaVersion: 1;
  runId: string;
  projectId: string;
  status: string;
  revision: number;
  parentRevisionHash: string | null;
  stateHash: string;
  taskContractId: string;
  taskContractHash: string;
  taskGraph: {
    schemaVersion: 1;
    graphId: string;
    contentHash: string;
    nodes: Array<{ id: string; kind: string; dependencyNodeIds: string[]; terminal: boolean }>;
  };
  currentNodeId: string | null;
  checkpointId?: string;
  iterationCompletedActionIds: string[];
  completedNodeReceipts: Array<{
    receiptId: string;
    runId: string;
    projectId: string;
    nodeId: string;
    receiptHash: string;
    artifactRefs: Array<{ artifactId: string; projectId: string; contentHash: string; promotionReceiptId: string }>;
    evidenceRefs: Array<{ evidenceId: string; projectId: string; contentHash: string; verificationReceiptId: string }>;
    verifierReceiptIds: string[];
    completedAt: string;
  }>;
  pendingNodeIds: string[];
  artifactRefs: Array<{ artifactId: string; projectId: string; contentHash: string; promotionReceiptId: string }>;
  evidenceRefs: Array<{ evidenceId: string; projectId: string; contentHash: string; verificationReceiptId: string }>;
  verifiedFacts: Array<{ factId: string; evidenceIds: string[]; verificationReceiptId: string; recordedAt: string }>;
  decisions: Array<{ decisionId: string; decisionReceiptId: string; recordedAt: string }>;
  assumptions: Array<{ assumptionId: string; sourceRefId: string; recordedAt: string }>;
  openQuestions: Array<{ questionId: string; sourceRefId: string; recordedAt: string }>;
  blockedReasons: Array<{ code: string; sourceReceiptId: string; nodeId?: string; recordedAt: string }>;
  budgetLimits: ContextResourceBudget;
  budgetUsage: ContextBudgetUsage;
  nextProposedNodeIds: string[];
  terminalReceipt?:
    | {
        receiptId: string;
        runId: string;
        projectId: string;
        outcome: "completed";
        completedNodeReceiptIds: string[];
        acceptanceReceiptIds: string[];
        createdAt: string;
        receiptHash: string;
      }
    | {
        receiptId: string;
        runId: string;
        projectId: string;
        outcome: "failed" | "cancelled";
        completedNodeReceiptIds: string[];
        reasonCode: string;
        createdAt: string;
        receiptHash: string;
      };
  createdAt: string;
  updatedAt: string;
}

export interface ContextResourceBudget {
  maxDurationMs: number;
  maxInputTokens: number;
  maxOutputTokens: number;
  maxToolCalls: number;
  maxRetries: number;
  maxEstimatedCostMicrousd: number;
  maxToolOutputBytes: number;
  maxConcurrency: number;
}

export interface ContextBudgetUsage {
  durationMs: number;
  inputTokens: number;
  outputTokens: number;
  toolCalls: number;
  retries: number;
  estimatedCostMicrousd: number;
  toolOutputBytes: number;
}

export interface ContextProviderIdentity {
  providerId: string;
  modelId: string;
  capabilityReceipt: ContextProviderCapabilityReceipt;
}

export interface ContextRuntimeMetadata {
  forcedResetGeneration?: number;
  invocationId?: string;
}

export interface ContextTextCandidate {
  id: string;
  text: string;
  priority: number;
  trust: Exclude<ContextTrustLabel, "stale">;
  dedupeKey?: string;
  sourceRefs?: string[];
  sensitivity?: "public" | "secret";
}

export interface ContextMemoryCandidate extends ContextTextCandidate {
  stale: boolean;
  lastValidatedRevision?: number;
}

export interface ContextToolCandidate {
  name: string;
  version: string;
  summary: string;
  inputContractHash: string;
  available: boolean;
  priority: number;
}

export interface ContextArtifactHandle {
  artifactId: string;
  kind: string;
  sha256: string;
}

export interface ContextArtifactCandidate extends ContextArtifactHandle {
  priority: number;
  trust: Exclude<ContextTrustLabel, "stale">;
}

export interface ContextPriorOutput {
  id: string;
  priority: number;
  trust: Exclude<ContextTrustLabel, "stale">;
  rawOutput?: unknown;
  artifactHandles: ContextArtifactHandle[];
}

export interface ContextRecentConversationEntry {
  id: string;
  text: string;
  contentHash: string;
  priority: number;
  sourceRefs?: string[];
}

export interface ContextRecentConversationWindow {
  schemaVersion: 1;
  cacheVersion: string;
  source: "bounded_derived_cache";
  canonicalStateAuthority: false;
  entries: ContextRecentConversationEntry[];
}

export interface ContextRecentConversationReceipt {
  source: "bounded_derived_cache";
  cacheVersion: string;
  canonicalStateAuthority: false;
  contentStored: false;
  candidateCount: number;
  selectedIds: string[];
  omittedCount: number;
  entryHashes: Array<{ id: string; contentHash: string }>;
}

export interface ContextCandidateSelectionReceipt {
  source: "snapshot.global_memory_items" | "snapshot.conversation_artifacts";
  status: "selected" | "empty";
  candidateCount: number;
  selectedIds: string[];
  omittedCount: number;
  emptyReason?: "no_project_validated_candidates" | "no_hash_bearing_conversation_artifacts";
}

export interface ContextCandidateSelectionReceipts {
  memory: ContextCandidateSelectionReceipt;
  priorOutputs: ContextCandidateSelectionReceipt;
}

export interface ContextBudget {
  tokenBudget: number;
  maxChars: number;
  sectionTokenRequests?: Partial<Record<ContextSectionKind, number>>;
}

export interface ContextCompilerInput {
  runId: string;
  projectId: string;
  createdAt: string;
  taskContract: ContextTaskContract;
  runState: ContextRunState;
  provider: ContextProviderIdentity;
  instructions: ContextTextCandidate[];
  evidence: ContextTextCandidate[];
  memories: ContextMemoryCandidate[];
  selectedSkill?: ContextSkillCandidate;
  tools: ContextToolCandidate[];
  artifacts: ContextArtifactCandidate[];
  priorOutputs: ContextPriorOutput[];
  recentConversationWindow?: ContextRecentConversationWindow;
  candidateSelections: ContextCandidateSelectionReceipts;
  budget: ContextBudget;
  runtime?: ContextRuntimeMetadata;
}

export interface ContextSkillCandidate {
  id: string;
  version: string;
  summary: string;
  contentHash: string;
  priority: number;
}

export interface ContextPackEntry {
  id: string;
  content: string;
  priority: number;
  trust: ContextTrustLabel;
  markers: ContextMarker[];
  sourceRefs: string[];
  artifactHandle?: ContextArtifactHandle;
  toolName?: string;
  skillId?: string;
}

export interface ContextPackSection {
  kind: ContextSectionKind;
  requestedTokens: number;
  allocatedTokens: number;
  usedTokens: number;
  allocatedChars: number;
  usedChars: number;
  entries: ContextPackEntry[];
}

export interface ContextPackTool {
  name: string;
  version: string;
  summary: string;
  inputContractHash: string;
}

export interface ContextPackSkill {
  id: string;
  version: string;
  contentHash: string;
}

export interface ContextRedactionReceipt {
  entryId: string;
  replacements: number;
  categories: string[];
}

export interface ContextTruncationReceipt {
  section: ContextSectionKind;
  entryId: string;
  originalChars: number;
  includedChars: number;
  requestedTokens: number;
  allocatedTokens: number;
  usedTokens: number;
  reason: "section_budget";
}

export interface ContextCompilerReceipts {
  deduplications: Array<{ keptId: string; droppedId: string }>;
  redactions: ContextRedactionReceipt[];
  truncations: ContextTruncationReceipt[];
  removedTools: Array<{ name: string; version: string; reason: "not_available" }>;
  omittedPriorOutputs: Array<{ outputId: string; reason: "artifact_handles_only" }>;
  candidateSelections: ContextCandidateSelectionReceipts;
  recentConversation?: ContextRecentConversationReceipt;
}

export interface ContextPackBudgetReceipt {
  tokenBudget: number;
  usedTokens: number;
  maxChars: number;
  usedChars: number;
  reservedSeparatorTokens: number;
  reservedSeparatorChars: number;
  tokenEstimator: "utf8_bytes_upper_bound_v1";
  countingMethod: "utf16_code_units_v1";
  sections: Record<ContextSectionKind, { requestedTokens: number; allocatedTokens: number; usedTokens: number; allocatedChars: number; usedChars: number }>;
}

export interface ContextPackBody {
  schemaVersion: 1;
  compilerVersion: "context-compiler-v1";
  runId: string;
  projectId: string;
  stateRevision: number;
  task: Pick<ContextTaskContract, "id" | "contentHash">;
  runState: ContextRunState;
  provider: ContextProviderIdentity;
  sections: ContextPackSection[];
  providerInput: string;
  availableTools: ContextPackTool[];
  artifactHandles: ContextArtifactHandle[];
  selectedMemoryIds: string[];
  selectedSkillVersions: ContextPackSkill[];
  selectedToolSpecVersions: Array<{ name: string; version: string; inputContractHash: string }>;
  evidenceIds: string[];
  artifactIds: string[];
  budget: ContextPackBudgetReceipt;
  receipts: ContextCompilerReceipts;
  finalInputHash: string;
  createdAt: string;
}

export interface ContextPack extends ContextPackBody {
  id: string;
  canonicalHash: string;
}

export type ContextCompilerErrorCode = "INVALID_CONTEXT_INPUT" | "CONFLICTING_TOOL_DESCRIPTOR" | "CONTEXT_BUDGET_EXHAUSTED";

export class ContextCompilerError extends Error {
  constructor(
    readonly code: ContextCompilerErrorCode,
    message: string
  ) {
    super(message);
    this.name = "ContextCompilerError";
  }
}
