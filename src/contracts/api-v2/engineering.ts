import { z } from "zod";
import { CapabilityGrantSchema } from "./settings.js";
import { JobReceiptSchema } from "./jobs.js";
import { TimestampSchema, rpcRequestSchema } from "./common.js";

const identifier = z.string().trim().min(1).max(256);

export const EngineeringTargetSchema = z.enum(["xfoil", "webxfoil", "su2", "openvsp", "xflr5", "mesh"]);

export const EngineeringRequestSchema = z
  .object({
    target: EngineeringTargetSchema,
    objective: z.string().trim().min(1).max(20_000),
    inputs: z.record(z.string(), z.unknown())
  })
  .strict();

export const EngineeringEnqueueParamsSchema = z
  .object({
    projectId: identifier,
    idempotencyKey: identifier,
    requests: z.array(EngineeringRequestSchema).min(1).max(16),
    capabilities: CapabilityGrantSchema
  })
  .strict();

export const EngineeringPreflightParamsSchema = z
  .object({
    projectId: identifier,
    targets: z.array(EngineeringTargetSchema).min(1).max(6),
    capabilities: CapabilityGrantSchema
  })
  .strict();

export const EngineeringJobReceiptSchema = JobReceiptSchema.refine((receipt) => receipt.kind === "engineering_run", {
  message: "engineering receipt kind must be engineering_run",
  path: ["kind"]
});

export const EngineeringPreflightItemSchema = z
  .object({
    target: EngineeringTargetSchema,
    ready: z.boolean(),
    reason: z.string().trim().min(1).optional()
  })
  .strict();

export const EngineeringPreflightResponseSchema = z
  .object({
    projectId: identifier,
    ready: z.boolean(),
    capabilities: CapabilityGrantSchema,
    targets: z.array(EngineeringPreflightItemSchema),
    checkedAt: TimestampSchema
  })
  .strict();

export const EngineeringEnqueueRequestSchema = rpcRequestSchema("engineering.enqueue", EngineeringEnqueueParamsSchema);
export const EngineeringPreflightRequestSchema = rpcRequestSchema("engineering.preflight", EngineeringPreflightParamsSchema);

export type EngineeringTarget = z.infer<typeof EngineeringTargetSchema>;
export type EngineeringRequest = z.infer<typeof EngineeringRequestSchema>;
export type EngineeringEnqueueParams = z.infer<typeof EngineeringEnqueueParamsSchema>;
export type EngineeringPreflightParams = z.infer<typeof EngineeringPreflightParamsSchema>;
export type EngineeringJobReceipt = z.infer<typeof EngineeringJobReceiptSchema>;
export type EngineeringPreflightResponse = z.infer<typeof EngineeringPreflightResponseSchema>;
