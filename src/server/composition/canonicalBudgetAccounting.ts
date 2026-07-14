import {
  CANONICAL_BUDGET_ACCOUNTING_POLICY,
  CANONICAL_BUDGET_DECISION_PREFIX,
  CANONICAL_BUDGET_RECEIPT_PREFIX,
  type CanonicalBudgetUsage
} from "../../core/orchestration/budgetAccounting.js";
import type { CanonicalHasher } from "../../core/orchestration/orchestrationSchemas.js";
import type { StorageCheckpoint } from "../runtime/storage/v2/types.js";
import type { StorageLlmInvocation, StorageToolAttempt } from "../runtime/storage/v2/traceTypes.js";
import { CanonicalRunRuntimeError } from "./canonicalRunTypes.js";
import type { DurableJobRecord } from "./durableJobTypes.js";

const MAX_ACCOUNTING_TRACE = 1_000;

export interface CanonicalBudgetTracePort {
  listCanonicalLlmInvocations(jobId: string, limit?: number): Promise<StorageLlmInvocation[]>;
  listCanonicalToolAttempts(jobId: string, limit?: number): Promise<StorageToolAttempt[]>;
  latestCommittedCheckpoint(jobId: string): Promise<StorageCheckpoint | undefined>;
}

export interface CanonicalBudgetObservation {
  target: CanonicalBudgetUsage;
  receiptHash: string;
  decisionId: string;
  receiptId: string;
}

export async function observeCanonicalBudget(input: {
  port: CanonicalBudgetTracePort;
  jobs: DurableJobRecord[];
  projectId: string;
  runId: string;
  activeJobId?: string;
  observedAt: string;
  hasher: CanonicalHasher;
}): Promise<CanonicalBudgetObservation> {
  const groups = await Promise.all(
    input.jobs.map(async (job) => {
      const [llm, attempts, checkpoint] = await Promise.all([
        input.port.listCanonicalLlmInvocations(job.id, MAX_ACCOUNTING_TRACE),
        input.port.listCanonicalToolAttempts(job.id, MAX_ACCOUNTING_TRACE),
        input.port.latestCommittedCheckpoint(job.id)
      ]);
      if (llm.length >= MAX_ACCOUNTING_TRACE || attempts.length >= MAX_ACCOUNTING_TRACE) {
        unavailable("Canonical budget accounting exceeded its bounded trace window.");
      }
      return { job, llm, attempts, checkpoint };
    })
  );
  const llm = groups.flatMap((group) => group.llm);
  const attempts = groups.flatMap((group) => group.attempts);
  assertUnique(llm, "LLM invocation");
  assertUnique(attempts, "tool attempt");
  const target: CanonicalBudgetUsage = {
    durationMs: activeDuration(groups, input.activeJobId, input.observedAt),
    inputTokens: llm.reduce((sum, item) => sum + llmAccounting(item).inputUnits, 0),
    outputTokens: llm.reduce((sum, item) => sum + llmAccounting(item).outputUnits, 0),
    toolCalls: attempts.filter((attempt) => attempt.startedAt).length,
    retries: llm.reduce((sum, item) => sum + item.repairCount, 0) + toolRetries(attempts),
    estimatedCostMicrousd: 0,
    toolOutputBytes: attempts.reduce((sum, item) => sum + toolOutputBytes(item), 0)
  };
  assertSafeUsage(target);
  const payload = {
    accountingPolicy: CANONICAL_BUDGET_ACCOUNTING_POLICY,
    projectId: input.projectId,
    runId: input.runId,
    activeJobId: input.activeJobId ?? null,
    target,
    jobs: groups.map((group) => jobReceipt(group, input.activeJobId, input.observedAt)),
    llm: llm.map(llmReceipt).sort(compareIds),
    attempts: attempts.map(toolReceipt).sort(compareIds)
  };
  const receiptHash = input.hasher.sha256Canonical(payload);
  return {
    target,
    receiptHash,
    decisionId: `${CANONICAL_BUDGET_DECISION_PREFIX}${receiptHash}`,
    receiptId: `${CANONICAL_BUDGET_RECEIPT_PREFIX}${receiptHash}`
  };
}

type TraceGroup = {
  job: DurableJobRecord;
  llm: StorageLlmInvocation[];
  attempts: StorageToolAttempt[];
  checkpoint?: StorageCheckpoint;
};

function activeDuration(groups: TraceGroup[], activeJobId: string | undefined, observedAt: string): number {
  const intervals = groups.flatMap((group) => {
    const started = timestamp(group.job.startedAt, `job ${group.job.id} start`);
    const end = accountingEnd(group, activeJobId, observedAt, started);
    return end > started ? [{ start: started, end }] : [];
  });
  intervals.sort((left, right) => left.start - right.start || left.end - right.end);
  let total = 0;
  let cursorStart: number | undefined;
  let cursorEnd: number | undefined;
  for (const interval of intervals) {
    if (cursorStart === undefined || cursorEnd === undefined) {
      cursorStart = interval.start;
      cursorEnd = interval.end;
    } else if (interval.start <= cursorEnd) cursorEnd = Math.max(cursorEnd, interval.end);
    else {
      total += cursorEnd - cursorStart;
      cursorStart = interval.start;
      cursorEnd = interval.end;
    }
  }
  return total + (cursorStart === undefined || cursorEnd === undefined ? 0 : cursorEnd - cursorStart);
}

