import { z } from "zod";
import type { EvalExecutionCase, HarnessCapability } from "./evalSchemas.js";
import { HarnessCapabilityError, HarnessError } from "./errors.js";
import { DeterministicFaultInjector, FaultProgramSchema, type FaultExecutionReceipt, type FaultProgram } from "./faultInjection.js";
import { DeterministicClock, DeterministicIdGenerator } from "./deterministicPrimitives.js";
import type { SideEffectReceipt } from "./traceSchemas.js";
import { assertOracleFreeExecutionPayload } from "./executionBoundary.js";

const StableIdSchema = z
  .string()
  .min(1)
  .max(160)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/);

export const TestToolDefinitionSchema = z
  .object({
    name: StableIdSchema,
    version: StableIdSchema,
    requiredCapabilities: z.array(
      z.enum([
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
      ])
    ),
    mutating: z.boolean(),
    sideEffect: z.boolean(),
    outputArtifactIds: z.array(StableIdSchema).max(128),
    outputBytes: z.number().int().nonnegative(),
    latencyMs: z.number().int().nonnegative()
  })
  .strict();

const PlannedCallSchema = z
  .object({
    callId: StableIdSchema,
    toolName: StableIdSchema,
    inputFixtureIds: z.array(StableIdSchema).max(32),
    dependencyCallIds: z.array(StableIdSchema).max(32),
    idempotencyKey: StableIdSchema.optional(),
    maxAttempts: z.number().int().positive().max(4),
    verifier: z.enum(["postcondition", "schema", "artifact_diff", "test", "query"]),
    verifierChecks: z.array(StableIdSchema).min(1).max(32)
  })
  .strict();

const PlannedMemorySchema = z
  .object({
    retrievals: z.array(
      z
        .object({
          records: z.array(z.object({ recordId: StableIdSchema, owningProjectId: StableIdSchema }).strict()),
          scope: z.enum(["run", "project", "user"]),
          selectionReasons: z.array(z.string().min(1).max(1_000))
        })
        .strict()
    ),
    revalidations: z.array(z.object({ recordId: StableIdSchema, valid: z.boolean(), reason: z.string().min(1).max(1_000) }).strict()),
    candidates: z.array(
      z
        .object({
          candidateId: StableIdSchema,
          sourceArtifactIds: z.array(StableIdSchema).min(1),
          scope: z.enum(["run", "project", "user"]),
          disposition: z.enum(["accepted", "rejected", "quarantined"]),
          policyReason: z.string().min(1).max(1_000)
        })
        .strict()
    )
  })
  .strict();

const PlannedWorkOrderSchema = z
  .object({
    workOrderId: StableIdSchema,
    readOnly: z.boolean(),
    scopeKeys: z.array(StableIdSchema).min(1),
    dependencyWorkOrderIds: z.array(StableIdSchema),
    outcome: z.enum(["completed", "failed", "blocked", "cancelled"]),
    reasonCode: StableIdSchema.optional(),
    conflictingWorkOrderId: StableIdSchema.optional()
  })
  .strict()
  .superRefine((workOrder, context) => {
    const isWriteConflict = workOrder.outcome === "blocked" && workOrder.reasonCode === "WRITE_SCOPE_CONFLICT";
    if (isWriteConflict !== Boolean(workOrder.conflictingWorkOrderId)) {
      context.addIssue({
        code: "custom",
        path: ["conflictingWorkOrderId"],
        message: "WRITE_SCOPE_CONFLICT plans must identify exactly one conflicting work-order owner."
      });
    }
    if (workOrder.outcome !== "completed" && !workOrder.reasonCode) {
      context.addIssue({ code: "custom", path: ["reasonCode"], message: "Non-completed work orders require a terminal reason code." });
    }
  });

