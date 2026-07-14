import { z } from "zod";
import { BooleanMeasurementSchema, NumericMeasurementSchema } from "./measurementSchemas.js";

export { BooleanMeasurementSchema, NumericMeasurementSchema } from "./measurementSchemas.js";

const StableIdSchema = z
  .string()
  .min(1)
  .max(160)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/);
const HashSchema = z.string().regex(/^[a-f0-9]{64}$/);
const GitShaSchema = z.string().regex(/^[a-f0-9]{40}$/);
const RelativePathSchema = z
  .string()
  .min(1)
  .max(500)
  .refine(
    (value) => !value.includes("\\") && !value.startsWith("/") && !/^[a-zA-Z]:/.test(value) && !value.split("/").includes(".."),
    "Fixture path must be project-relative."
  );
const NonEmptyTextSchema = z.string().trim().min(1).max(2_000);

export const EvalSuiteSchema = z.enum([
  "tool-discovery",
  "tool-composition",
  "long-horizon-resume",
  "memory-scope",
  "memory-freshness",
  "tool-output-injection",
  "engineering-agent",
  "research-agent",
  "multi-agent-conflict",
  "idempotent-side-effects"
]);

export const HarnessCapabilitySchema = z.enum([
  "tool_catalog",
  "tool_execution",
  "durable_state",
  "memory_read",
  "memory_write",
  "network",
  "filesystem_read",
  "filesystem_write",
  "multi_agent",
  "external_side_effect"
]);

export const EvalClassificationSchema = z.enum(["seed", "held_out", "adversarial", "regression"]);

export const SafetyPropertySchema = z.enum([
  "no_unauthorized_tool_execution",
  "no_duplicate_side_effects",
  "no_cross_project_memory",
  "no_stale_memory_action",
  "no_prompt_injection_compliance",
  "no_secret_leakage",
  "no_unverified_result_promotion"
]);

export const InputFixtureSchema = z
  .object({
    id: StableIdSchema,
    kind: z.enum(["artifact", "dataset", "repository", "memory_snapshot", "trace"]),
    relativePath: RelativePathSchema,
    sha256: HashSchema,
    bytes: z.number().int().nonnegative(),
    provenance: z
      .object({
        sourceKind: z.enum(["immutable_fixture", "sanitized_regression", "generated_manifest"]),
        sourceId: StableIdSchema,
        license: NonEmptyTextSchema.optional()
      })
      .strict(),
    sensitivity: z.enum(["public", "internal", "restricted"]),
    projectId: StableIdSchema.optional()
  })
  .strict();

export const EvalTaskContractSchema = z
  .object({
    id: StableIdSchema,
    schemaVersion: z.literal(1),
    goal: NonEmptyTextSchema,
    acceptanceCriterionIds: z.array(StableIdSchema).min(1).max(32),
    constraints: z.array(NonEmptyTextSchema).max(32),
    nonGoals: z.array(NonEmptyTextSchema).max(32),
    requiredDeliverables: z.array(StableIdSchema).max(16)
  })
  .strict();

export const EvalBudgetSchema = z
  .object({
    maxDurationMs: z.number().int().positive().max(3_600_000),
    maxInputTokens: z.number().int().nonnegative(),
    maxOutputTokens: z.number().int().nonnegative(),
    maxToolCalls: z.number().int().nonnegative().max(1_000),
    maxRetries: z.number().int().nonnegative().max(100),
    maxEstimatedCostUsd: z.number().nonnegative().finite(),
    maxToolOutputBytes: z.number().int().nonnegative(),
    maxConcurrency: z.number().int().positive().max(16)
  })
  .strict();

const EventPresentCriterionSchema = z
  .object({
    id: StableIdSchema,
    description: NonEmptyTextSchema,
    kind: z.literal("event_present"),
    eventType: NonEmptyTextSchema,
    minimumCount: z.number().int().positive().default(1)
  })
  .strict();

const ToolCriterionSchema = z
  .object({
    id: StableIdSchema,
    description: NonEmptyTextSchema,
    kind: z.enum(["tool_selected", "tool_not_selected", "tool_verified"]),
    toolName: StableIdSchema
  })
  .strict();

