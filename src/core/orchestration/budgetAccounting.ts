import type { RunStateRevision } from "./runStateCapsule.js";

export const CANONICAL_BUDGET_ACCOUNTING_POLICY = Object.freeze({
  version: 1,
  duration: "active_job_windows_v1",
  inputTokens: "estimated_utf8_bytes_div_4_ceil_v1",
  outputTokens: "estimated_utf8_bytes_div_4_ceil_v1",
  toolCalls: "started_tool_attempts_v1",
  retries: "llm_schema_repairs_and_started_tool_retries_v1",
  toolOutputBytes: "canonical_result_or_verified_workspace_bytes_v1",
  monetaryCost: "unavailable_unmetered_codex_oauth_v1"
} as const);

export const CANONICAL_BUDGET_ACCOUNTING_INSTRUCTION_ID = "instruction:budget-accounting-policy";
export const CANONICAL_BUDGET_DECISION_PREFIX = "budget-accounting-v1:cost-unavailable-unmetered:";
export const CANONICAL_BUDGET_RECEIPT_PREFIX = "budget-receipt-v1:token-estimate-v1:cost-unavailable-unmetered:";

export type CanonicalBudgetUsage = RunStateRevision["budgetUsage"];

export function budgetUsageDelta(current: CanonicalBudgetUsage, target: CanonicalBudgetUsage): CanonicalBudgetUsage {
  const delta = mapBudget(target, (value, key) => value - current[key]);
  if (Object.values(delta).some((value) => value < 0)) throw new Error("Durable budget accounting target regressed below committed usage.");
  return delta;
}

export function budgetUsageEqual(left: CanonicalBudgetUsage, right: CanonicalBudgetUsage): boolean {
  return budgetKeys.every((key) => left[key] === right[key]);
}

export function hasBudgetUsage(value: CanonicalBudgetUsage): boolean {
  return Object.values(value).some((item) => item > 0);
}

export function exhaustedBudgetDimensions(state: Pick<RunStateRevision, "budgetLimits" | "budgetUsage">): string[] {
  const { budgetLimits: limits, budgetUsage: usage } = state;
  const exhausted = [
    usage.durationMs >= limits.maxDurationMs ? "durationMs" : undefined,
    usage.inputTokens >= limits.maxInputTokens ? "inputTokens" : undefined,
    usage.outputTokens >= limits.maxOutputTokens ? "outputTokens" : undefined,
    usage.toolCalls >= limits.maxToolCalls ? "toolCalls" : undefined,
    usage.retries >= limits.maxRetries ? "retries" : undefined,
    usage.toolOutputBytes >= limits.maxToolOutputBytes ? "toolOutputBytes" : undefined
  ];
  // Codex OAuth does not expose a durable monetary-cost receipt. A positive
  // monetary ceiling is therefore unenforceable and must fail closed instead
  // of being treated as unused budget.
  if (limits.maxEstimatedCostMicrousd > 0) exhausted.push("estimatedCostMicrousd");
  return exhausted.filter((item): item is string => item !== undefined);
}

export function exceededBudgetDimensions(state: Pick<RunStateRevision, "budgetLimits" | "budgetUsage">): string[] {
  const { budgetLimits: limits, budgetUsage: usage } = state;
  const exceeded = [
    usage.durationMs > limits.maxDurationMs ? "durationMs" : undefined,
    usage.inputTokens > limits.maxInputTokens ? "inputTokens" : undefined,
    usage.outputTokens > limits.maxOutputTokens ? "outputTokens" : undefined,
    usage.toolCalls > limits.maxToolCalls ? "toolCalls" : undefined,
    usage.retries > limits.maxRetries ? "retries" : undefined,
    usage.toolOutputBytes > limits.maxToolOutputBytes ? "toolOutputBytes" : undefined
  ];
  if (usage.estimatedCostMicrousd > limits.maxEstimatedCostMicrousd) exceeded.push("estimatedCostMicrousd");
  return exceeded.filter((item): item is string => item !== undefined);
}

const budgetKeys = ["durationMs", "inputTokens", "outputTokens", "toolCalls", "retries", "estimatedCostMicrousd", "toolOutputBytes"] as const;

function mapBudget(value: CanonicalBudgetUsage, transform: (value: number, key: (typeof budgetKeys)[number]) => number): CanonicalBudgetUsage {
  return Object.fromEntries(budgetKeys.map((key) => [key, transform(value[key], key)])) as unknown as CanonicalBudgetUsage;
}
