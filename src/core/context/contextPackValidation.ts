import { z } from "zod";
import { CONTEXT_SECTION_ORDER, type ContextPack } from "./contextTypes.js";
import { ContextRunStateSchema } from "./contextRunState.js";
import { ContextProviderCapabilityReceiptSchema, providerCapabilityProfilePayload } from "./contextProviderCapabilities.js";

export const ContextStableIdentifierSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/);
export const ContextSha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const StableIdentifierSchema = ContextStableIdentifierSchema;
const Sha256Schema = ContextSha256Schema;
const NonnegativeIntegerSchema = z.number().int().safe().nonnegative();
const TrustSchema = z.enum(["system", "project", "verified", "tool", "untrusted", "stale"]);
const SectionKindSchema = z.enum(CONTEXT_SECTION_ORDER);
const MAX_CONTEXT_RECEIPT_ITEMS = 512;

const CandidateSelectionReceiptSchema = z
  .object({
    source: z.enum(["snapshot.global_memory_items", "snapshot.conversation_artifacts"]),
    status: z.enum(["selected", "empty"]),
    candidateCount: NonnegativeIntegerSchema,
    selectedIds: z.array(StableIdentifierSchema).max(MAX_CONTEXT_RECEIPT_ITEMS),
    omittedCount: NonnegativeIntegerSchema,
    emptyReason: z.enum(["no_project_validated_candidates", "no_hash_bearing_conversation_artifacts"]).optional()
  })
  .strict();

export const ContextArtifactHandleSchema = z
  .object({
    artifactId: StableIdentifierSchema,
    kind: z.string().min(1),
    sha256: Sha256Schema
  })
  .strict();
const ArtifactHandleSchema = ContextArtifactHandleSchema;

const ContextEntrySchema = z
  .object({
    id: StableIdentifierSchema,
    content: z.string(),
    priority: z.number().finite(),
    trust: TrustSchema,
    markers: z.array(z.literal("STALE_MEMORY_REVALIDATION_REQUIRED")),
    sourceRefs: z.array(StableIdentifierSchema),
    artifactHandle: ArtifactHandleSchema.optional(),
    toolName: z.string().min(1).optional(),
    skillId: StableIdentifierSchema.optional()
  })
  .strict();

const ContextSectionSchema = z
  .object({
    kind: SectionKindSchema,
    requestedTokens: NonnegativeIntegerSchema,
    allocatedTokens: NonnegativeIntegerSchema,
    usedTokens: NonnegativeIntegerSchema,
    allocatedChars: NonnegativeIntegerSchema,
    usedChars: NonnegativeIntegerSchema,
    entries: z.array(ContextEntrySchema)
  })
  .strict();

const BudgetSectionSchema = z
  .object({
    requestedTokens: NonnegativeIntegerSchema,
    allocatedTokens: NonnegativeIntegerSchema,
    usedTokens: NonnegativeIntegerSchema,
    allocatedChars: NonnegativeIntegerSchema,
    usedChars: NonnegativeIntegerSchema
  })
  .strict();

export const ContextPackBudgetSchema = z
  .object({
    tokenBudget: NonnegativeIntegerSchema,
    usedTokens: NonnegativeIntegerSchema,
    maxChars: NonnegativeIntegerSchema,
    usedChars: NonnegativeIntegerSchema,
    reservedSeparatorTokens: NonnegativeIntegerSchema,
    reservedSeparatorChars: NonnegativeIntegerSchema,
    tokenEstimator: z.literal("utf8_bytes_upper_bound_v1"),
    countingMethod: z.literal("utf16_code_units_v1"),
    sections: z
      .object({
        task: BudgetSectionSchema,
        run_state: BudgetSectionSchema,
        instructions: BudgetSectionSchema,
        evidence: BudgetSectionSchema,
        memory: BudgetSectionSchema,
        skill: BudgetSectionSchema,
        tools: BudgetSectionSchema,
        artifacts: BudgetSectionSchema,
        history: BudgetSectionSchema
      })
      .strict()
  })
  .strict();

export const ContextPackReceiptsSchema = z
  .object({
    deduplications: z.array(z.object({ keptId: StableIdentifierSchema, droppedId: StableIdentifierSchema }).strict()).max(MAX_CONTEXT_RECEIPT_ITEMS),
    redactions: z
      .array(
        z
          .object({
            entryId: StableIdentifierSchema,
            replacements: NonnegativeIntegerSchema,
            categories: z.array(z.string().min(1)).max(32)
          })
          .strict()
      )
      .max(MAX_CONTEXT_RECEIPT_ITEMS),
    truncations: z
      .array(
        z
          .object({
            section: SectionKindSchema,
            entryId: StableIdentifierSchema,
            originalChars: NonnegativeIntegerSchema,
            includedChars: NonnegativeIntegerSchema,
            requestedTokens: NonnegativeIntegerSchema,
            allocatedTokens: NonnegativeIntegerSchema,
            usedTokens: NonnegativeIntegerSchema,
            reason: z.literal("section_budget")
          })
          .strict()
      )
      .max(MAX_CONTEXT_RECEIPT_ITEMS),
    removedTools: z
      .array(z.object({ name: z.string().min(1), version: z.string().min(1), reason: z.literal("not_available") }).strict())
      .max(MAX_CONTEXT_RECEIPT_ITEMS),
    omittedPriorOutputs: z
      .array(z.object({ outputId: StableIdentifierSchema, reason: z.literal("artifact_handles_only") }).strict())
      .max(MAX_CONTEXT_RECEIPT_ITEMS),
    candidateSelections: z.object({ memory: CandidateSelectionReceiptSchema, priorOutputs: CandidateSelectionReceiptSchema }).strict(),
    recentConversation: z
      .object({
        source: z.literal("bounded_derived_cache"),
        cacheVersion: StableIdentifierSchema,
        canonicalStateAuthority: z.literal(false),
        contentStored: z.literal(false),
        candidateCount: NonnegativeIntegerSchema.max(16),
        selectedIds: z.array(StableIdentifierSchema).max(16),
        omittedCount: NonnegativeIntegerSchema.max(16),
        entryHashes: z.array(z.object({ id: StableIdentifierSchema, contentHash: Sha256Schema }).strict()).max(16)
      })
      .strict()
      .optional()
  })
  .strict();

