import { randomUUID } from "node:crypto";
import { redactTraceText } from "../runtime/security/traceSanitizer.js";

export const internalErrorMessage = "The request could not be completed.";

export interface InternalErrorLogContext {
  requestId: string;
  operation: string;
  startedAt: number;
}

export function createServerRequestId(): string {
  return `srv-${randomUUID()}`;
}

export function logInternalError(error: unknown, context: InternalErrorLogContext): void {
  const payload = {
    level: "error",
    requestId: context.requestId,
    operation: safeOperation(context.operation),
    durationMs: Math.max(0, Date.now() - context.startedAt),
    errorClass: errorClass(error),
    causeChain: causeChain(error)
  };
  console.error(JSON.stringify(payload));
}

function safeOperation(value: string): string {
  return /^[A-Z]+ \/[A-Za-z0-9/._-]{0,200}$/.test(value) ? value : "HTTP request";
}

function errorClass(error: unknown): string {
  if (error instanceof Error) return error.name || "Error";
  return typeof error;
}

function causeChain(error: unknown): Array<{ class: string; message: string }> {
  const result: Array<{ class: string; message: string }> = [];
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current !== undefined && current !== null && result.length < 5 && !seen.has(current)) {
    seen.add(current);
    if (current instanceof Error) {
      result.push({ class: current.name || "Error", message: redactTraceText(current.message) ?? "" });
      current = current.cause;
      continue;
    }
    result.push({ class: typeof current, message: redactTraceText(String(current)) ?? "" });
    break;
  }
  return result;
}
