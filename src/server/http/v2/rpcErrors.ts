import { RequestIdSchema, type RpcErrorCode } from "../../../contracts/api-v2/common.js";
import { CanonicalRunRuntimeError } from "../../composition/canonicalRunTypes.js";
import { DurableResumeValidationError } from "../../composition/durableResumeValidator.js";
import { IDEMPOTENCY_CONFLICT_PUBLIC_MESSAGE, IdempotencyConflictError } from "../../runtime/storage/v2/jobErrors.js";
import { createServerRequestId, internalErrorMessage } from "../errorBoundary.js";

export function mapRpcV2Error(error: unknown, requestId: string): RpcV2Error {
  if (error instanceof RpcV2Error) return error;
  if (error instanceof IdempotencyConflictError) {
    return new RpcV2Error(409, requestId, "CONFLICT", IDEMPOTENCY_CONFLICT_PUBLIC_MESSAGE, undefined, error);
  }
  if (error instanceof RpcConflictError) return new RpcV2Error(409, requestId, "CONFLICT", error.message, undefined, error);
  if (error instanceof RpcNotFoundError) return new RpcV2Error(404, requestId, "NOT_FOUND", error.message, undefined, error);
  if (error instanceof RpcCapabilityDeniedError) {
    return new RpcV2Error(403, requestId, "CAPABILITY_DENIED", error.message, error.details, error);
  }
  if (error instanceof RpcNotReadyError) return new RpcV2Error(503, requestId, "NOT_READY", error.message, error.details, error);
  if (error instanceof RpcValidationError) return new RpcV2Error(400, requestId, "VALIDATION_ERROR", error.message, error.details, error);
  if (error instanceof DurableResumeValidationError) {
    return new RpcV2Error(statusForResumeError(error.code), requestId, error.code, error.message, { resumeCode: error.code }, error);
  }
  if (error instanceof CanonicalRunRuntimeError) return mapCanonicalRuntimeError(error, requestId);
  return new RpcV2Error(500, requestId, "INTERNAL_ERROR", internalErrorMessage, undefined, error);
}

function mapCanonicalRuntimeError(error: CanonicalRunRuntimeError, requestId: string): RpcV2Error {
  const details = { canonicalCode: error.code };
  switch (error.code) {
    case "INVALID_CANONICAL_RUN_INPUT":
    case "TOOL_POLICY_VIOLATION":
      return new RpcV2Error(400, requestId, "VALIDATION_ERROR", error.message, details, error);
    case "CANONICAL_RUN_NOT_READY":
    case "PENDING_EXTERNAL_SIDE_EFFECT":
    case "MISSING_ACCEPTANCE_VERIFIER":
      return new RpcV2Error(503, requestId, "NOT_READY", error.message, details, error);
    case "CANONICAL_RUN_OWNERSHIP_MISMATCH":
    case "CANONICAL_TASK_MISMATCH":
    case "CANONICAL_STATE_STALE":
    case "CANONICAL_READBACK_MISMATCH":
    case "CANONICAL_TERMINAL_CONFLICT":
    case "CANONICAL_RESUME_CONFLICT":
      return new RpcV2Error(409, requestId, "CONFLICT", error.message, details, error);
  }
}

function statusForResumeError(code: DurableResumeValidationError["code"]): 400 | 409 | 503 {
  if (code === "VALIDATION_ERROR") return 400;
  if (code === "CONFLICT") return 409;
  return 503;
}

export class RpcConflictError extends Error {}
export class RpcNotFoundError extends Error {}
export class RpcCapabilityDeniedError extends Error {
  constructor(
    message: string,
    readonly details?: Record<string, unknown>
  ) {
    super(message);
  }
}
export class RpcNotReadyError extends Error {
  constructor(
    message: string,
    readonly details?: Record<string, unknown>
  ) {
    super(message);
  }
}
export class RpcValidationError extends Error {
  constructor(
    message: string,
    readonly details?: Record<string, unknown>
  ) {
    super(message);
  }
}

export class RpcV2Error extends Error {
  constructor(
    readonly status: number,
    readonly requestId: string,
    readonly code: RpcErrorCode,
    message: string,
    readonly details?: Record<string, unknown>,
    cause?: unknown
  ) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "RpcV2Error";
  }
}

export function requestIdFromBody(body: unknown): string {
  if (body && typeof body === "object" && "requestId" in body) {
    const requestId = (body as { requestId?: unknown }).requestId;
    const parsed = RequestIdSchema.safeParse(requestId);
    if (parsed.success) return parsed.data;
  }
  return createServerRequestId();
}
