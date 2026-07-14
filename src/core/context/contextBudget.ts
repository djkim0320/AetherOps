import { CONTEXT_SECTION_ORDER, ContextCompilerError, type ContextBudget, type ContextSectionKind } from "./contextTypes.js";

export const CONTEXT_TOKEN_ESTIMATOR_VERSION = "utf8_bytes_upper_bound_v1" as const;

const DEFAULT_WEIGHTS: Record<ContextSectionKind, number> = {
  task: 20,
  run_state: 32,
  instructions: 18,
  evidence: 13,
  memory: 7,
  skill: 6,
  tools: 12,
  artifacts: 5,
  history: 3
};

export interface ContextSectionAllocation {
  requestedTokens: number;
  allocatedTokens: number;
  allocatedChars: number;
}

export interface ContextBudgetAllocation {
  tokenBudget: number;
  maxChars: number;
  reservedSeparatorTokens: number;
  reservedSeparatorChars: number;
  sections: Record<ContextSectionKind, ContextSectionAllocation>;
}

export function estimateContextTokens(text: string): number {
  return new TextEncoder().encode(text).length;
}

export function allocateContextBudget(budget: ContextBudget): ContextBudgetAllocation {
  assertIntegerRange(budget.tokenBudget, 128, 1_000_000, "tokenBudget");
  assertIntegerRange(budget.maxChars, 512, 4_000_000, "maxChars");
  const separator = "\n\n";
  const reservedSeparatorTokens = estimateContextTokens(separator) * (CONTEXT_SECTION_ORDER.length - 1);
  const reservedSeparatorChars = separator.length * (CONTEXT_SECTION_ORDER.length - 1);
  const defaultRequests = proportionalAllocation(budget.tokenBudget, DEFAULT_WEIGHTS);
  const requested = { ...defaultRequests, ...(budget.sectionTokenRequests ?? {}) };
  for (const kind of CONTEXT_SECTION_ORDER) assertIntegerRange(requested[kind], 0, 1_000_000, `sectionTokenRequests.${kind}`);
  if (requested.task === 0 || requested.run_state === 0) invalid("Task and run-state token requests must be positive.");
  const allocatedTokens = proportionalAllocation(budget.tokenBudget - reservedSeparatorTokens, requested);
  const allocatedChars = proportionalAllocation(budget.maxChars - reservedSeparatorChars, allocatedTokens);
  const sections = Object.fromEntries(
    CONTEXT_SECTION_ORDER.map((kind) => [
      kind,
      { requestedTokens: requested[kind], allocatedTokens: allocatedTokens[kind], allocatedChars: allocatedChars[kind] }
    ])
  ) as Record<ContextSectionKind, ContextSectionAllocation>;
  return { tokenBudget: budget.tokenBudget, maxChars: budget.maxChars, reservedSeparatorTokens, reservedSeparatorChars, sections };
}

function proportionalAllocation(total: number, weights: Record<ContextSectionKind, number>): Record<ContextSectionKind, number> {
  const weightTotal = CONTEXT_SECTION_ORDER.reduce((sum, kind) => sum + weights[kind], 0);
  if (weightTotal <= 0) invalid("Context section requests must have a positive total.");
  const output = Object.fromEntries(CONTEXT_SECTION_ORDER.map((kind) => [kind, Math.floor((total * weights[kind]) / weightTotal)])) as Record<
    ContextSectionKind,
    number
  >;
  let remainder = total - CONTEXT_SECTION_ORDER.reduce((sum, kind) => sum + output[kind], 0);
  for (const kind of CONTEXT_SECTION_ORDER) {
    if (remainder === 0) break;
    if (weights[kind] === 0) continue;
    output[kind] += 1;
    remainder -= 1;
  }
  return output;
}

function assertIntegerRange(value: number, minimum: number, maximum: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) invalid(`${name} must be an integer from ${minimum} to ${maximum}.`);
}

function invalid(message: string): never {
  throw new ContextCompilerError("INVALID_CONTEXT_INPUT", message);
}
