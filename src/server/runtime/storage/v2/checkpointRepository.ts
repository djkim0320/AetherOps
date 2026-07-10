import { DatabaseSync } from "node:sqlite";
import type { StorageCheckpoint, StorageStepAttempt } from "./types.js";
import { json, requiredCheckpoint, requiredStepAttempt, rowToCheckpoint, rowToStepAttempt, type Row } from "./repositorySupport.js";

export class CheckpointRepository {
  constructor(private readonly db: DatabaseSync) {}
  saveCheckpoint(value: StorageCheckpoint): StorageCheckpoint {
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
}