const ReplayCriterionSchema = z
  .object({
    id: StableIdSchema,
    description: NonEmptyTextSchema,
    kind: z.enum(["no_duplicate_side_effects", "no_unverified_promotion", "recovery_selected"])
  })
  .strict();

const MemoryScopeCriterionSchema = z
  .object({
    id: StableIdSchema,
    description: NonEmptyTextSchema,
    kind: z.literal("memory_scope"),
    scope: z.enum(["run", "project", "user"])
  })
  .strict();

const MemoryRevalidatedCriterionSchema = z
  .object({
    id: StableIdSchema,
    description: NonEmptyTextSchema,
    kind: z.literal("memory_revalidated"),
    expectedValid: z.boolean()
  })
  .strict();

const WorkOrderCriterionSchema = z
  .object({
    id: StableIdSchema,
    description: NonEmptyTextSchema,
    kind: z.literal("work_order_outcome"),
    outcome: z.enum(["completed", "failed", "blocked", "cancelled"]),
    minimumCount: z.number().int().positive().default(1),
    reasonCode: StableIdSchema.optional(),
    requiresOverlappingWriteOwner: z.boolean().optional()
  })
  .strict()
  .superRefine((criterion, context) => {
    if (criterion.requiresOverlappingWriteOwner && (criterion.outcome !== "blocked" || criterion.reasonCode !== "WRITE_SCOPE_CONFLICT")) {
      context.addIssue({
        code: "custom",
        path: ["requiresOverlappingWriteOwner"],
        message: "Overlapping-write criteria require blocked/WRITE_SCOPE_CONFLICT semantics."
      });
    }
  });

export const DeterministicAcceptanceCriterionSchema = z.discriminatedUnion("kind", [
  EventPresentCriterionSchema,
  ToolCriterionSchema,
  ReplayCriterionSchema,
  MemoryScopeCriterionSchema,
  MemoryRevalidatedCriterionSchema,
  WorkOrderCriterionSchema
]);

export const ModelGraderRubricSchema = z
  .object({
    version: StableIdSchema,
    independentProviderRequired: z.literal(true),
    dimensions: z
      .array(z.object({ id: StableIdSchema, description: NonEmptyTextSchema, maxScore: z.number().int().positive().max(100) }).strict())
      .min(1)
      .max(16)
  })
  .strict();

export const EvalCaseSchema = z
  .object({
    schemaVersion: z.literal(1),
    caseVersion: z.string().regex(/^\d+\.\d+\.\d+$/),
    id: StableIdSchema,
    suite: EvalSuiteSchema,
    objective: NonEmptyTextSchema,
    inputFixtures: z.array(InputFixtureSchema).max(32),
    taskContract: EvalTaskContractSchema,
    environmentCapabilities: z.array(HarnessCapabilitySchema).min(1),
    allowedTools: z.array(StableIdSchema).max(1_000),
    prohibitedTools: z.array(StableIdSchema).max(1_000),
    budget: EvalBudgetSchema,
    deterministicAcceptanceCriteria: z.array(DeterministicAcceptanceCriterionSchema).min(1).max(64),
    taskContractHash: HashSchema,
    acceptanceCriteriaHash: HashSchema,
    expectedOutcome: z.enum(["passed", "failed", "blocked"]),
    deterministicGrader: z.object({ version: StableIdSchema, contentHash: HashSchema }).strict(),
    modelGraderRubric: ModelGraderRubricSchema.optional(),
    expectedSafetyProperties: z.array(SafetyPropertySchema).min(1),
    classification: EvalClassificationSchema,
    heldOutPartition: z.object({ executionFixtureHash: HashSchema, oracleFixtureHash: HashSchema }).strict().optional(),
    seed: z.number().int().nonnegative()
  })
  .strict()
  .superRefine((value, context) => {
    const prohibited = new Set(value.prohibitedTools);
    for (const toolName of value.allowedTools) {
      if (prohibited.has(toolName)) context.addIssue({ code: "custom", path: ["allowedTools"], message: `Tool is both allowed and prohibited: ${toolName}` });
    }
    const criterionIds = value.deterministicAcceptanceCriteria.map((criterion) => criterion.id);
    if (new Set(criterionIds).size !== criterionIds.length) {
      context.addIssue({ code: "custom", path: ["deterministicAcceptanceCriteria"], message: "Acceptance criterion IDs must be unique." });
    }
    const contractIds = new Set(value.taskContract.acceptanceCriterionIds);
    for (const criterionId of criterionIds) {
      if (!contractIds.has(criterionId))
        context.addIssue({ code: "custom", path: ["taskContract", "acceptanceCriterionIds"], message: `Missing criterion reference: ${criterionId}` });
    }
    if (value.classification === "held_out" && !value.heldOutPartition) {
      context.addIssue({ code: "custom", path: ["heldOutPartition"], message: "Held-out cases require separate execution and oracle fixture hashes." });
    }
    if (value.classification !== "held_out" && value.heldOutPartition) {
      context.addIssue({ code: "custom", path: ["heldOutPartition"], message: "Only held-out cases may reference held-out partitions." });
    }
  });

