import { z } from "zod";
import {
  addDuplicateIssues,
  assertCanonicalHash,
  type CanonicalHasher,
  deepFreeze,
  type DeepReadonly,
  IsoTimestampSchema,
  ReasonCodeSchema,
  Sha256Schema,
  StableIdentifierSchema
} from "./orchestrationSchemas.js";
import { parseTaskContract, type TaskContract } from "./taskContract.js";
import { parseTaskGraph, TaskGraphSchema, taskGraphHashPayload, type TaskGraph } from "./taskGraph.js";

export { parseTaskGraph, TaskGraphSchema, taskGraphHashPayload, type TaskGraph } from "./taskGraph.js";

export const ArtifactReferenceSchema = z
  .object({
    artifactId: StableIdentifierSchema,
    projectId: StableIdentifierSchema,
    contentHash: Sha256Schema,
    attestationId: StableIdentifierSchema.optional(),
    attestationHash: Sha256Schema.optional(),
    promotionReceiptId: StableIdentifierSchema
  })
  .strict()
  .superRefine((reference, context) => {
    if (Boolean(reference.attestationId) !== Boolean(reference.attestationHash)) {
      context.addIssue({ code: "custom", message: "Artifact attestation identity and hash must be recorded together." });
    }
  });

export const EvidenceReferenceSchema = z
  .object({
    evidenceId: StableIdentifierSchema,
    projectId: StableIdentifierSchema,
    contentHash: Sha256Schema,
    attestationId: StableIdentifierSchema.optional(),
    attestationHash: Sha256Schema.optional(),
    verificationReceiptId: StableIdentifierSchema
  })
  .strict()
  .superRefine((reference, context) => {
    if (Boolean(reference.attestationId) !== Boolean(reference.attestationHash)) {
      context.addIssue({ code: "custom", message: "Evidence attestation identity and hash must be recorded together." });
    }
  });

export const NodeCompletionReceiptSchema = z
  .object({
    receiptId: StableIdentifierSchema,
    runId: StableIdentifierSchema,
    projectId: StableIdentifierSchema,
    nodeId: StableIdentifierSchema,
    artifactRefs: z.array(ArtifactReferenceSchema).max(128),
    evidenceRefs: z.array(EvidenceReferenceSchema).max(128),
    verifierReceiptIds: z.array(StableIdentifierSchema).max(64),
    completedAt: IsoTimestampSchema,
    receiptHash: Sha256Schema
  })
  .strict()
  .superRefine((receipt, context) => {
    addDuplicateIssues(
      receipt.artifactRefs.map((reference) => reference.artifactId),
      context,
      "artifactRefs"
    );
    addDuplicateIssues(
      receipt.evidenceRefs.map((reference) => reference.evidenceId),
      context,
      "evidenceRefs"
    );
    addDuplicateIssues(receipt.verifierReceiptIds, context, "verifierReceiptIds");
  });

const TerminationReceiptBase = {
  receiptId: StableIdentifierSchema,
  runId: StableIdentifierSchema,
  projectId: StableIdentifierSchema,
  completedNodeReceiptIds: z.array(StableIdentifierSchema).max(1_000),
  createdAt: IsoTimestampSchema,
  receiptHash: Sha256Schema
};

export const RunTerminationReceiptSchema = z.discriminatedUnion("outcome", [
  z
    .object({
      ...TerminationReceiptBase,
      outcome: z.literal("completed"),
      acceptanceReceiptIds: z.array(StableIdentifierSchema).min(1).max(128)
    })
    .strict(),
  z
    .object({
      ...TerminationReceiptBase,
      outcome: z.enum(["failed", "cancelled"]),
      reasonCode: ReasonCodeSchema
    })
    .strict()
]);

export const BudgetUsageSchema = z
  .object({
    durationMs: z.number().int().safe().nonnegative(),
    inputTokens: z.number().int().safe().nonnegative(),
    outputTokens: z.number().int().safe().nonnegative(),
    toolCalls: z.number().int().safe().nonnegative(),
    retries: z.number().int().safe().nonnegative(),
    estimatedCostMicrousd: z.number().int().safe().nonnegative(),
    toolOutputBytes: z.number().int().safe().nonnegative()
  })
  .strict();

