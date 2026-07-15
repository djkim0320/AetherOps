import type { DatabaseSync } from "node:sqlite";
import { rowToToolAttempt } from "./traceMappers.js";
import type { StorageToolAttempt } from "./traceTypes.js";
import type { Row } from "./repositorySupport.js";

const MAX_ACTIVE_ATTEMPTS = 1_000;

export function countActiveToolAttempts(db: DatabaseSync, jobId: string): number {
  const row = db.prepare("select count(*) count from tool_attempts where job_id=? and status in ('queued','running')").get(jobId) as
    { count?: unknown } | undefined;
  const count = Number(row?.count ?? 0);
  if (!Number.isSafeInteger(count) || count < 0) throw new Error("Active tool-attempt count is invalid.");
  return count;
}

export function interruptActiveToolAttempts(db: DatabaseSync, jobId: string, completedAt: string, error: string, terminalCause: string): StorageToolAttempt[] {
  const active = (
    db.prepare("select * from tool_attempts where job_id=? and status in ('queued','running') order by ordinal,queued_at,id").all(jobId) as Row[]
  ).map(rowToToolAttempt);
  if (active.length > MAX_ACTIVE_ATTEMPTS) throw new Error("Active tool-attempt settlement exceeds its bounded transaction window.");
  if (!active.length) return [];
  db.prepare(
    `update tool_attempts set status='interrupted',terminal_cause=?,error=?,completed_at=?
     where job_id=? and status in ('queued','running')`
  ).run(terminalCause, error, completedAt, jobId);
  return active.map((attempt) => requiredAttempt(db, attempt.id));
}

function requiredAttempt(db: DatabaseSync, attemptId: string): StorageToolAttempt {
  const row = db.prepare("select * from tool_attempts where id=?").get(attemptId) as Row | undefined;
  if (!row) throw new Error("Interrupted tool attempt readback is missing.");
  return rowToToolAttempt(row);
}
