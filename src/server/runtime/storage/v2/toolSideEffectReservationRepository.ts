import type { DatabaseSync } from "node:sqlite";
import { assertVerifiedToolPostcondition } from "./toolPostcondition.js";
import type { StorageToolAttempt } from "./traceTypes.js";
import {
  SideEffectReservationConflictError,
  type StorageToolSideEffectReservation,
  type StorageToolSideEffectReservationStatus
} from "./toolSideEffectReservationTypes.js";

interface ReservationRow {
  project_id?: unknown;
  side_effect_key?: unknown;
  attempt_id?: unknown;
  job_id?: unknown;
  idempotency_key?: unknown;
  input_hash?: unknown;
  descriptor_version?: unknown;
  status?: unknown;
  generation?: unknown;
  reserved_at?: unknown;
  resolved_at?: unknown;
}

interface ObservedReservation {
  status: StorageToolSideEffectReservationStatus;
  resolvedAt?: string;
}

export class ToolSideEffectReservationRepository {
  constructor(private readonly db: DatabaseSync) {}

  observeAttempt(attempt: StorageToolAttempt): StorageToolSideEffectReservation | undefined {
    const observed = observedReservation(attempt);
    if (!observed) return undefined;
    const sideEffectKey = required(attempt.sideEffectKey);
    const existing = this.get(attempt.projectId, sideEffectKey);
    if (!existing) return this.insert(attempt, observed);
    if (existing.attemptId === attempt.id) return this.updateSameAttempt(existing, attempt, observed);
    if (!sameEffectIdentity(existing, attempt)) throw new SideEffectReservationConflictError();
    if (existing.status === "not_applied") return this.takeOver(existing, attempt, observed);
    // A v10 or partially recovered database may already contain a second executed attempt.
    // Keep the project key fail-closed while allowing its terminal recovery transaction to finish.
    if (observed.status === "ambiguous") return existing;
    throw new SideEffectReservationConflictError();
  }

  get(projectId: string, sideEffectKey: string): StorageToolSideEffectReservation | undefined {
    const row = this.db.prepare("select * from tool_side_effect_reservations where project_id=? and side_effect_key=?").get(projectId, sideEffectKey) as
      ReservationRow | undefined;
    return row ? mapReservation(row) : undefined;
  }

  getByAttempt(attemptId: string): StorageToolSideEffectReservation | undefined {
    const row = this.db.prepare("select * from tool_side_effect_reservations where attempt_id=?").get(attemptId) as ReservationRow | undefined;
    return row ? mapReservation(row) : undefined;
  }

  private insert(attempt: StorageToolAttempt, observed: ObservedReservation): StorageToolSideEffectReservation {
    this.db
      .prepare(
        `insert into tool_side_effect_reservations
          (project_id,side_effect_key,attempt_id,job_id,idempotency_key,input_hash,descriptor_version,status,generation,reserved_at,resolved_at)
         values(?,?,?,?,?,?,?,?,1,?,?)`
      )
      .run(
        attempt.projectId,
        required(attempt.sideEffectKey),
        attempt.id,
        attempt.jobId,
        required(attempt.idempotencyKey),
        attempt.inputHash,
        required(attempt.descriptorVersion),
        observed.status,
        required(attempt.startedAt),
        observed.resolvedAt ?? null
      );
    return this.requiredByAttempt(attempt.id);
  }

  private updateSameAttempt(
    existing: StorageToolSideEffectReservation,
    attempt: StorageToolAttempt,
    observed: ObservedReservation
  ): StorageToolSideEffectReservation {
    if (!sameEffectIdentity(existing, attempt)) throw new SideEffectReservationConflictError();
    assertStatusProgress(existing.status, observed.status);
    this.db
      .prepare("update tool_side_effect_reservations set status=?,resolved_at=? where project_id=? and side_effect_key=? and attempt_id=?")
      .run(observed.status, observed.resolvedAt ?? existing.resolvedAt ?? null, existing.projectId, existing.sideEffectKey, existing.attemptId);
    return this.requiredByAttempt(attempt.id);
  }

