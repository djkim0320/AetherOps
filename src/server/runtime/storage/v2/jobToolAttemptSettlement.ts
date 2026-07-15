import { jobAtomicId } from "./jobAtomicIds.js";
import type { StorageV2RepositorySet } from "./repositories.js";
import type { StorageJob, StorageJobEvent } from "./types.js";
import type { StorageToolAttempt } from "./traceTypes.js";

export interface StorageToolAttemptSettlement {
  attempts: StorageToolAttempt[];
  events: StorageJobEvent[];
}

export function assertNoActiveToolAttempts(repositories: StorageV2RepositorySet, jobId: string): void {
  if (repositories.trace.countActiveToolAttempts(jobId) !== 0) {
    throw new Error("A completed durable job cannot retain queued or running tool attempts.");
  }
}

export function interruptTerminalToolAttempts(
  repositories: StorageV2RepositorySet,
  job: StorageJob,
  projectRevision: number,
  completedAt: string,
  reason: string,
  terminalCause: string
): StorageToolAttemptSettlement {
  const attempts = repositories.trace.interruptActiveToolAttempts(job.id, completedAt, reason, terminalCause);
  const events = attempts.map((attempt) => {
    repositories.toolSideEffects.observeAttempt(attempt);
    const decision = repositories.trace.getToolDecision(attempt.decisionId);
    if (!decision || decision.jobId !== job.id || decision.projectId !== job.projectId) {
      throw new Error("Interrupted tool attempt is missing its owned decision trace.");
    }
    return repositories.events.append({
      eventId: jobAtomicId("event", attempt.id, terminalCause),
      projectId: job.projectId,
      jobId: job.id,
      type: "tool.run.changed",
      createdAt: completedAt,
      payload: {
        projectRevision,
        data: {
          jobId: job.id,
          decisionId: attempt.decisionId,
          attemptId: attempt.id,
          ordinal: attempt.ordinal,
          toolName: decision.toolName,
          status: "interrupted"
        }
      }
    });
  });
  return { attempts, events };
}