export const VerifiedFactReferenceSchema = z
  .object({
    factId: StableIdentifierSchema,
    evidenceIds: z.array(StableIdentifierSchema).min(1).max(64),
    verificationReceiptId: StableIdentifierSchema,
    recordedAt: IsoTimestampSchema
  })
  .strict();

export const DecisionReferenceSchema = z
  .object({
    decisionId: StableIdentifierSchema,
    decisionReceiptId: StableIdentifierSchema,
    recordedAt: IsoTimestampSchema
  })
  .strict();

export const AssumptionReferenceSchema = z
  .object({
    assumptionId: StableIdentifierSchema,
    sourceRefId: StableIdentifierSchema,
    recordedAt: IsoTimestampSchema
  })
  .strict();

export const OpenQuestionReferenceSchema = z
  .object({
    questionId: StableIdentifierSchema,
    sourceRefId: StableIdentifierSchema,
    recordedAt: IsoTimestampSchema
  })
  .strict();

export const BlockedReasonSchema = z
  .object({
    code: ReasonCodeSchema,
    sourceReceiptId: StableIdentifierSchema,
    nodeId: StableIdentifierSchema.optional(),
    recordedAt: IsoTimestampSchema
  })
  .strict();

export const RunStateStatusSchema = z.enum(["ready", "running", "blocked", "awaiting_completion", "completed", "failed", "cancelled"]);

export const RunStateRevisionSchema = z
  .object({
    schemaVersion: z.literal(1),
    runId: StableIdentifierSchema,
    projectId: StableIdentifierSchema,
    revision: z.number().int().safe().nonnegative(),
    parentRevisionHash: Sha256Schema.nullable(),
    stateHash: Sha256Schema,
    taskContractId: StableIdentifierSchema,
    taskContractHash: Sha256Schema,
    taskGraph: TaskGraphSchema,
    status: RunStateStatusSchema,
    currentNodeId: StableIdentifierSchema.nullable(),
    completedNodeReceipts: z.array(NodeCompletionReceiptSchema).max(1_000),
    pendingNodeIds: z.array(StableIdentifierSchema).max(1_000),
    artifactRefs: z.array(ArtifactReferenceSchema).max(10_000),
    evidenceRefs: z.array(EvidenceReferenceSchema).max(10_000),
    verifiedFacts: z.array(VerifiedFactReferenceSchema).max(10_000),
    decisions: z.array(DecisionReferenceSchema).max(10_000),
    assumptions: z.array(AssumptionReferenceSchema).max(10_000),
    openQuestions: z.array(OpenQuestionReferenceSchema).max(10_000),
    blockedReasons: z.array(BlockedReasonSchema).max(1_000),
    budgetLimits: z
      .object({
        maxDurationMs: z.number().int().safe().positive(),
        maxInputTokens: z.number().int().safe().nonnegative(),
        maxOutputTokens: z.number().int().safe().nonnegative(),
        maxToolCalls: z.number().int().safe().nonnegative(),
        maxRetries: z.number().int().safe().nonnegative(),
        maxEstimatedCostMicrousd: z.number().int().safe().nonnegative(),
        maxToolOutputBytes: z.number().int().safe().nonnegative(),
        maxConcurrency: z.number().int().min(1).max(16)
      })
      .strict(),
    budgetUsage: BudgetUsageSchema,
    nextProposedNodeIds: z.array(StableIdentifierSchema).max(64),
    terminalReceipt: RunTerminationReceiptSchema.optional(),
    createdAt: IsoTimestampSchema,
    updatedAt: IsoTimestampSchema
  })
  .strict()
  .superRefine(validateRunState);

type ParsedRunStateRevision = z.infer<typeof RunStateRevisionSchema>;
declare const verifiedRunStateRevision: unique symbol;
export type RunStateRevision = DeepReadonly<ParsedRunStateRevision> & { readonly [verifiedRunStateRevision]: true };

export interface InitialRunStateInput {
  runId: string;
  projectId: string;
  taskContract: TaskContract;
  taskGraph: TaskGraph;
  createdAt: string;
}

