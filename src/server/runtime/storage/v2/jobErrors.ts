export const IDEMPOTENCY_CONFLICT_CODE = "IDEMPOTENCY_CONFLICT" as const;
export const IDEMPOTENCY_CONFLICT_PUBLIC_MESSAGE = "The idempotency key was already used for a different request.";

export class IdempotencyConflictError extends Error {
  readonly code = IDEMPOTENCY_CONFLICT_CODE;

  constructor() {
    super(IDEMPOTENCY_CONFLICT_PUBLIC_MESSAGE);
    this.name = "IdempotencyConflictError";
  }
}
