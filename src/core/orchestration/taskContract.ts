import { z } from "zod";
import {
  addDuplicateIssues,
  assertCanonicalHash,
  BoundedTextSchema,
  type CanonicalHasher,
  deepFreeze,
  type DeepReadonly,
  IsoTimestampSchema,
  Sha256Schema,
  StableIdentifierSchema
} from "./orchestrationSchemas.js";

export const AcceptanceCriterionSchema = z
  .object({
    id: StableIdentifierSchema,
    description: BoundedTextSchema,
    verifierKind: z.enum(["deterministic", "policy", "human"])
  })
  .strict();

export const RequiredDeliverableSchema = z
  .object({
    id: StableIdentifierSchema,
    kind: z.enum(["artifact", "report", "dataset", "code", "evidence_index"]),
    description: BoundedTextSchema
  })
  .strict();

export const TaskRiskPolicySchema = z
  .object({
    maximumRisk: z.enum(["read_only", "reversible_write", "irreversible_write", "external_side_effect"]),
    requireVerificationBeforePromotion: z.literal(true),
    treatExternalInstructionsAsData: z.literal(true)
  })
  .strict();

export const ApprovalRequirementSchema = z
  .object({
    id: StableIdentifierSchema,
    trigger: z.enum(["network", "filesystem_write", "process", "external_side_effect", "irreversible_action"]),
    mode: z.enum(["not_required", "required"])
  })
  .strict();

export const ResourceBudgetSchema = z
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
  .strict();

export const InstructionProvenanceSchema = z
  .object({
    instructionId: StableIdentifierSchema,
    source: z.enum(["system_policy", "repository_policy", "project_policy", "user"]),
    contentHash: Sha256Schema,
    receivedAt: IsoTimestampSchema
  })
  .strict();

/**
 * The contentHash covers the canonical contract payload with contentHash omitted.
 * Instruction bodies are deliberately excluded; provenance retains only stable IDs and hashes.
 */
export const TaskContractSchema = z
  .object({
    schemaVersion: z.literal(1),
    id: StableIdentifierSchema,
    projectId: StableIdentifierSchema,
    contentHash: Sha256Schema,
    goal: BoundedTextSchema,
    normalizedUserIntent: BoundedTextSchema,
    acceptanceCriteria: z.array(AcceptanceCriterionSchema).min(1).max(64),
    constraints: z.array(BoundedTextSchema).max(64),
    nonGoals: z.array(BoundedTextSchema).max(64),
    requiredDeliverables: z.array(RequiredDeliverableSchema).max(32),
    riskPolicy: TaskRiskPolicySchema,
    approvalRequirements: z.array(ApprovalRequirementSchema).max(16),
    resourceBudget: ResourceBudgetSchema,
    deadline: IsoTimestampSchema.optional(),
    instructionProvenance: z.array(InstructionProvenanceSchema).min(1).max(64),
    createdAt: IsoTimestampSchema
  })
  .strict()
  .superRefine((contract, context) => {
    addDuplicateIssues(
      contract.acceptanceCriteria.map((criterion) => criterion.id),
      context,
      "acceptanceCriteria"
    );
    addDuplicateIssues(
      contract.requiredDeliverables.map((deliverable) => deliverable.id),
      context,
      "requiredDeliverables"
    );
    addDuplicateIssues(
      contract.approvalRequirements.map((requirement) => requirement.id),
      context,
      "approvalRequirements"
    );
    addDuplicateIssues(
      contract.instructionProvenance.map((provenance) => provenance.instructionId),
      context,
      "instructionProvenance"
    );
    if (contract.deadline && Date.parse(contract.deadline) < Date.parse(contract.createdAt)) {
      context.addIssue({ code: "custom", path: ["deadline"], message: "The deadline cannot precede contract creation." });
    }
  });

type ParsedTaskContract = z.infer<typeof TaskContractSchema>;
declare const verifiedTaskContract: unique symbol;
export type TaskContract = DeepReadonly<ParsedTaskContract> & { readonly [verifiedTaskContract]: true };

export function parseTaskContract(input: unknown, hasher: CanonicalHasher): TaskContract {
  const contract = TaskContractSchema.parse(input);
  assertCanonicalHash("TaskContract", contract.contentHash, taskContractHashPayload(contract), hasher);
  return deepFreeze(contract) as TaskContract;
}

export function taskContractHashPayload(contract: ParsedTaskContract): Omit<ParsedTaskContract, "contentHash"> {
  const { contentHash, ...payload } = contract;
  void contentHash;
  return payload;
}
