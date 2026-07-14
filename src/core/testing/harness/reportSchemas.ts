import { z } from "zod";
import { EvalRunSchema, NumericMeasurementSchema } from "./evalSchemas.js";
import { TraceEventSchema } from "./traceSchemas.js";

const HashSchema = z.string().regex(/^[a-f0-9]{64}$/);
const StableIdSchema = z
  .string()
  .min(1)
  .max(160)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/);

export const AetherBenchTraceArtifactSchema = z
  .object({
    runId: z.string().uuid(),
    caseId: StableIdSchema,
    events: z.array(TraceEventSchema).min(1),
    canonicalJsonl: z.string().min(1),
    rootHash: HashSchema,
    canonicalTraceHash: HashSchema
  })
  .strict();

export const AetherBenchAggregateSchema = z
  .object({
    evidenceClass: z.literal("deterministic_test_runtime"),
    productOutcome: z.literal("not_evaluated"),
    verdict: z.enum(["passed", "failed", "infrastructure_failure"]),
    totalCases: z.number().int().positive(),
    matchedExpectedOutcome: z.number().int().nonnegative(),
    classificationCounts: z.record(z.enum(["seed", "held_out", "adversarial", "regression"]), z.number().int().nonnegative()),
    metrics: z
      .object({
        deterministicSuccessRate: NumericMeasurementSchema,
        deterministicToolSelectionAccuracy: NumericMeasurementSchema,
        invalidArguments: NumericMeasurementSchema,
        retries: NumericMeasurementSchema,
        duplicateSideEffects: NumericMeasurementSchema,
        contextTokens: NumericMeasurementSchema,
        totalToolOutputBytes: NumericMeasurementSchema,
        totalLatencyMs: NumericMeasurementSchema,
        scriptedRestartRecoveryRate: NumericMeasurementSchema,
        humanInterventions: NumericMeasurementSchema
      })
      .strict()
  })
  .strict();

export const AetherBenchReportSchema = z
  .object({
    schemaVersion: z.literal(1),
    evidenceClass: z.literal("deterministic_test_runtime"),
    productionSuccessEligible: z.literal(false),
    productOutcome: z.literal("not_evaluated"),
    harnessVersion: StableIdSchema,
    evaluatorVersion: StableIdSchema,
    runs: z.array(EvalRunSchema).min(1),
    traces: z.array(AetherBenchTraceArtifactSchema).min(1),
    aggregate: AetherBenchAggregateSchema,
    canonicalReportHash: HashSchema
  })
  .strict();

export type AetherBenchTraceArtifact = z.infer<typeof AetherBenchTraceArtifactSchema>;
export type AetherBenchAggregate = z.infer<typeof AetherBenchAggregateSchema>;
export type AetherBenchReport = z.infer<typeof AetherBenchReportSchema>;