export const EvalExecutionCaseSchema = z
  .object({
    schemaVersion: z.literal(1),
    caseVersion: z.string().regex(/^\d+\.\d+\.\d+$/),
    id: StableIdSchema,
    suite: EvalSuiteSchema,
    objective: NonEmptyTextSchema,
    inputFixtures: z.array(InputFixtureSchema).max(32),
    taskContract: z.object({ id: StableIdSchema, contentHash: HashSchema }).strict(),
    environmentCapabilities: z.array(HarnessCapabilitySchema).min(1),
    allowedTools: z.array(StableIdSchema).max(1_000),
    prohibitedTools: z.array(StableIdSchema).max(1_000),
    budget: EvalBudgetSchema,
    classification: EvalClassificationSchema,
    heldOutExecutionFixtureHash: HashSchema.optional(),
    seed: z.number().int().nonnegative()
  })
  .strict()
  .superRefine((value, context) => {
    if (value.classification === "held_out" && !value.heldOutExecutionFixtureHash) {
      context.addIssue({ code: "custom", path: ["heldOutExecutionFixtureHash"], message: "Held-out execution inputs require their execution-fixture hash." });
    }
    if (value.classification !== "held_out" && value.heldOutExecutionFixtureHash) {
      context.addIssue({
        code: "custom",
        path: ["heldOutExecutionFixtureHash"],
        message: "Only held-out execution inputs may include a held-out fixture hash."
      });
    }
  });

export const EvalOracleSchema = z
  .object({
    schemaVersion: z.literal(1),
    caseId: StableIdSchema,
    taskContract: EvalTaskContractSchema,
    taskContractHash: HashSchema,
    deterministicAcceptanceCriteria: z.array(DeterministicAcceptanceCriterionSchema).min(1).max(64),
    acceptanceCriteriaHash: HashSchema,
    expectedOutcome: z.enum(["passed", "failed", "blocked"]),
    deterministicGrader: z.object({ version: StableIdSchema, contentHash: HashSchema }).strict(),
    modelGraderRubric: ModelGraderRubricSchema.optional(),
    expectedSafetyProperties: z.array(SafetyPropertySchema).min(1),
    heldOutOracleFixtureHash: HashSchema.optional()
  })
  .strict();

export const AcceptanceResultSchema = z
  .object({
    criterionId: StableIdSchema,
    passed: z.boolean(),
    message: NonEmptyTextSchema,
    evidenceEventIds: z.array(z.string().uuid()).max(128),
    graderVersion: StableIdSchema,
    graderHash: HashSchema
  })
  .strict();

const faultReceiptSchema = z.object({ target: StableIdSchema, occurrence: z.number().int().positive(), outcome: StableIdSchema }).strict();

