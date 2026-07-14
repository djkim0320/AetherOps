import { z } from "zod";
import type { ContextRunState } from "./contextTypes.js";

const StableIdentifierSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/);
const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const IsoTimestampSchema = z.string().refine((value) => Number.isFinite(Date.parse(value)), "Timestamp must be ISO-8601 compatible.");
const NonnegativeIntegerSchema = z.number().int().safe().nonnegative();

const ResourceBudgetSchema = z
  .object({
    maxDurationMs: z.number().int().safe().positive(),
    maxInputTokens: NonnegativeIntegerSchema,
    maxOutputTokens: NonnegativeIntegerSchema,
    maxToolCalls: NonnegativeIntegerSchema,
    maxRetries: NonnegativeIntegerSchema,
    maxEstimatedCostMicrousd: NonnegativeIntegerSchema,
    maxToolOutputBytes: NonnegativeIntegerSchema,
    maxConcurrency: z.number().int().min(1).max(16)
  })
  .strict();

const BudgetUsageSchema = z
  .object({
    durationMs: NonnegativeIntegerSchema,
    inputTokens: NonnegativeIntegerSchema,
    outputTokens: NonnegativeIntegerSchema,
    toolCalls: NonnegativeIntegerSchema,
    retries: NonnegativeIntegerSchema,
    estimatedCostMicrousd: NonnegativeIntegerSchema,
    toolOutputBytes: NonnegativeIntegerSchema
  })
  .strict();

const CompletedTerminalReceiptSchema = z
  .object({
    receiptId: StableIdentifierSchema,
    runId: StableIdentifierSchema,
    projectId: StableIdentifierSchema,
    outcome: z.literal("completed"),
    completedNodeReceiptIds: z.array(StableIdentifierSchema).max(1_000),
    acceptanceReceiptIds: z.array(StableIdentifierSchema).max(128),
    createdAt: IsoTimestampSchema,
    receiptHash: Sha256Schema
  })
  .strict();

const NonCompletedTerminalReceiptSchema = z
  .object({
    receiptId: StableIdentifierSchema,
    runId: StableIdentifierSchema,
    projectId: StableIdentifierSchema,
    outcome: z.enum(["failed", "cancelled"]),
    completedNodeReceiptIds: z.array(StableIdentifierSchema).max(1_000),
    reasonCode: StableIdentifierSchema,
    createdAt: IsoTimestampSchema,
    receiptHash: Sha256Schema
  })
  .strict();

export const ContextRunStateSchema = z
  .object({
    schemaVersion: z.literal(1),
    runId: StableIdentifierSchema,
    projectId: StableIdentifierSchema,
    status: StableIdentifierSchema,
    revision: NonnegativeIntegerSchema,
    parentRevisionHash: Sha256Schema.nullable(),
    stateHash: Sha256Schema,
    taskContractId: StableIdentifierSchema,
    taskContractHash: Sha256Schema,
    taskGraph: z
      .object({
        schemaVersion: z.literal(1),
        graphId: StableIdentifierSchema,
        contentHash: Sha256Schema,
        nodes: z
          .array(
            z
              .object({
                id: StableIdentifierSchema,
                kind: StableIdentifierSchema,
                dependencyNodeIds: z.array(StableIdentifierSchema).max(64),
                terminal: z.boolean()
              })
              .strict()
          )
          .min(1)
          .max(1_000)
      })
      .strict(),
    currentNodeId: StableIdentifierSchema.nullable(),
    checkpointId: StableIdentifierSchema.optional(),
    iterationCompletedActionIds: z.array(StableIdentifierSchema).max(1_000),
    completedNodeReceipts: z
      .array(
        z
          .object({
            receiptId: StableIdentifierSchema,
            runId: StableIdentifierSchema,
            projectId: StableIdentifierSchema,
            nodeId: StableIdentifierSchema,
            receiptHash: Sha256Schema,
            artifactRefs: z
              .array(
                z
                  .object({
                    artifactId: StableIdentifierSchema,
                    projectId: StableIdentifierSchema,
                    contentHash: Sha256Schema,
                    promotionReceiptId: StableIdentifierSchema
                  })
                  .strict()
              )
              .max(128),
            evidenceRefs: z
              .array(
                z
                  .object({
                    evidenceId: StableIdentifierSchema,
                    projectId: StableIdentifierSchema,
                    contentHash: Sha256Schema,
                    verificationReceiptId: StableIdentifierSchema
                  })
                  .strict()
              )
              .max(128),
            verifierReceiptIds: z.array(StableIdentifierSchema).max(64),
            completedAt: IsoTimestampSchema
          })
          .strict()
      )
      .max(1_000),
    pendingNodeIds: z.array(StableIdentifierSchema).max(1_000),
    artifactRefs: z
      .array(
        z
          .object({
            artifactId: StableIdentifierSchema,
            projectId: StableIdentifierSchema,
            contentHash: Sha256Schema,
            promotionReceiptId: StableIdentifierSchema
          })
          .strict()
      )
      .max(10_000),
    evidenceRefs: z
      .array(
        z
          .object({
            evidenceId: StableIdentifierSchema,
            projectId: StableIdentifierSchema,
            contentHash: Sha256Schema,
            verificationReceiptId: StableIdentifierSchema
          })
          .strict()
      )
      .max(10_000),
    verifiedFacts: z
      .array(
        z
          .object({
            factId: StableIdentifierSchema,
            evidenceIds: z.array(StableIdentifierSchema).min(1).max(64),
            verificationReceiptId: StableIdentifierSchema,
            recordedAt: IsoTimestampSchema
          })
          .strict()
      )
      .max(10_000),
    decisions: z
      .array(z.object({ decisionId: StableIdentifierSchema, decisionReceiptId: StableIdentifierSchema, recordedAt: IsoTimestampSchema }).strict())
      .max(10_000),
    assumptions: z
      .array(z.object({ assumptionId: StableIdentifierSchema, sourceRefId: StableIdentifierSchema, recordedAt: IsoTimestampSchema }).strict())
      .max(10_000),
    openQuestions: z
      .array(z.object({ questionId: StableIdentifierSchema, sourceRefId: StableIdentifierSchema, recordedAt: IsoTimestampSchema }).strict())
      .max(10_000),
    blockedReasons: z
      .array(
        z
          .object({
            code: StableIdentifierSchema,
            sourceReceiptId: StableIdentifierSchema,
            nodeId: StableIdentifierSchema.optional(),
            recordedAt: IsoTimestampSchema
          })
          .strict()
      )
      .max(1_000),
    budgetLimits: ResourceBudgetSchema,
    budgetUsage: BudgetUsageSchema,
    nextProposedNodeIds: z.array(StableIdentifierSchema).max(64),
    terminalReceipt: z.discriminatedUnion("outcome", [CompletedTerminalReceiptSchema, NonCompletedTerminalReceiptSchema]).optional(),
    createdAt: IsoTimestampSchema,
    updatedAt: IsoTimestampSchema
  })
  .strict();