export const DeterministicCasePlanSchema = z
  .object({
    schemaVersion: z.literal(1),
    caseId: StableIdSchema,
    candidates: z.array(StableIdSchema).max(1_000),
    calls: z.array(PlannedCallSchema).max(64),
    rejections: z.array(
      z
        .object({
          callId: StableIdSchema,
          toolName: StableIdSchema,
          reasonCode: z.enum(["prohibited", "capability_denied", "schema_invalid", "precondition_failed", "injection_detected"]),
          reason: z.string().min(1).max(1_000)
        })
        .strict()
    ),
    memory: PlannedMemorySchema,
    skills: z.array(z.object({ skillId: StableIdSchema, version: StableIdSchema, selectionReason: z.string().min(1).max(1_000) }).strict()),
    workOrders: z.array(PlannedWorkOrderSchema),
    faults: z.array(FaultProgramSchema),
    memorySnapshotVersion: StableIdSchema,
    inputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
    contextTokens: z.number().int().nonnegative(),
    loadedToolSchemaBytes: z.number().int().nonnegative()
  })
  .strict();

export type TestToolDefinition = z.infer<typeof TestToolDefinitionSchema>;
export type DeterministicCasePlan = z.infer<typeof DeterministicCasePlanSchema>;

export class DeterministicTestProvider {
  private readonly plans = new Map<string, DeterministicCasePlan>();
  private readonly consumed = new Set<string>();

  constructor(plans: readonly DeterministicCasePlan[]) {
    for (const candidate of plans) {
      const plan = DeterministicCasePlanSchema.parse(candidate);
      if (this.plans.has(plan.caseId)) throw new HarnessError("UNSUPPORTED_EVAL_CASE", `Duplicate deterministic case plan: ${plan.caseId}`);
      this.plans.set(plan.caseId, plan);
    }
  }

  plan(executionInput: EvalExecutionCase, availableTools: readonly string[]): DeterministicCasePlan {
    const execution = assertOracleFreeExecutionPayload(executionInput);
    const plan = this.plans.get(execution.id);
    if (!plan) throw new HarnessError("UNSUPPORTED_EVAL_CASE", `No deterministic provider plan exists for eval case: ${execution.id}`);
    const available = new Set(availableTools);
    const unsupported = [...plan.candidates, ...plan.calls.map((call) => call.toolName)].filter((toolName) => !available.has(toolName));
    if (unsupported.length) throw new HarnessError("UNSUPPORTED_TOOL", `Plan references unavailable tools: ${[...new Set(unsupported)].join(", ")}`);
    this.consumed.add(execution.id);
    return plan;
  }

  assertFullyConsumed(): void {
    const pending = [...this.plans.keys()].filter((caseId) => !this.consumed.has(caseId));
    if (pending.length) throw new HarnessError("UNCONSUMED_PLAN", `Deterministic provider plans were not consumed: ${pending.join(", ")}`);
  }
}

export interface DeterministicToolInvocation {
  runId: string;
  target: string;
  toolName: string;
  inputHash: string;
  idempotencyKey?: string;
  capabilities: readonly HarnessCapability[];
  allowedTools: readonly string[];
}

export interface DeterministicToolResult {
  outcome: "success" | "partial" | "transient_failure" | "permanent_failure";
  outputArtifactIds: string[];
  outputBytes: number;
  sideEffectReceipt?: SideEffectReceipt;
  failureCode?: string;
}

export class DeterministicToolProvider {
  private readonly definitions = new Map<string, TestToolDefinition>();
  private readonly sideEffectLedger = new Map<string, { inputHash: string; receiptId: string }>();
  private sideEffectExecutions = 0;

  constructor(
    definitions: readonly TestToolDefinition[],
    private readonly clock: DeterministicClock,
    private readonly ids: DeterministicIdGenerator,
    private readonly faults = new DeterministicFaultInjector()
  ) {
    for (const candidate of definitions) {
      const definition = TestToolDefinitionSchema.parse(candidate);
      if (this.definitions.has(definition.name)) throw new HarnessError("UNSUPPORTED_TOOL", `Duplicate deterministic tool: ${definition.name}`);
      this.definitions.set(definition.name, definition);
    }
  }

  describe(name: string): TestToolDefinition {
    const definition = this.definitions.get(name);
    if (!definition) throw new HarnessError("UNSUPPORTED_TOOL", `Unknown deterministic tool: ${name}`);
    return definition;
  }

  list(): TestToolDefinition[] {
    return [...this.definitions.values()].sort((left, right) => left.name.localeCompare(right.name));
  }

