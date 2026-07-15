export type StorageToolSideEffectReservationStatus = "reserved" | "applied" | "not_applied" | "ambiguous";

export interface StorageToolSideEffectReservation {
  projectId: string;
  sideEffectKey: string;
  attemptId: string;
  jobId: string;
  idempotencyKey: string;
  inputHash: string;
  descriptorVersion: string;
  status: StorageToolSideEffectReservationStatus;
  generation: number;
  reservedAt: string;
  resolvedAt?: string;
}

export const SIDE_EFFECT_RESERVATION_CONFLICT_CODE = "SIDE_EFFECT_RESERVATION_CONFLICT" as const;

export class SideEffectReservationConflictError extends Error {
  readonly code = SIDE_EFFECT_RESERVATION_CONFLICT_CODE;

  constructor() {
    super("The requested external side effect is already reserved or has an unresolved prior execution.");
    this.name = "SideEffectReservationConflictError";
  }
}
