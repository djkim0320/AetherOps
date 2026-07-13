import { DatabaseSync } from "node:sqlite";
import { isDeepStrictEqual } from "node:util";
import type { StorageCheckpoint, StorageStepAttempt } from "./types.js";
import { json, requiredCheckpoint, requiredStepAttempt, rowToCheckpoint, rowToStepAttempt, type Row } from "./repositorySupport.js";

export class CheckpointRepository {
  constructor(private readonly db: DatabaseSync) {}
  saveCheckpoint(value: StorageCheckpoint): StorageCheckpoint {
    const existing = this.get(value.id);
    if (existing) {
      assertCheckpointUpdate(existing, value);
      if (existing.status === "committed") return existing;
    }
    this.db
      .prepare(
        `insert into checkpoints (id, project_id, job_id, attempt_id, step, checkpoint_key, status, output_ref, error, created_at, committed_at, data)
      values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      on conflict(id) do update set attempt_id=excluded.attempt_id, step=excluded.step, checkpoint_key=excluded.checkpoint_key,
      status=excluded.status, output_ref=excluded.output_ref, error=excluded.error, committed_at=excluded.committed_at, data=excluded.data`
      )
      .run(
        value.id,
        value.projectId,
        value.jobId,
        value.attemptId ?? null,
        value.step,
        value.checkpointKey,
        value.status,
        value.outputRef ?? null,
        value.error ?? null,
        value.createdAt,
        value.committedAt ?? null,
        value.data === undefined ? null : json(value.data)
      );
    return requiredCheckpoint(this.get(value.id), value.id);
  }
  get(id: string): StorageCheckpoint | undefined {
    const row = this.db.prepare("select * from checkpoints where id = ?").get(id) as Row | undefined;
    return row ? rowToCheckpoint(row) : undefined;
  }
  latestCommittedForJob(jobId: string): StorageCheckpoint | undefined {
    const row = this.db
      .prepare("select * from checkpoints where job_id=? and status='committed' order by committed_at desc, created_at desc limit 1")
      .get(jobId) as Row | undefined;
    return row ? rowToCheckpoint(row) : undefined;
  }
  listForJob(jobId: string): StorageCheckpoint[] {
    return (this.db.prepare("select * from checkpoints where job_id=? order by created_at").all(jobId) as Row[]).map(rowToCheckpoint);
  }
  recordStepAttempt(value: StorageStepAttempt): StorageStepAttempt {
    const existingRow = this.db.prepare("select * from step_attempts where id=?").get(value.id) as Row | undefined;
    const existing = existingRow ? rowToStepAttempt(existingRow) : undefined;
    if (existing) {
      assertStepAttemptUpdate(existing, value);
      if (terminalStepAttemptStatuses.has(existing.status)) return existing;
    }
    this.db
      .prepare(
        `insert into step_attempts (id, project_id, job_id, step, attempt_index, status, worker_id, checkpoint_id,
      quarantine_ref, input_hash, output_hash, error, started_at, completed_at, data) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      on conflict(id) do update set status=excluded.status, worker_id=excluded.worker_id, checkpoint_id=excluded.checkpoint_id,
      quarantine_ref=excluded.quarantine_ref, input_hash=excluded.input_hash, output_hash=excluded.output_hash,
      error=excluded.error, completed_at=excluded.completed_at, data=excluded.data`
      )
      .run(
        value.id,
        value.projectId,
        value.jobId,
        value.step,
        value.attemptIndex,
        value.status,
        value.workerId ?? null,
        value.checkpointId ?? null,
        value.quarantineRef ?? null,
        value.inputHash ?? null,
        value.outputHash ?? null,
        value.error ?? null,
        value.startedAt,
        value.completedAt ?? null,
        value.data === undefined ? null : json(value.data)
      );
    const row = this.db.prepare("select * from step_attempts where id=?").get(value.id) as Row | undefined;
    return requiredStepAttempt(row ? rowToStepAttempt(row) : undefined, value.id);
  }
  listStepAttempts(jobId: string): StorageStepAttempt[] {
    return (this.db.prepare("select * from step_attempts where job_id=? order by started_at, attempt_index").all(jobId) as Row[]).map(rowToStepAttempt);
  }

