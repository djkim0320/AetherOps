import { z } from "zod";

const StableIdSchema = z
  .string()
  .min(1)
  .max(160)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/);
const NonEmptyTextSchema = z.string().trim().min(1).max(4_000);

export const NumericMeasurementSchema = z
  .object({
    value: z.number().finite().nullable(),
    unit: StableIdSchema,
    sampleCount: z.number().int().positive().optional(),
    unmeasuredReason: NonEmptyTextSchema.optional()
  })
  .strict()
  .superRefine((measurement, context) => {
    if (measurement.value === null && !measurement.unmeasuredReason)
      context.addIssue({ code: "custom", path: ["unmeasuredReason"], message: "Unmeasured metrics require a reason." });
    if (measurement.value !== null && measurement.unmeasuredReason)
      context.addIssue({ code: "custom", path: ["unmeasuredReason"], message: "Measured metrics cannot include an unmeasured reason." });
    if (measurement.value === null && measurement.sampleCount)
      context.addIssue({ code: "custom", path: ["sampleCount"], message: "Unmeasured metrics cannot include a sample count." });
  });

export const BooleanMeasurementSchema = z
  .object({ value: z.boolean().nullable(), unit: z.literal("boolean"), unmeasuredReason: NonEmptyTextSchema.optional() })
  .strict()
  .superRefine((measurement, context) => {
    if (measurement.value === null && !measurement.unmeasuredReason)
      context.addIssue({ code: "custom", path: ["unmeasuredReason"], message: "Unmeasured metrics require a reason." });
    if (measurement.value !== null && measurement.unmeasuredReason)
      context.addIssue({ code: "custom", path: ["unmeasuredReason"], message: "Measured metrics cannot include an unmeasured reason." });
  });
