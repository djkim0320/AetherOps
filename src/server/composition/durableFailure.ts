import { randomUUID } from "node:crypto";
import { redactTraceText } from "../runtime/security/traceSanitizer.js";

export type DurableFailureCode = "INTERNAL_ERROR" | "NOT_READY" | "LEASE_LOST" | "CAPABILITY_DENIED" | "VALIDATION_ERROR" | "INTERRUPTED";

export interface DurableFailure {
  code: DurableFailureCode;
  publicMessage: string;
  retriable: boolean;
  internalDiagnosticId: string;
}

interface DurableFailureOptions {
  code?: Exclude<DurableFailureCode, "INTERNAL_ERROR">;
  publicMessage?: string;
  retriable?: boolean;
  diagnosticId?: () => string;
}

const GENERIC_FAILURE_MESSAGE = "작업 실행 중 내부 오류가 발생했습니다.";

/** Converts an untrusted runtime failure into the only form allowed in durable state. */
export function durableFailureFrom(_error: unknown, options: DurableFailureOptions = {}): DurableFailure {
  const diagnosticId = options.diagnosticId?.() ?? `job-${randomUUID()}`;
  if (options.code && options.publicMessage) {
    return {
      code: options.code,
      publicMessage: safePublicMessage(options.publicMessage),
      retriable: options.retriable ?? false,
      internalDiagnosticId: diagnosticId
    };
  }
  return {
    code: "INTERNAL_ERROR",
    publicMessage: GENERIC_FAILURE_MESSAGE,
    retriable: false,
    internalDiagnosticId: diagnosticId
  };
}

function safePublicMessage(message: string): string {
  const redacted = redactTraceText(message)
    ?.replace(/[\r\n]+/g, " ")
    .trim();
  return redacted ? redacted.slice(0, 500) : GENERIC_FAILURE_MESSAGE;
}