export function normalizeContextRunState(value: ContextRunState): ContextRunState {
  const state = ContextRunStateSchema.parse(value) as ContextRunState;
  return {
    ...state,
    taskGraph: {
      ...state.taskGraph,
      nodes: state.taskGraph.nodes
        .map((node) => ({ ...node, dependencyNodeIds: sorted(node.dependencyNodeIds) }))
        .sort((left, right) => left.id.localeCompare(right.id))
    },
    iterationCompletedActionIds: sorted(state.iterationCompletedActionIds),
    completedNodeReceipts: state.completedNodeReceipts
      .map((receipt) => ({
        ...receipt,
        artifactRefs: [...receipt.artifactRefs].sort((left, right) => left.artifactId.localeCompare(right.artifactId)),
        evidenceRefs: [...receipt.evidenceRefs].sort((left, right) => left.evidenceId.localeCompare(right.evidenceId)),
        verifierReceiptIds: sorted(receipt.verifierReceiptIds)
      }))
      .sort((left, right) => left.nodeId.localeCompare(right.nodeId) || left.receiptId.localeCompare(right.receiptId)),
    pendingNodeIds: sorted(state.pendingNodeIds),
    artifactRefs: [...state.artifactRefs].sort((left, right) => left.artifactId.localeCompare(right.artifactId)),
    evidenceRefs: [...state.evidenceRefs].sort((left, right) => left.evidenceId.localeCompare(right.evidenceId)),
    verifiedFacts: state.verifiedFacts
      .map((fact) => ({ ...fact, evidenceIds: sorted(fact.evidenceIds) }))
      .sort((left, right) => left.factId.localeCompare(right.factId)),
    decisions: [...state.decisions].sort((left, right) => left.decisionId.localeCompare(right.decisionId)),
    assumptions: [...state.assumptions].sort((left, right) => left.assumptionId.localeCompare(right.assumptionId)),
    openQuestions: [...state.openQuestions].sort((left, right) => left.questionId.localeCompare(right.questionId)),
    blockedReasons: [...state.blockedReasons].sort(
      (left, right) => left.code.localeCompare(right.code) || left.sourceReceiptId.localeCompare(right.sourceReceiptId)
    ),
    nextProposedNodeIds: sorted(state.nextProposedNodeIds),
    ...(state.terminalReceipt
      ? {
          terminalReceipt: {
            ...state.terminalReceipt,
            completedNodeReceiptIds: sorted(state.terminalReceipt.completedNodeReceiptIds),
            ...(state.terminalReceipt.outcome === "completed" ? { acceptanceReceiptIds: sorted(state.terminalReceipt.acceptanceReceiptIds) } : {})
          }
        }
      : {})
  } as ContextRunState;
}

export function renderContextRunState(value: ContextRunState): string {
  return `Canonical run-state references: ${JSON.stringify(normalizeContextRunState(value))}`;
}

function sorted(values: string[]): string[] {
  return [...values].sort();
}