export const EvalRunSchema = z
  .object({
    schemaVersion: z.literal(1),
    id: z.string().uuid(),
    caseId: StableIdSchema,
    suite: EvalSuiteSchema,
    evidenceClass: z.literal("deterministic_test_runtime"),
    productionSuccessEligible: z.literal(false),
    productOutcome: z.literal("not_evaluated"),
    subject: z.object({ baseSha: GitShaSchema, headSha: GitShaSchema, dirtyDiffHash: HashSchema }).strict(),
    harnessVersion: StableIdSchema,
    evaluatorVersion: StableIdSchema,
    evaluatorHash: HashSchema,
    providerAdapter: StableIdSchema,
    modelIdentifier: StableIdSchema,
    seed: z.number().int().nonnegative(),
    taskContractHash: HashSchema,
    contextPackHashes: z.array(HashSchema),
    toolSpecVersions: z.record(StableIdSchema, StableIdSchema),
    memorySnapshotVersion: StableIdSchema,
    skillVersions: z.record(StableIdSchema, StableIdSchema),
    expectedOutcome: z.enum(["passed", "failed", "blocked"]),
    heldOutPartition: z.object({ executionFixtureHash: HashSchema, oracleFixtureHash: HashSchema }).strict().optional(),
    result: z.enum(["passed", "failed", "blocked", "infrastructure_failure"]),
    metrics: z
      .object({
        durationMs: NumericMeasurementSchema,
        inputTokens: NumericMeasurementSchema,
        outputTokens: NumericMeasurementSchema,
        contextTokens: NumericMeasurementSchema,
        toolCalls: NumericMeasurementSchema,
        retries: NumericMeasurementSchema,
        estimatedCostUsd: NumericMeasurementSchema,
        humanIntervention: BooleanMeasurementSchema,
        invalidArguments: NumericMeasurementSchema,
        duplicateSideEffects: NumericMeasurementSchema,
        totalToolOutputBytes: NumericMeasurementSchema,
        restartRecovered: BooleanMeasurementSchema,
        peakConcurrency: NumericMeasurementSchema
      })
      .strict(),
    acceptanceResults: z.array(AcceptanceResultSchema).min(1),
    trace: z
      .object({
        eventCount: z.number().int().positive(),
        rootHash: HashSchema,
        canonicalStateHash: HashSchema,
        canonicalTraceHash: HashSchema,
        normalizedDuplicateDeliveries: z.number().int().nonnegative(),
        redactionReceipt: z
          .object({
            policyVersion: StableIdSchema,
            status: z.literal("not_performed_structured_input"),
            removedFieldCount: z.null(),
            unmeasuredReason: NonEmptyTextSchema,
            structuredEnvelopeHash: HashSchema
          })
          .strict()
      })
      .strict(),
    faults: z.object({ planned: z.array(faultReceiptSchema), triggered: z.array(faultReceiptSchema) }).strict(),
    infrastructureFailure: z.object({ code: StableIdSchema, message: NonEmptyTextSchema }).strict().optional()
  })
  .strict()
  .superRefine((run, context) => {
    if (run.result === "infrastructure_failure" && !run.infrastructureFailure) {
      context.addIssue({ code: "custom", path: ["infrastructureFailure"], message: "Infrastructure failures require a structured failure." });
    }
    if (run.result !== "infrastructure_failure" && run.infrastructureFailure) {
      context.addIssue({ code: "custom", path: ["infrastructureFailure"], message: "Only infrastructure failures may carry infrastructureFailure." });
    }
  });

export type EvalSuite = z.infer<typeof EvalSuiteSchema>;
export type HarnessCapability = z.infer<typeof HarnessCapabilitySchema>;
export type EvalClassification = z.infer<typeof EvalClassificationSchema>;
export type SafetyProperty = z.infer<typeof SafetyPropertySchema>;
export type EvalCase = z.infer<typeof EvalCaseSchema>;
export type EvalExecutionCase = z.infer<typeof EvalExecutionCaseSchema>;
export type EvalOracle = z.infer<typeof EvalOracleSchema>;
export type DeterministicAcceptanceCriterion = z.infer<typeof DeterministicAcceptanceCriterionSchema>;
export type AcceptanceResult = z.infer<typeof AcceptanceResultSchema>;
export type EvalRun = z.infer<typeof EvalRunSchema>;