  async invoke(input: DeterministicToolInvocation): Promise<DeterministicToolResult> {
    const definition = this.describe(input.toolName);
    this.assertInvocationAllowed(definition, input);
    const fault = this.faults.consume(input.target);
    await this.clock.sleep(fault?.latencyMs ?? definition.latencyMs);
    if (!fault || fault.outcome.kind === "success") return this.successResult(definition, input);
    if (fault.outcome.kind === "partial_result") {
      return { outcome: "partial", outputArtifactIds: fault.outcome.outputArtifactIds, outputBytes: fault.outcome.outputBytes };
    }
    if (fault.outcome.kind === "side_effect_response_lost") {
      const receipt = this.sideEffectReceipt(definition, input, fault.outcome.receiptId);
      return { outcome: "transient_failure", outputArtifactIds: [], outputBytes: 0, sideEffectReceipt: receipt, failureCode: "RESPONSE_LOST" };
    }
    return { outcome: fault.outcome.kind, outputArtifactIds: [], outputBytes: 0, failureCode: fault.outcome.code };
  }

  sideEffectExecutionCount(): number {
    return this.sideEffectExecutions;
  }

  assertFaultsConsumed(): void {
    this.faults.assertFullyConsumed();
  }

  faultReceipts(): { planned: FaultExecutionReceipt[]; triggered: FaultExecutionReceipt[] } {
    return { planned: this.faults.plannedReceipts(), triggered: this.faults.triggeredReceipts() };
  }

  private assertInvocationAllowed(definition: TestToolDefinition, input: DeterministicToolInvocation): void {
    if (!input.allowedTools.includes(definition.name))
      throw new HarnessError("TOOL_INVOCATION_INVALID", `Tool is outside the eval allowlist: ${definition.name}`);
    const available = new Set(input.capabilities);
    const missing = definition.requiredCapabilities.filter((capability) => !available.has(capability));
    if (missing.length) throw new HarnessCapabilityError(missing);
    if (definition.mutating && !input.idempotencyKey)
      throw new HarnessError("TOOL_INVOCATION_INVALID", `Mutating tool requires an idempotency key: ${definition.name}`);
  }

  private successResult(definition: TestToolDefinition, input: DeterministicToolInvocation): DeterministicToolResult {
    const sideEffectReceipt = definition.sideEffect ? this.sideEffectReceipt(definition, input) : undefined;
    return {
      outcome: "success",
      outputArtifactIds: [...definition.outputArtifactIds],
      outputBytes: definition.outputBytes,
      ...(sideEffectReceipt ? { sideEffectReceipt } : {})
    };
  }

  private sideEffectReceipt(definition: TestToolDefinition, input: DeterministicToolInvocation, forcedReceiptId?: string): SideEffectReceipt {
    if (!definition.sideEffect || !input.idempotencyKey)
      throw new HarnessError("TOOL_INVOCATION_INVALID", `Tool has no declared idempotent side effect: ${definition.name}`);
    const ledgerKey = `${input.runId}:${definition.name}:${definition.version}:${input.idempotencyKey}`;
    const existing = this.sideEffectLedger.get(ledgerKey);
    if (existing && existing.inputHash !== input.inputHash)
      throw new HarnessError("TOOL_INVOCATION_INVALID", `Idempotency key reused with different input: ${input.idempotencyKey}`);
    if (existing && forcedReceiptId && existing.receiptId !== forcedReceiptId)
      throw new HarnessError("TOOL_INVOCATION_INVALID", `Fault receipt conflicts with the idempotency ledger: ${input.idempotencyKey}`);
    const receiptId = existing?.receiptId ?? forcedReceiptId ?? this.ids.nextStableId("effect-receipt");
    if (!existing) {
      this.sideEffectLedger.set(ledgerKey, { inputHash: input.inputHash, receiptId });
      this.sideEffectExecutions += 1;
    }
    return {
      receiptId,
      runId: input.runId,
      toolName: definition.name,
      toolVersion: definition.version,
      effectKey: input.idempotencyKey,
      inputHash: input.inputHash,
      replayed: Boolean(existing)
    };
  }
}

export function createFaultInjector(programs: readonly FaultProgram[] = []): DeterministicFaultInjector {
  return new DeterministicFaultInjector(programs);
}