  private takeOver(existing: StorageToolSideEffectReservation, attempt: StorageToolAttempt, observed: ObservedReservation): StorageToolSideEffectReservation {
    const result = this.db
      .prepare(
        `update tool_side_effect_reservations set attempt_id=?,job_id=?,status=?,generation=generation+1,reserved_at=?,resolved_at=?
         where project_id=? and side_effect_key=? and attempt_id=? and status='not_applied'`
      )
      .run(
        attempt.id,
        attempt.jobId,
        observed.status,
        required(attempt.startedAt),
        observed.resolvedAt ?? null,
        existing.projectId,
        existing.sideEffectKey,
        existing.attemptId
      );
    if (Number(result.changes) !== 1) throw new SideEffectReservationConflictError();
    return this.requiredByAttempt(attempt.id);
  }

  private requiredByAttempt(attemptId: string): StorageToolSideEffectReservation {
    const value = this.getByAttempt(attemptId);
    if (!value) throw new Error("Tool side-effect reservation readback is missing.");
    return value;
  }
}

function observedReservation(attempt: StorageToolAttempt): ObservedReservation | undefined {
  if (!attempt.sideEffectKey) return undefined;
  if (attempt.status === "queued" || (!attempt.startedAt && !attempt.postconditionReceipt)) return undefined;
  required(attempt.idempotencyKey);
  required(attempt.descriptorVersion);
  if (attempt.status === "running") return { status: "reserved" };
  if (attempt.postconditionDisposition && attempt.postconditionReceipt) {
    assertVerifiedToolPostcondition(attempt);
    return { status: attempt.postconditionDisposition, resolvedAt: attempt.postconditionReceipt.verifiedAt };
  }
  return { status: "ambiguous", resolvedAt: required(attempt.completedAt) };
}

function sameEffectIdentity(reservation: StorageToolSideEffectReservation, attempt: StorageToolAttempt): boolean {
  return (
    reservation.projectId === attempt.projectId &&
    reservation.sideEffectKey === attempt.sideEffectKey &&
    reservation.idempotencyKey === attempt.idempotencyKey &&
    reservation.inputHash === attempt.inputHash &&
    reservation.descriptorVersion === attempt.descriptorVersion
  );
}

function assertStatusProgress(existing: StorageToolSideEffectReservationStatus, next: StorageToolSideEffectReservationStatus): void {
  if (existing === next) return;
  if (existing === "reserved" && next !== "reserved") return;
  if (existing === "ambiguous" && (next === "applied" || next === "not_applied")) return;
  throw new Error(`Invalid tool side-effect reservation transition: ${existing} -> ${next}.`);
}

function mapReservation(row: ReservationRow): StorageToolSideEffectReservation {
  const status = required(row.status) as StorageToolSideEffectReservationStatus;
  if (!["reserved", "applied", "not_applied", "ambiguous"].includes(status)) throw new Error("Stored tool side-effect reservation status is invalid.");
  const generation = Number(row.generation);
  if (!Number.isSafeInteger(generation) || generation < 1) throw new Error("Stored tool side-effect reservation generation is invalid.");
  return {
    projectId: required(row.project_id),
    sideEffectKey: required(row.side_effect_key),
    attemptId: required(row.attempt_id),
    jobId: required(row.job_id),
    idempotencyKey: required(row.idempotency_key),
    inputHash: required(row.input_hash),
    descriptorVersion: required(row.descriptor_version),
    status,
    generation,
    reservedAt: required(row.reserved_at),
    ...(typeof row.resolved_at === "string" && row.resolved_at ? { resolvedAt: row.resolved_at } : {})
  };
}

function required(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) throw new Error("Tool side-effect reservation identity is missing.");
  return value;
}
