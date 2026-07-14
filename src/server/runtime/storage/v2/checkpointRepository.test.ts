import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { CheckpointRepository, CheckpointRetryConflictError, StepAttemptRetryConflictError } from "./checkpointRepository.js";
import { createStorageV2Repositories } from "./repositories.js";
import { migrateStorageV2Schema } from "./schema.js";
import type { StorageCheckpoint, StorageStepAttempt } from "./types.js";

describe("checkpoint retry immutability", () => {
  it("returns the first committed checkpoint and rejects every divergent persisted field without updating it", () => {
    const db = migratedDatabase();
    const checkpoints = createStorageV2Repositories({ appDb: db }).checkpoints;
    const value: StorageCheckpoint = {
      id: "checkpoint-private",
      projectId: "project-private",
      jobId: "job-private",
      attemptId: "attempt-private",
      step: "EXECUTE_TOOLS",
      checkpointKey: "attempt-1-EXECUTE_TOOLS-committed",
      status: "committed",
      data: { z: 2, nested: { b: true, a: "value" } },
      outputRef: "staging/private-output",
      error: "persisted-safe-error",
      createdAt: "2026-07-14T00:00:02.000Z",
      committedAt: "2026-07-14T00:00:02.000Z"
    };
    const persisted = checkpoints.saveCheckpoint(value);
    db.exec(`create trigger reject_committed_checkpoint_update before update on checkpoints begin select raise(abort, 'unexpected checkpoint update'); end;`);

    expect(checkpoints.saveCheckpoint({ ...value, data: { nested: { a: "value", b: true }, z: 2 } })).toEqual(persisted);

    const conflicts: StorageCheckpoint[] = [
      { ...value, data: { privatePayload: "changed" } },
      { ...value, outputRef: "staging/private-other-output" },
      { ...value, error: "private-other-error" },
      { ...value, createdAt: "2026-07-14T00:00:03.000Z" },
      { ...value, committedAt: "2026-07-14T00:00:03.000Z" },
      { ...value, projectId: "project-private-other" },
      { ...value, jobId: "job-private-other" },
      { ...value, attemptId: "attempt-private-other" },
      { ...value, step: "SYNTHESIZE" },
      { ...value, checkpointKey: "attempt-1-SYNTHESIZE-committed" },
      { ...value, status: "failed" }
    ];
    for (const conflict of conflicts) {
      expect(() => checkpoints.saveCheckpoint(conflict)).toThrow(CheckpointRetryConflictError);
      expect(checkpoints.get(value.id)).toEqual(persisted);
    }
    expect(captureError(() => checkpoints.saveCheckpoint(conflicts[0] as StorageCheckpoint)).message).not.toMatch(
      /privatePayload|private-other|staging\/private/
    );
    db.close();
  });

  it("returns the first terminal step attempt and rejects divergent output, error, time, data, and identity fields", () => {
    const db = migratedDatabase();
    const checkpoints = createStorageV2Repositories({ appDb: db }).checkpoints;
    const value: StorageStepAttempt = {
      id: "step-attempt-private",
      projectId: "project-private",
      jobId: "job-private",
      step: "EXECUTE_TOOLS",
      attemptIndex: 1,
      status: "completed",
      workerId: "worker-private",
      checkpointId: "checkpoint-private",
      quarantineRef: "quarantine/private",
      inputHash: "input-private",
      outputHash: "output-private",
      data: { z: 2, nested: { b: true, a: "value" } },
      error: "persisted-safe-error",
      startedAt: "2026-07-14T00:00:01.000Z",
      completedAt: "2026-07-14T00:00:02.000Z"
    };
    const persisted = checkpoints.recordStepAttempt(value);
    db.exec(`create trigger reject_terminal_attempt_update before update on step_attempts begin select raise(abort, 'unexpected attempt update'); end;`);

    expect(checkpoints.recordStepAttempt({ ...value, data: { nested: { a: "value", b: true }, z: 2 } })).toEqual(persisted);

    const conflicts: StorageStepAttempt[] = [
      { ...value, data: { privatePayload: "changed" } },
      { ...value, outputHash: "output-private-other" },
      { ...value, error: "private-other-error" },
      { ...value, startedAt: "2026-07-14T00:00:03.000Z" },
      { ...value, completedAt: "2026-07-14T00:00:03.000Z" },
      { ...value, projectId: "project-private-other" },
      { ...value, jobId: "job-private-other" },
      { ...value, step: "SYNTHESIZE" },
      { ...value, attemptIndex: 2 },
      { ...value, workerId: "worker-private-other" },
      { ...value, checkpointId: "checkpoint-private-other" },
      { ...value, quarantineRef: "quarantine/private-other" },
      { ...value, inputHash: "input-private-other" },
      { ...value, status: "failed" }
    ];
    for (const conflict of conflicts) {
      expect(() => checkpoints.recordStepAttempt(conflict)).toThrow(StepAttemptRetryConflictError);
      expect(checkpoints.listStepAttempts(value.jobId)).toEqual([persisted]);
    }
    expect(captureError(() => checkpoints.recordStepAttempt(conflicts[0] as StorageStepAttempt)).message).not.toMatch(
      /privatePayload|private-other|output-private/
    );
    db.close();
  });
});

describe("checkpoint ordering", () => {
  it("uses the immutable checkpoint id as the deterministic tie-break for equal timestamps", () => {
    const db = new DatabaseSync(":memory:");
    try {
      migrateStorageV2Schema(db);
      const repository = new CheckpointRepository(db);
      repository.saveCheckpoint(checkpoint("checkpoint-a"));
      repository.saveCheckpoint(checkpoint("checkpoint-z"));
      expect(repository.latestCommittedForJob("job-checkpoint-order")?.id).toBe("checkpoint-z");
    } finally {
      db.close();
    }
  });
});

function checkpoint(id: string) {
  return {
    id,
    projectId: "project-checkpoint-order",
    jobId: "job-checkpoint-order",
    step: "EXECUTE_TOOLS",
    checkpointKey: id,
    status: "committed" as const,
    createdAt: "2026-07-14T00:00:00.000Z",
    committedAt: "2026-07-14T00:00:00.000Z"
  };
}

function migratedDatabase(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  migrateStorageV2Schema(db);
  return db;
}

function captureError(action: () => unknown): Error {
  try {
    action();
  } catch (error) {
    if (error instanceof Error) return error;
  }
  throw new Error("Expected an Error to be thrown.");
}
