import { z } from "zod";

export const API_V2_ERROR_CODES = [
  "VALIDATION_ERROR",
  "CONFLICT",
  "CAPABILITY_DENIED",
  "NOT_READY",
  "NOT_FOUND",
  "INTERRUPTED",
  "METHOD_NOT_FOUND",
  "INTERNAL_ERROR"
] as const;

export const RpcErrorCodeSchema = z.enum(API_V2_ERROR_CODES);
export type RpcErrorCode = z.infer<typeof RpcErrorCodeSchema>;

export const RequestIdSchema = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/);
export const EntityIdSchema = z.string().trim().min(1).max(256);
export const IdempotencyKeySchema = z.string().trim().min(1).max(256);
export const TimestampSchema = z.string().datetime({ offset: true });
export const RevisionSchema = z.number().int().nonnegative();

export const EmptyParamsSchema = z.object({}).strict();

export const RpcRequestV2Schema = z
  .object({
    requestId: RequestIdSchema,
    method: z.string().trim().min(1),
    params: z.unknown()
  })
  .strict();

type RpcRequestEnvelope = z.infer<typeof RpcRequestV2Schema>;
export type RpcRequestV2<P = unknown> = Omit<RpcRequestEnvelope, "params"> & { params: P };

export function rpcRequestSchema<M extends string, P extends z.ZodType>(method: M, params: P) {
  return z
    .object({
      requestId: RequestIdSchema,
      method: z.literal(method),
      params
    })
    .strict();
}

export const RpcErrorSchema = z
  .object({
    code: RpcErrorCodeSchema,
    message: z.string().min(1),
    details: z.record(z.string(), z.unknown()).optional()
  })
  .strict();

export type RpcError = z.infer<typeof RpcErrorSchema>;

export const RpcErrorResponseSchema = z
  .object({
    requestId: RequestIdSchema,
    ok: z.literal(false),
    error: RpcErrorSchema
  })
  .strict();

export type RpcErrorResponse = z.infer<typeof RpcErrorResponseSchema>;

export function rpcSuccessResponseSchema<T extends z.ZodType>(result: T) {
  return z
    .object({
      requestId: RequestIdSchema,
      ok: z.literal(true),
      result
    })
    .strict();
}
