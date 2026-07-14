import { z } from "zod";
import {
  ContextArtifactHandleSchema,
  ContextPackBudgetSchema,
  ContextPackReceiptsSchema,
  ContextSha256Schema,
  ContextStableIdentifierSchema
} from "./contextPackValidation.js";
import { CONTEXT_SECTION_ORDER, type ContextPack } from "./contextTypes.js";
import { ContextRunStateSchema } from "./contextRunState.js";
import { ContextProviderCapabilityReceiptSchema, providerCapabilityProfilePayload } from "./contextProviderCapabilities.js";

interface PersistenceHasher {
  sha256Canonical(value: unknown): string;
}

const MAX_PERSISTED_RECEIPT_ARRAY_LENGTH = 512;
const MAX_PERSISTED_RECEIPT_BYTES = 1024 * 1024;

const SectionKindSchema = z.enum(CONTEXT_SECTION_ORDER);
const TrustSchema = z.enum(["system", "project", "verified", "tool", "untrusted", "stale"]);
const NonnegativeIntegerSchema = z.number().int().safe().nonnegative();
const SectionReceiptSchema = z
  .object({
    kind: SectionKindSchema,
    requestedTokens: NonnegativeIntegerSchema,
    allocatedTokens: NonnegativeIntegerSchema,
    usedTokens: NonnegativeIntegerSchema,
    allocatedChars: NonnegativeIntegerSchema,
    usedChars: NonnegativeIntegerSchema,
    entries: z
      .array(
        z
          .object({
            id: ContextStableIdentifierSchema,
            contentHash: ContextSha256Schema,
            priority: z.number().finite(),
            trust: TrustSchema,
            markers: z.array(z.literal("STALE_MEMORY_REVALIDATION_REQUIRED")).max(1),
            sourceRefs: z.array(ContextStableIdentifierSchema).max(128),
            artifactHandle: ContextArtifactHandleSchema.optional(),
            toolName: z.string().min(1).optional(),
            skillId: ContextStableIdentifierSchema.optional()
          })
          .strict()
      )
      .max(MAX_PERSISTED_RECEIPT_ARRAY_LENGTH)
  })
  .strict();

const PersistenceBaseSchema = z
  .object({
    persistenceVersion: z.literal(1),
    contentStored: z.literal(false),
    schemaVersion: z.literal(1),
    compilerVersion: z.literal("context-compiler-v1"),
    id: ContextStableIdentifierSchema,
    canonicalHash: ContextSha256Schema,
    runId: ContextStableIdentifierSchema,
    projectId: ContextStableIdentifierSchema,
    stateRevision: NonnegativeIntegerSchema,
    task: z.object({ id: ContextStableIdentifierSchema, contentHash: ContextSha256Schema }).strict(),
    runState: ContextRunStateSchema,
    provider: z
      .object({
        providerId: ContextStableIdentifierSchema,
        modelId: z.string().min(1),
        capabilityReceipt: ContextProviderCapabilityReceiptSchema
      })
      .strict(),
    sections: z.array(SectionReceiptSchema).length(CONTEXT_SECTION_ORDER.length),
    artifactHandles: z.array(ContextArtifactHandleSchema).max(MAX_PERSISTED_RECEIPT_ARRAY_LENGTH),
    selectedMemoryIds: z.array(ContextStableIdentifierSchema).max(MAX_PERSISTED_RECEIPT_ARRAY_LENGTH),
    selectedSkillVersions: z
      .array(z.object({ id: ContextStableIdentifierSchema, version: z.string().min(1), contentHash: ContextSha256Schema }).strict())
      .max(MAX_PERSISTED_RECEIPT_ARRAY_LENGTH),
    selectedToolSpecVersions: z
      .array(z.object({ name: z.string().min(1), version: z.string().min(1), inputContractHash: ContextSha256Schema }).strict())
      .max(MAX_PERSISTED_RECEIPT_ARRAY_LENGTH),
    evidenceIds: z.array(ContextStableIdentifierSchema).max(MAX_PERSISTED_RECEIPT_ARRAY_LENGTH),
    artifactIds: z.array(ContextStableIdentifierSchema).max(MAX_PERSISTED_RECEIPT_ARRAY_LENGTH),
    budget: ContextPackBudgetSchema,
    receipts: ContextPackReceiptsSchema,
    finalInputHash: ContextSha256Schema,
    createdAt: z.string().refine((value) => Number.isFinite(Date.parse(value)), "ContextPack createdAt must be ISO-8601 compatible.")
  })
  .strict();