function accountingEnd(group: TraceGroup, activeJobId: string | undefined, observedAt: string, started: number): number {
  if (group.job.id === activeJobId) return checkedEnd(observedAt, started, "active budget observation");
  if (group.job.status !== "interrupted" && group.job.finishedAt) return checkedEnd(group.job.finishedAt, started, `job ${group.job.id} finish`);
  if (group.job.status === "interrupted" && group.job.finishedAt) {
    const finished = checkedEnd(group.job.finishedAt, started, `job ${group.job.id} interruption`);
    const leaseExpiry = group.job.leaseExpiresAt ? checkedEnd(group.job.leaseExpiresAt, started, `job ${group.job.id} lease expiry`) : finished;
    return Math.min(finished, leaseExpiry);
  }
  const activity = [
    group.checkpoint?.committedAt,
    ...group.llm.flatMap((item) => [item.completedAt, item.startedAt]),
    ...group.attempts.flatMap((item) => [item.completedAt, item.startedAt])
  ].filter((value): value is string => Boolean(value));
  return Math.max(started, ...activity.map((value) => checkedEnd(value, started, `job ${group.job.id} activity`)));
}

function llmAccounting(item: StorageLlmInvocation): { inputUnits: number; outputUnits: number } {
  const accounting = record(record(item.data)?.accounting);
  if (
    accounting?.version !== 1 ||
    accounting.unit !== "estimated_token" ||
    accounting.estimator !== "utf8_bytes_div_4_ceil_v1" ||
    record(accounting.monetaryCost)?.availability !== "unavailable" ||
    record(accounting.monetaryCost)?.policy !== "unmetered_codex_oauth_v1"
  ) {
    unavailable(`LLM invocation ${item.id} lacks an explicit supported accounting receipt.`);
  }
  return {
    inputUnits: nonnegative(accounting.inputUnits, `LLM invocation ${item.id} input estimate`),
    outputUnits: nonnegative(accounting.outputUnits, `LLM invocation ${item.id} output estimate`)
  };
}

function toolOutputBytes(item: StorageToolAttempt): number {
  if (!item.outputHash) return 0;
  const accounting = record(record(item.data)?.accounting);
  if (accounting?.version !== 1 || accounting.source !== "canonical_result_utf8_v1") {
    unavailable(`Tool attempt ${item.id} lacks canonical output-byte accounting.`);
  }
  const canonical = nonnegative(accounting.canonicalResultBytes, `Tool attempt ${item.id} canonical output bytes`);
  const workspace = accounting.workspaceOutputBytes;
  return workspace === undefined ? canonical : Math.max(canonical, nonnegative(workspace, `Tool attempt ${item.id} workspace output bytes`));
}

function toolRetries(attempts: StorageToolAttempt[]): number {
  const counts = new Map<string, number>();
  for (const attempt of attempts) {
    if (!attempt.startedAt) continue;
    const key = attempt.idempotencyKey ?? attempt.id;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.values()].reduce((sum, count) => sum + Math.max(0, count - 1), 0);
}

function jobReceipt(group: TraceGroup, activeJobId: string | undefined, observedAt: string) {
  const started = timestamp(group.job.startedAt, `job ${group.job.id} start`);
  return { id: group.job.id, startedAt: group.job.startedAt, accountingEndMs: accountingEnd(group, activeJobId, observedAt, started) };
}

function llmReceipt(item: StorageLlmInvocation) {
  const accounting = llmAccounting(item);
  return { id: item.id, status: item.status, startedAt: item.startedAt, completedAt: item.completedAt ?? null, repairCount: item.repairCount, ...accounting };
}

function toolReceipt(item: StorageToolAttempt) {
  return {
    id: item.id,
    status: item.status,
    startedAt: item.startedAt ?? null,
    completedAt: item.completedAt ?? null,
    idempotencyKey: item.idempotencyKey ?? null,
    outputHash: item.outputHash ?? null,
    outputBytes: toolOutputBytes(item)
  };
}

function assertUnique(items: Array<{ id: string }>, label: string): void {
  if (new Set(items.map((item) => item.id)).size !== items.length) unavailable(`Canonical budget accounting found duplicate ${label} identities.`);
}

function assertSafeUsage(usage: CanonicalBudgetUsage): void {
  if (Object.values(usage).some((value) => !Number.isSafeInteger(value) || value < 0)) unavailable("Canonical budget usage exceeded safe integer bounds.");
}

function timestamp(value: string | undefined, label: string): number {
  if (!value) unavailable(`Canonical budget accounting is missing ${label}.`);
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) unavailable(`Canonical budget accounting found an invalid ${label}.`);
  return parsed;
}

function checkedEnd(value: string, start: number, label: string): number {
  const end = timestamp(value, label);
  if (end < start) unavailable(`Canonical budget accounting found ${label} before job start.`);
  return end;
}

function nonnegative(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) unavailable(`${label} is not a nonnegative safe integer.`);
  return value;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function compareIds(left: { id: string }, right: { id: string }): number {
  return left.id.localeCompare(right.id);
}

function unavailable(message: string): never {
  throw new CanonicalRunRuntimeError("CANONICAL_RUN_NOT_READY", message);
}