export function createInitialRunStateRevision(input: InitialRunStateInput, hasher: CanonicalHasher): RunStateRevision {
  const contract = parseTaskContract(input.taskContract, hasher);
  const graph = parseTaskGraph(input.taskGraph, hasher);
  if (contract.projectId !== input.projectId) throw new Error("Task contract ownership does not match the run project.");
  const stateWithoutHash = {
    schemaVersion: 1,
    runId: input.runId,
    projectId: input.projectId,
    revision: 0,
    parentRevisionHash: null,
    taskContractId: contract.id,
    taskContractHash: contract.contentHash,
    taskGraph: graph,
    status: "ready",
    currentNodeId: null,
    completedNodeReceipts: [],
    pendingNodeIds: graph.nodes.map((node) => node.id),
    artifactRefs: [],
    evidenceRefs: [],
    verifiedFacts: [],
    decisions: [],
    assumptions: [],
    openQuestions: [],
    blockedReasons: [],
    budgetLimits: contract.resourceBudget,
    budgetUsage: emptyBudgetUsage(),
    nextProposedNodeIds: [],
    createdAt: input.createdAt,
    updatedAt: input.createdAt
  } as const;
  return parseRunStateRevision({ ...stateWithoutHash, stateHash: hasher.sha256Canonical(stateWithoutHash) }, hasher);
}

export function parseRunStateRevision(input: unknown, hasher: CanonicalHasher): RunStateRevision {
  const state = RunStateRevisionSchema.parse(input);
  assertCanonicalHash("TaskGraph", state.taskGraph.contentHash, taskGraphHashPayload(state.taskGraph), hasher);
  for (const receipt of state.completedNodeReceipts) {
    assertCanonicalHash("NodeCompletionReceipt", receipt.receiptHash, nodeCompletionReceiptHashPayload(receipt), hasher);
  }
  if (state.terminalReceipt) {
    assertCanonicalHash("RunTerminationReceipt", state.terminalReceipt.receiptHash, runTerminationReceiptHashPayload(state.terminalReceipt), hasher);
  }
  assertCanonicalHash("RunStateRevision", state.stateHash, runStateRevisionHashPayload(state), hasher);
  return deepFreeze(state) as RunStateRevision;
}

export function nodeCompletionReceiptHashPayload(
  receipt: z.infer<typeof NodeCompletionReceiptSchema>
): Omit<z.infer<typeof NodeCompletionReceiptSchema>, "receiptHash"> {
  const { receiptHash, ...payload } = receipt;
  void receiptHash;
  return payload;
}

export function runTerminationReceiptHashPayload(
  receipt: z.infer<typeof RunTerminationReceiptSchema>
): Omit<z.infer<typeof RunTerminationReceiptSchema>, "receiptHash"> {
  const { receiptHash, ...payload } = receipt;
  void receiptHash;
  return payload;
}

export function runStateRevisionHashPayload(state: ParsedRunStateRevision): Omit<ParsedRunStateRevision, "stateHash"> {
  const { stateHash, ...payload } = state;
  void stateHash;
  return payload;
}

function emptyBudgetUsage(): z.infer<typeof BudgetUsageSchema> {
  return { durationMs: 0, inputTokens: 0, outputTokens: 0, toolCalls: 0, retries: 0, estimatedCostMicrousd: 0, toolOutputBytes: 0 };
}

