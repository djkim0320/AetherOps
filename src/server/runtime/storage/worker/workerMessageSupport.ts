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
  if (error instanceof Error) return { name: error.name, message: error.message, stack: error.stack };
  return { name: "Error", message: String(error) };
}

export function workerError(error: StorageWorkerErrorPayload): Error {
  if (error.code === IDEMPOTENCY_CONFLICT_CODE) return new IdempotencyConflictError();
  const next = new Error(error.message);
  next.name = error.name;
  next.stack = error.stack;
  return next;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