export const ContextPackSchema = z
  .object({
    schemaVersion: z.literal(1),
    compilerVersion: z.literal("context-compiler-v1"),
    runId: StableIdentifierSchema,
    projectId: StableIdentifierSchema,
    stateRevision: NonnegativeIntegerSchema,
    task: z.object({ id: StableIdentifierSchema, contentHash: Sha256Schema }).strict(),
    runState: ContextRunStateSchema,
    provider: z.object({ providerId: StableIdentifierSchema, modelId: z.string().min(1), capabilityReceipt: ContextProviderCapabilityReceiptSchema }).strict(),
    sections: z.array(ContextSectionSchema).length(CONTEXT_SECTION_ORDER.length),
    providerInput: z.string(),
    availableTools: z.array(
      z
        .object({
          name: z.string().min(1),
          version: z.string().min(1),
          summary: z.string(),
          inputContractHash: Sha256Schema
        })
        .strict()
    ),
    artifactHandles: z.array(ArtifactHandleSchema),
    selectedMemoryIds: z.array(StableIdentifierSchema),
    selectedSkillVersions: z.array(z.object({ id: StableIdentifierSchema, version: z.string().min(1), contentHash: Sha256Schema }).strict()),
    selectedToolSpecVersions: z.array(z.object({ name: z.string().min(1), version: z.string().min(1), inputContractHash: Sha256Schema }).strict()),
    evidenceIds: z.array(StableIdentifierSchema),
    artifactIds: z.array(StableIdentifierSchema),
    budget: ContextPackBudgetSchema,
    receipts: ContextPackReceiptsSchema,
    finalInputHash: Sha256Schema,
    createdAt: z.string().refine((value) => Number.isFinite(Date.parse(value)), "ContextPack createdAt must be ISO-8601 compatible."),
    id: StableIdentifierSchema,
    canonicalHash: Sha256Schema
  })
  .strict()
  .superRefine((pack, context) => {
    if (pack.runState.revision !== pack.stateRevision) {
      context.addIssue({ code: "custom", path: ["runState", "revision"], message: "ContextPack run-state revision must match its envelope." });
    }
    if (pack.runState.runId !== pack.runId || pack.runState.projectId !== pack.projectId) {
      context.addIssue({ code: "custom", path: ["runState"], message: "ContextPack run-state ownership must match its envelope." });
    }
    if (pack.runState.taskContractId !== pack.task.id || pack.runState.taskContractHash !== pack.task.contentHash) {
      context.addIssue({ code: "custom", path: ["runState", "taskContractId"], message: "ContextPack run-state task binding must match its envelope." });
    }
    if (pack.sections.some((section, index) => section.kind !== CONTEXT_SECTION_ORDER[index])) {
      context.addIssue({ code: "custom", path: ["sections"], message: "ContextPack sections must use canonical order." });
    }
    if (pack.budget.usedTokens > pack.budget.tokenBudget || pack.budget.usedChars > pack.budget.maxChars) {
      context.addIssue({ code: "custom", path: ["budget"], message: "ContextPack budget usage exceeds its limits." });
    }
  });

export interface ContextPackCanonicalHasher {
  sha256Canonical(value: unknown): string;
  sha256Text(value: string): string;
}

export function parseContextPack(input: unknown, hasher: ContextPackCanonicalHasher): ContextPack {
  const pack = ContextPackSchema.parse(input);
  if (hasher.sha256Canonical(providerCapabilityProfilePayload(pack.provider.capabilityReceipt)) !== pack.provider.capabilityReceipt.contentHash) {
    throw new Error("ContextPack provider capability receipt hash verification failed.");
  }
  if (hasher.sha256Text(pack.providerInput) !== pack.finalInputHash) throw new Error("ContextPack final input hash verification failed.");
  const { id, canonicalHash, ...body } = pack;
  const expectedHash = hasher.sha256Canonical(body);
  if (canonicalHash !== expectedHash || id !== `context-pack:${expectedHash.slice(0, 32)}`) {
    throw new Error("ContextPack canonical hash verification failed.");
  }
  return deepFreeze(pack) as ContextPack;
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}
