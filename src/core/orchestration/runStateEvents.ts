import { z } from "zod";
import {
  AssumptionReferenceSchema,
  BlockedReasonSchema,
  BudgetUsageSchema,
  DecisionReferenceSchema,
  NodeCompletionReceiptSchema,
  nodeCompletionReceiptHashPayload,
  OpenQuestionReferenceSchema,
  RunTerminationReceiptSchema,
  runTerminationReceiptHashPayload,
  VerifiedFactReferenceSchema
} from "./runStateCapsule.js";
import {
  assertCanonicalHash,
  type CanonicalHasher,
  deepFreeze,
  type DeepReadonly,
  IsoTimestampSchema,
  Sha256Schema,
  StableIdentifierSchema
} from "./orchestrationSchemas.js";

const EventIdentity = {
  schemaVersion: z.literal(1),
  eventId: StableIdentifierSchema,
  runId: StableIdentifierSchema,
  projectId: StableIdentifierSchema,
  expectedRevision: z.number().int().safe().nonnegative(),
  expectedStateHash: Sha256Schema,
  occurredAt: IsoTimestampSchema
};

const NodeActivatedEventSchema = z
  .object({
    ...EventIdentity,
    type: z.literal("node.activated"),
    nodeId: StableIdentifierSchema
  })
  .strict();

const NodeCompletedEventSchema = z
  .object({
    ...EventIdentity,
    type: z.literal("node.completed"),
    receipt: NodeCompletionReceiptSchema
  })
  .strict();

const FactVerifiedEventSchema = z
  .object({
    ...EventIdentity,
    type: z.literal("fact.verified"),
    fact: VerifiedFactReferenceSchema
  })
  .strict();

const DecisionRecordedEventSchema = z
  .object({
    ...EventIdentity,
    type: z.literal("decision.recorded"),
    decision: DecisionReferenceSchema
  })
  .strict();

const AssumptionRecordedEventSchema = z
  .object({
    ...EventIdentity,
    type: z.literal("assumption.recorded"),
    assumption: AssumptionReferenceSchema
  })
  .strict();

const QuestionOpenedEventSchema = z
  .object({
    ...EventIdentity,
    type: z.literal("question.opened"),
    question: OpenQuestionReferenceSchema
  })
  .strict();

const QuestionClosedEventSchema = z
  .object({
    ...EventIdentity,
    type: z.literal("question.closed"),
    questionId: StableIdentifierSchema,
    dispositionReceiptId: StableIdentifierSchema
  })
  .strict();

const BlockerAddedEventSchema = z
  .object({
    ...EventIdentity,
    type: z.literal("blocker.added"),
    reason: BlockedReasonSchema
  })
  .strict();

const BlockerClearedEventSchema = z
  .object({
    ...EventIdentity,
    type: z.literal("blocker.cleared"),
    sourceReceiptId: StableIdentifierSchema,
    dispositionReceiptId: StableIdentifierSchema
  })
  .strict();

const BudgetConsumedEventSchema = z
  .object({
    ...EventIdentity,
    type: z.literal("budget.consumed"),
    delta: BudgetUsageSchema
  })
  .strict()
  .refine((event) => Object.values(event.delta).some((value) => value > 0), {
    path: ["delta"],
    message: "Budget consumption must contain a positive delta."
  });

const NextActionsSetEventSchema = z
  .object({
    ...EventIdentity,
    type: z.literal("next_actions.set"),
    nodeIds: z.array(StableIdentifierSchema).max(64)
  })
  .strict();

const RunTerminatedEventSchema = z
  .object({
    ...EventIdentity,
    type: z.literal("run.terminated"),
    receipt: RunTerminationReceiptSchema
  })
  .strict();

export const RunStateEventSchema = z.discriminatedUnion("type", [
  NodeActivatedEventSchema,
  NodeCompletedEventSchema,
  FactVerifiedEventSchema,
  DecisionRecordedEventSchema,
  AssumptionRecordedEventSchema,
  QuestionOpenedEventSchema,
  QuestionClosedEventSchema,
  BlockerAddedEventSchema,
  BlockerClearedEventSchema,
  BudgetConsumedEventSchema,
  NextActionsSetEventSchema,
  RunTerminatedEventSchema
]);

type ParsedRunStateEvent = z.infer<typeof RunStateEventSchema>;
export type RunStateEvent = DeepReadonly<ParsedRunStateEvent>;

export function parseRunStateEvent(input: unknown, hasher: CanonicalHasher): RunStateEvent {
  const event = RunStateEventSchema.parse(input);
  if (event.type === "node.completed") {
    assertCanonicalHash("NodeCompletionReceipt", event.receipt.receiptHash, nodeCompletionReceiptHashPayload(event.receipt), hasher);
  }
  if (event.type === "run.terminated") {
    assertCanonicalHash("RunTerminationReceipt", event.receipt.receiptHash, runTerminationReceiptHashPayload(event.receipt), hasher);
  }
  return deepFreeze(event);
}