function validateRunState(state: ParsedRunStateRevision, context: z.RefinementCtx): void {
  const graphIds = new Set(state.taskGraph.nodes.map((node) => node.id));
  const completedIds = state.completedNodeReceipts.map((receipt) => receipt.nodeId);
  const partition = [...completedIds, ...state.pendingNodeIds, ...(state.currentNodeId ? [state.currentNodeId] : [])];
  addDuplicateIssues(partition, context, "pendingNodeIds");
  if (partition.length !== graphIds.size || partition.some((id) => !graphIds.has(id))) {
    context.addIssue({ code: "custom", path: ["taskGraph"], message: "Current, completed, and pending nodes must partition the task graph." });
  }
  addDuplicateIssues(
    state.completedNodeReceipts.map((receipt) => receipt.receiptId),
    context,
    "completedNodeReceipts"
  );
  addDuplicateIssues(
    state.artifactRefs.map((reference) => reference.artifactId),
    context,
    "artifactRefs"
  );
  addDuplicateIssues(
    state.evidenceRefs.map((reference) => reference.evidenceId),
    context,
    "evidenceRefs"
  );
  addDuplicateIssues(
    state.verifiedFacts.map((reference) => reference.factId),
    context,
    "verifiedFacts"
  );
  addDuplicateIssues(
    state.decisions.map((reference) => reference.decisionId),
    context,
    "decisions"
  );
  addDuplicateIssues(
    state.assumptions.map((reference) => reference.assumptionId),
    context,
    "assumptions"
  );
  addDuplicateIssues(
    state.openQuestions.map((reference) => reference.questionId),
    context,
    "openQuestions"
  );
  addDuplicateIssues(state.nextProposedNodeIds, context, "nextProposedNodeIds");
  validateOwnershipAndReferences(state, context);
  validateStatus(state, context);
}

function validateOwnershipAndReferences(state: ParsedRunStateRevision, context: z.RefinementCtx): void {
  for (const receipt of state.completedNodeReceipts) {
    if (receipt.runId !== state.runId || receipt.projectId !== state.projectId) {
      context.addIssue({ code: "custom", path: ["completedNodeReceipts"], message: "Node receipt ownership does not match the run." });
    }
  }
  const resources = [...state.artifactRefs, ...state.evidenceRefs];
  if (resources.some((reference) => reference.projectId !== state.projectId)) {
    context.addIssue({ code: "custom", path: ["artifactRefs"], message: "Resource ownership does not match the run project." });
  }
  const evidenceIds = new Set(state.evidenceRefs.map((reference) => reference.evidenceId));
  if (state.verifiedFacts.some((fact) => fact.evidenceIds.some((evidenceId) => !evidenceIds.has(evidenceId)))) {
    context.addIssue({ code: "custom", path: ["verifiedFacts"], message: "Verified facts may reference only recorded evidence." });
  }
  const pending = new Set(state.pendingNodeIds);
  if (state.nextProposedNodeIds.some((nodeId) => !pending.has(nodeId))) {
    context.addIssue({ code: "custom", path: ["nextProposedNodeIds"], message: "Proposed actions must reference pending task nodes." });
  }
}

function validateStatus(state: ParsedRunStateRevision, context: z.RefinementCtx): void {
  const terminal = state.status === "completed" || state.status === "failed" || state.status === "cancelled";
  if (terminal !== Boolean(state.terminalReceipt))
    context.addIssue({ code: "custom", path: ["terminalReceipt"], message: "Terminal state requires exactly one termination receipt." });
  if (
    state.terminalReceipt &&
    (state.terminalReceipt.runId !== state.runId || state.terminalReceipt.projectId !== state.projectId || state.terminalReceipt.outcome !== state.status)
  ) {
    context.addIssue({ code: "custom", path: ["terminalReceipt"], message: "Termination receipt does not match state identity or outcome." });
  }
  if (state.status === "running" && !state.currentNodeId)
    context.addIssue({ code: "custom", path: ["currentNodeId"], message: "Running state requires a current node." });
  if (state.status === "ready" && (state.currentNodeId || state.pendingNodeIds.length === 0 || state.blockedReasons.length > 0)) {
    context.addIssue({ code: "custom", path: ["status"], message: "Ready state requires pending work and no active node or blocker." });
  }
  if (state.status === "blocked" && state.blockedReasons.length === 0)
    context.addIssue({ code: "custom", path: ["blockedReasons"], message: "Blocked state requires a reason receipt." });
  if (state.status === "awaiting_completion" && (state.currentNodeId || state.pendingNodeIds.length > 0 || state.blockedReasons.length > 0)) {
    context.addIssue({ code: "custom", path: ["status"], message: "Awaiting completion requires every task node to be completed." });
  }
  if (
    state.status === "completed" &&
    (state.currentNodeId || state.pendingNodeIds.length > 0 || state.completedNodeReceipts.length !== state.taskGraph.nodes.length)
  ) {
    context.addIssue({ code: "custom", path: ["status"], message: "Completed state requires a receipt for every task node." });
  }
}