const PersistenceBodySchema = PersistenceBaseSchema.superRefine(assertPersistenceConsistency);
export const ContextPackPersistenceReceiptSchema = PersistenceBaseSchema.extend({ receiptHash: ContextSha256Schema })
  .strict()
  .superRefine(assertPersistenceConsistency);
export type ContextPackPersistenceReceipt = z.infer<typeof ContextPackPersistenceReceiptSchema>;

export function createContextPackPersistenceReceipt(pack: ContextPack, hasher: PersistenceHasher): ContextPackPersistenceReceipt {
  if (hasher.sha256Canonical(providerCapabilityProfilePayload(pack.provider.capabilityReceipt)) !== pack.provider.capabilityReceipt.contentHash) {
    throw new Error("ContextPack provider capability receipt hash verification failed before persistence.");
  }
  const body = PersistenceBodySchema.parse({
    persistenceVersion: 1,
    contentStored: false,
    schemaVersion: pack.schemaVersion,
    compilerVersion: pack.compilerVersion,
    id: pack.id,
    canonicalHash: pack.canonicalHash,
    runId: pack.runId,
    projectId: pack.projectId,
    stateRevision: pack.stateRevision,
    task: pack.task,
    runState: pack.runState,
    provider: pack.provider,
    sections: pack.sections.map(({ entries, ...section }) => ({
      ...section,
      entries: entries.map(({ content, ...entry }) => ({ ...entry, contentHash: hasher.sha256Canonical(content) }))
    })),
    artifactHandles: pack.artifactHandles,
    selectedMemoryIds: pack.selectedMemoryIds,
    selectedSkillVersions: pack.selectedSkillVersions,
    selectedToolSpecVersions: pack.selectedToolSpecVersions,
    evidenceIds: pack.evidenceIds,
    artifactIds: pack.artifactIds,
    budget: pack.budget,
    receipts: pack.receipts,
    finalInputHash: pack.finalInputHash,
    createdAt: pack.createdAt
  });
  return deepFreeze(ContextPackPersistenceReceiptSchema.parse({ ...body, receiptHash: hasher.sha256Canonical(body) }));
}

export function parseContextPackPersistenceReceipt(value: unknown, hasher: PersistenceHasher): ContextPackPersistenceReceipt {
  const receipt = ContextPackPersistenceReceiptSchema.parse(value);
  if (hasher.sha256Canonical(providerCapabilityProfilePayload(receipt.provider.capabilityReceipt)) !== receipt.provider.capabilityReceipt.contentHash) {
    throw new Error("Persisted provider capability receipt hash verification failed.");
  }
  const { receiptHash, ...body } = receipt;
  if (hasher.sha256Canonical(body) !== receiptHash) throw new Error("Persisted ContextPack receipt hash verification failed.");
  return deepFreeze(receipt);
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function assertPersistenceConsistency(receipt: z.infer<typeof PersistenceBaseSchema>, context: z.RefinementCtx): void {
  assertPersistenceBounds(receipt, context);
  if (receipt.runState.revision !== receipt.stateRevision) {
    context.addIssue({ code: "custom", path: ["runState", "revision"], message: "Persisted ContextPack revision mismatch." });
  }
  if (receipt.runState.runId !== receipt.runId || receipt.runState.projectId !== receipt.projectId) {
    context.addIssue({ code: "custom", path: ["runState"], message: "Persisted ContextPack run-state ownership mismatch." });
  }
  if (receipt.runState.taskContractId !== receipt.task.id || receipt.runState.taskContractHash !== receipt.task.contentHash) {
    context.addIssue({ code: "custom", path: ["runState", "taskContractId"], message: "Persisted ContextPack task binding mismatch." });
  }
  if (receipt.sections.some((section, index) => section.kind !== CONTEXT_SECTION_ORDER[index])) {
    context.addIssue({ code: "custom", path: ["sections"], message: "Persisted ContextPack sections must use canonical order." });
  }
}

function assertPersistenceBounds(receipt: z.infer<typeof PersistenceBaseSchema>, context: z.RefinementCtx): void {
  if (new TextEncoder().encode(JSON.stringify(receipt)).byteLength > MAX_PERSISTED_RECEIPT_BYTES) {
    context.addIssue({ code: "custom", path: [], message: "Persisted ContextPack receipt exceeds its serialized byte limit." });
  }
}
