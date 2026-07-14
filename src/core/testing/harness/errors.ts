import type { HarnessCapability } from "./evalSchemas.js";

export type HarnessErrorCode =
  | "MISSING_CAPABILITY"
  | "UNSUPPORTED_EVAL_CASE"
  | "UNSUPPORTED_TOOL"
  | "UNCONSUMED_PLAN"
  | "UNCONSUMED_FAULT"
  | "MODEL_GRADER_UNAVAILABLE"
  | "TRACE_INVALID"
  | "TOOL_INVOCATION_INVALID";

export class HarnessError extends Error {
  readonly name = "HarnessError";

  constructor(
    readonly code: HarnessErrorCode,
    message: string
  ) {
    super(message);
  }
}

export class HarnessCapabilityError extends HarnessError {
  constructor(readonly missingCapabilities: HarnessCapability[]) {
    super("MISSING_CAPABILITY", `Missing deterministic harness capabilities: ${missingCapabilities.join(", ")}`);
  }
}

export function failHarness(code: HarnessErrorCode, message: string): never {
  throw new HarnessError(code, message);
}