  interruptRunningStepAttempts(jobId: string, completedAt: string, error: string): StorageStepAttempt[] {
    this.db.prepare("update step_attempts set status='interrupted',error=?,completed_at=? where job_id=? and status='running'").run(error, completedAt, jobId);
    return this.listStepAttempts(jobId).filter((attempt) => attempt.status === "interrupted" && attempt.completedAt === completedAt);
  }
}

const checkpointTransitions: Readonly<Record<StorageCheckpoint["status"], readonly StorageCheckpoint["status"][]>> = {
  pending: ["pending", "committed", "quarantined", "failed"],
  committed: ["committed"],
  quarantined: ["quarantined"],
  failed: ["failed"]
};

function assertCheckpointUpdate(existing: StorageCheckpoint, next: StorageCheckpoint): void {
  if (existing.status === "committed") {
    if (!isDeepStrictEqual(checkpointPersistedFields(existing), checkpointPersistedFields(next))) {
      throw new CheckpointRetryConflictError();
    }
    return;
  }
  if (
    existing.projectId !== next.projectId ||
    existing.jobId !== next.jobId ||
    existing.step !== next.step ||
    existing.checkpointKey !== next.checkpointKey ||
    (existing.attemptId !== undefined && existing.attemptId !== next.attemptId)
  ) {
    throw new Error(`Checkpoint identity conflict: ${existing.id}.`);
  }
  if (!checkpointTransitions[existing.status].includes(next.status)) {
    throw new Error(`Invalid checkpoint transition for ${existing.id}: ${existing.status} -> ${next.status}.`);
  }
}

const terminalStepAttemptStatuses = new Set<StorageStepAttempt["status"]>(["completed", "failed", "interrupted", "quarantined"]);

function assertStepAttemptUpdate(existing: StorageStepAttempt, next: StorageStepAttempt): void {
  if (terminalStepAttemptStatuses.has(existing.status)) {
    if (!isDeepStrictEqual(stepAttemptPersistedFields(existing), stepAttemptPersistedFields(next))) {
      throw new StepAttemptRetryConflictError();
    }
    return;
  }
  if (
    existing.projectId !== next.projectId ||
    existing.jobId !== next.jobId ||
    existing.step !== next.step ||
    existing.attemptIndex !== next.attemptIndex ||
    existing.startedAt !== next.startedAt
  ) {
    throw new Error(`Step attempt identity conflict: ${existing.id}.`);
  }
}

function checkpointPersistedFields(value: StorageCheckpoint): Record<string, unknown> {
  return {
    id: value.id,
    projectId: value.projectId,
    jobId: value.jobId,
    attemptId: persistedOptionalString(value.attemptId),
    step: value.step,
    checkpointKey: value.checkpointKey,
    status: value.status,
    data: persistedJsonValue(value.data),
    outputRef: persistedOptionalString(value.outputRef),
    error: persistedOptionalString(value.error),
    createdAt: value.createdAt,
    committedAt: persistedOptionalString(value.committedAt)
  };
}

function stepAttemptPersistedFields(value: StorageStepAttempt): Record<string, unknown> {
  return {
    id: value.id,
    projectId: value.projectId,
    jobId: value.jobId,
    step: value.step,
    attemptIndex: value.attemptIndex,
    status: value.status,
    workerId: persistedOptionalString(value.workerId),
    checkpointId: persistedOptionalString(value.checkpointId),
    quarantineRef: persistedOptionalString(value.quarantineRef),
    inputHash: persistedOptionalString(value.inputHash),
    outputHash: persistedOptionalString(value.outputHash),
    data: persistedJsonValue(value.data),
    error: persistedOptionalString(value.error),
    startedAt: value.startedAt,
    completedAt: persistedOptionalString(value.completedAt)
  };
}

function persistedJsonValue(value: unknown): unknown {
  return value === undefined ? undefined : (JSON.parse(json(value)) as unknown);
}

function persistedOptionalString(value: string | undefined): string | undefined {
  return typeof value === "string" && value.length ? value : undefined;
}

export class CheckpointRetryConflictError extends Error {
  constructor() {
    super("Checkpoint retry conflicts with the persisted checkpoint.");
    this.name = "CheckpointRetryConflictError";
  }
}

export class StepAttemptRetryConflictError extends Error {
  constructor() {
    super("Step attempt retry conflicts with the persisted terminal attempt.");
    this.name = "StepAttemptRetryConflictError";
  }
}
