import {
  STORAGE_WORKER_READY,
  STORAGE_WORKER_REQUEST,
  STORAGE_WORKER_RESPONSE,
  type StorageWorkerErrorPayload,
  type StorageWorkerReady,
  type StorageWorkerRequest,
  type StorageWorkerResponse
} from "./typedProtocol.js";
import { IDEMPOTENCY_CONFLICT_CODE, IdempotencyConflictError } from "../v2/jobErrors.js";
import { SIDE_EFFECT_RESERVATION_CONFLICT_CODE, SideEffectReservationConflictError } from "../v2/toolSideEffectReservationTypes.js";
import { LeaseLostError } from "../v2/leaseFence.js";
import {
  STORAGE_IMMUTABLE_CONFLICT_CODE,
  STORAGE_OWNERSHIP_CONFLICT_CODE,
  STORAGE_REVISION_CONFLICT_CODE,
  StorageImmutableConflictError,
  StorageOwnershipConflictError,
  StorageRevisionConflictError
} from "../v2/runStateErrors.js";

export function isStorageWorkerRequest(message: unknown): message is StorageWorkerRequest {
  return (
    isRecord(message) &&
    message.type === STORAGE_WORKER_REQUEST &&
    typeof message.requestId === "string" &&
    isRecord(message.command) &&
    typeof message.command.name === "string"
  );
}

export function isStorageWorkerResponse(message: unknown): message is StorageWorkerResponse {
  return isRecord(message) && message.type === STORAGE_WORKER_RESPONSE && typeof message.requestId === "string" && typeof message.ok === "boolean";
}

export function isStorageWorkerReady(message: unknown): message is StorageWorkerReady {
  return isRecord(message) && message.type === STORAGE_WORKER_READY && typeof message.ok === "boolean";
}

export function serializeWorkerError(error: unknown): StorageWorkerErrorPayload {
  if (error instanceof IdempotencyConflictError) {
    return { name: error.name, message: error.message, code: error.code };
  }
  if (error instanceof SideEffectReservationConflictError) {
    return { name: error.name, message: error.message, code: error.code };
  }
  if (error instanceof StorageRevisionConflictError || error instanceof StorageOwnershipConflictError || error instanceof StorageImmutableConflictError) {
    return { name: error.name, message: error.message, code: error.code };
  }
  if (error instanceof LeaseLostError) return { name: error.name, message: error.message, code: error.code };
  if (error instanceof Error) return { name: safeErrorName(error.name), message: safeWorkerMessage(error) };
  return { name: "StorageWorkerError", message: "Storage worker command failed." };
}

export function workerError(error: StorageWorkerErrorPayload): Error {
  if (error.code === IDEMPOTENCY_CONFLICT_CODE) return new IdempotencyConflictError();
  if (error.code === SIDE_EFFECT_RESERVATION_CONFLICT_CODE) return new SideEffectReservationConflictError();
  if (error.code === STORAGE_REVISION_CONFLICT_CODE) return new StorageRevisionConflictError(null, null);
  if (error.code === STORAGE_OWNERSHIP_CONFLICT_CODE) return new StorageOwnershipConflictError();
  if (error.code === STORAGE_IMMUTABLE_CONFLICT_CODE) return new StorageImmutableConflictError();
  if (error.code === "LEASE_LOST") {
    const next = new LeaseLostError("redacted");
    next.message = error.message;
    return next;
  }
  const next = new Error(error.message);
  next.name = error.name;
  return next;
}

function safeWorkerMessage(error: Error): string {
  if (error instanceof SyntaxError || /JSON|Unexpected token|position \d+/i.test(error.message)) {
    return "Storage worker rejected malformed persisted JSON.";
  }
  return (
    error.message
      .replace(/[A-Za-z]:\\[^\s"']+/g, "[redacted-path]")
      .replace(/(?:^|\s)\/(?:[^\s"']+\/?)+/g, " [redacted-path]")
      .replace(/\b(?:Bearer\s+)?[A-Za-z0-9_-]{32,}\.[A-Za-z0-9_.-]{16,}\b/gi, "[redacted-secret]")
      .replace(/\b(?:api[_-]?key|token|cookie|secret)\s*[:=]\s*[^\s,;]+/gi, "credential=[redacted-secret]")
      .replaceAll("\u0000", "")
      .split("")
      .filter(isSafeWorkerMessageCharacter)
      .join("")
      .slice(0, 512) || "Storage worker command failed."
  );
}

function isSafeWorkerMessageCharacter(value: string): boolean {
  const code = value.charCodeAt(0);
  return code === 9 || code === 10 || code === 13 || (code >= 32 && code !== 127);
}

function safeErrorName(value: string): string {
  return /^[A-Za-z][A-Za-z0-9_]{0,79}$/.test(value) ? value : "StorageWorkerError";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
