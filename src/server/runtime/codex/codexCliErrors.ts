export type CodexCliFailureKind = "NOT_READY" | "TIMEOUT" | "INTERRUPTED" | "ENTITLEMENT_UNAVAILABLE" | "PROCESS_FAILED" | "INVALID_OUTPUT";

export class CodexCliError extends Error {
  readonly name = "CodexCliError";

  constructor(
    readonly kind: CodexCliFailureKind,
    message: string,
    readonly metadata: Readonly<Record<string, unknown>> = {},
    options?: ErrorOptions
  ) {
    super(message, options);
  }
}
