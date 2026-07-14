import type { StorageV2RepositorySet } from "./repositories.js";
import type { StorageCapabilityAudit } from "./types.js";
import type { StorageLlmInvocation, StorageToolAttempt, StorageToolOutputLink } from "./traceTypes.js";

const MAX_TERMINAL_JOB_ROWS = 1_000;

export function readCompleteTerminalToolAttempts(
  repositories: StorageV2RepositorySet,
  jobId: string,
  operation: "verifier" | "transition"
): StorageToolAttempt[] {
  const count = repositories.trace.countToolAttempts(jobId);
  if (count > MAX_TERMINAL_JOB_ROWS) throw new Error(`Canonical terminal ${operation} tool-attempt readback exceeds the bounded complete-set limit.`);
  const attempts = repositories.trace.listToolAttempts(jobId, MAX_TERMINAL_JOB_ROWS);
  if (attempts.length !== count) throw new Error(`Canonical terminal ${operation} tool-attempt readback is incomplete.`);
  return attempts;
}

export function readCompleteTerminalCapabilityAudits(
  repositories: StorageV2RepositorySet,
  jobId: string,
  operation: "verifier" | "transition"
): StorageCapabilityAudit[] {
  const count = repositories.capabilities.countJob(jobId);
  if (count > MAX_TERMINAL_JOB_ROWS) throw new Error(`Canonical terminal ${operation} capability-audit readback exceeds the bounded complete-set limit.`);
  const audits = repositories.capabilities.listJob(jobId, MAX_TERMINAL_JOB_ROWS);
  if (audits.length !== count) throw new Error(`Canonical terminal ${operation} capability-audit readback is incomplete.`);
  return audits;
}

export function readCompleteTerminalLlmInvocations(
  repositories: StorageV2RepositorySet,
  jobId: string,
  operation: "verifier" | "transition"
): StorageLlmInvocation[] {
  const count = repositories.trace.countLlmInvocations(jobId);
  if (count > MAX_TERMINAL_JOB_ROWS) throw new Error(`Canonical terminal ${operation} LLM-invocation readback exceeds the bounded complete-set limit.`);
  const invocations = repositories.trace.listLlmInvocations(jobId, MAX_TERMINAL_JOB_ROWS);
  if (invocations.length !== count) throw new Error(`Canonical terminal ${operation} LLM-invocation readback is incomplete.`);
  return invocations;
}

export function readCompleteTerminalOutputLinks(
  repositories: StorageV2RepositorySet,
  attemptIds: string[],
  operation: "verifier" | "transition"
): StorageToolOutputLink[] {
  const count = repositories.trace.countOutputLinksForAttempts(attemptIds);
  if (count > MAX_TERMINAL_JOB_ROWS) throw new Error(`Canonical terminal ${operation} output-link readback exceeds the bounded complete-set limit.`);
  const links = repositories.trace.listOutputLinksForAttempts(attemptIds, MAX_TERMINAL_JOB_ROWS);
  if (links.length !== count) throw new Error(`Canonical terminal ${operation} output-link readback is incomplete.`);
  return links;
}
