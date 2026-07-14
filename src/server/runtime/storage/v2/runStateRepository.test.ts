import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { createCanonicalRunFixture } from "../../../../../tests/fixtures/canonicalRunState.js";
import { createStorageV2Repositories, type StorageV2RepositorySet } from "./repositories.js";
import { StorageImmutableConflictError, StorageOwnershipConflictError, StorageRevisionConflictError } from "./runStateErrors.js";
import { storageCanonicalHasher } from "./runStatePayloadValidator.js";
import type { StorageRunStateRevisionInput, StorageTaskContractInput } from "./runStateTypes.js";
import { migrateStorageV2Schema } from "./schema.js";

const PROJECT_ID = "project-state";
const RUN_ID = "run-state";
const TASK_ID = "task-state";
const JOB_ID = "job-state";
const NOW = "2026-07-14T00:00:00.000Z";
const canonical = createCanonicalRunFixture({ projectId: PROJECT_ID, runId: RUN_ID, taskId: TASK_ID, createdAt: NOW });

describe("durable canonical run-state repository", () => {
  it("persists immutable task, context, and contiguous state revisions idempotently", () => {
    const fixture = createFixture();
    try {
      const contract = taskContract();
      expect(fixture.repositories.runState.saveTaskContract(contract)).toEqual(contract);
      expect(fixture.repositories.runState.saveTaskContract(structuredClone(contract))).toEqual(contract);
      fixture.repositories.jobs.enqueue(jobInput(JOB_ID));

      const revision0 = stateRevision(0, JOB_ID);
      expect(fixture.repositories.runState.commitRevision({ expectedRevision: null, revision: revision0 })).toEqual(revision0);
      expect(fixture.repositories.runState.commitRevision({ expectedRevision: null, revision: structuredClone(revision0) })).toEqual(revision0);

      const context = contextPack(JOB_ID, 0);
      expect(fixture.repositories.runState.saveContextPack({ expectedRevision: 0, contextPack: context })).toEqual(context);
      const revision1 = stateRevision(1, JOB_ID, context.id);
      expect(fixture.repositories.runState.commitRevision({ expectedRevision: 0, revision: revision1 })).toEqual(revision1);
      const latestContext = contextPack(JOB_ID, 1);
      expect(fixture.repositories.runState.saveContextPack({ expectedRevision: 1, contextPack: latestContext })).toEqual(latestContext);

      const owner = { projectId: PROJECT_ID, runId: RUN_ID, jobId: JOB_ID };
      expect(fixture.repositories.runState.latestRevision(owner)).toEqual(revision1);
      expect(fixture.repositories.runState.latestContextPack(owner)).toEqual(latestContext);
      expect(fixture.repositories.runState.listRevisions(owner)).toEqual([revision0, revision1]);
      expect(fixture.repositories.runState.listContextPacks(owner, 0)).toEqual([context]);
      expect(fixture.db.prepare("select count(*) count from run_job_links").get()).toEqual({ count: 1 });
      expect(() => fixture.db.prepare("update run_state_revisions set state_hash=? where id=?").run("e".repeat(64), revision1.id)).toThrow(/immutable/);
    } finally {
      fixture.db.close();
    }
  });

  it("selects the last persisted ContextPack when compilations share a revision and timestamp", () => {
    const fixture = createFixture();
    try {
      fixture.repositories.runState.saveTaskContract(taskContract());
      fixture.repositories.jobs.enqueue(jobInput(JOB_ID));
      fixture.repositories.runState.commitRevision({ expectedRevision: null, revision: stateRevision(0, JOB_ID) });
      const candidates = [canonical.contextPack(JOB_ID, 0, "offline-zulu"), canonical.contextPack(JOB_ID, 0, "offline-alpha")];
      const [first, second] = candidates[0]!.id.localeCompare(candidates[1]!.id) > 0 ? candidates : [candidates[1]!, candidates[0]!];
      expect(first.recordedAt).toBe(second.recordedAt);
      expect(first.id.localeCompare(second.id)).toBeGreaterThan(0);
      fixture.repositories.runState.saveContextPack({ expectedRevision: 0, contextPack: first });
      fixture.repositories.runState.saveContextPack({ expectedRevision: 0, contextPack: second });

      expect(fixture.repositories.runState.latestContextPack({ projectId: PROJECT_ID, runId: RUN_ID, jobId: JOB_ID })).toEqual(second);
    } finally {
      fixture.db.close();
    }
  });

  it("rolls back stale, broken-hash-chain, and immutable identifier conflicts", () => {
    const fixture = createFixture();
    try {
      fixture.repositories.runState.saveTaskContract(taskContract());
      fixture.repositories.jobs.enqueue(jobInput(JOB_ID));
      fixture.repositories.runState.commitRevision({ expectedRevision: null, revision: stateRevision(0, JOB_ID) });

      expect(() => fixture.repositories.runState.commitRevision({ expectedRevision: null, revision: stateRevision(1, JOB_ID) })).toThrow(
        StorageRevisionConflictError
      );
      const broken = stateRevision(1, JOB_ID);
      const wrongParentHash = "f".repeat(64);
      expect(() =>
        fixture.repositories.runState.commitRevision({
          expectedRevision: 0,
          revision: withParentHash(broken, wrongParentHash)
        })
      ).toThrow(StorageRevisionConflictError);
      expect(() => fixture.repositories.runState.saveTaskContract(conflictingTaskContract())).toThrow(StorageImmutableConflictError);
      expect(fixture.db.prepare("select count(*) count from run_state_revisions").get()).toEqual({ count: 1 });
    } finally {
      fixture.db.close();
    }
  });

  it("rejects unrelated project, run, job, task, and context ownership", () => {
    const fixture = createFixture();
    try {
      fixture.repositories.runState.saveTaskContract(taskContract());
      fixture.repositories.jobs.enqueue(jobInput(JOB_ID));
      fixture.repositories.runState.commitRevision({ expectedRevision: null, revision: stateRevision(0, JOB_ID) });
      fixture.repositories.jobs.enqueue(jobInput("job-unrelated"));

      expect(() => fixture.repositories.runState.commitRevision({ expectedRevision: 0, revision: stateRevision(1, "job-unrelated") })).toThrow(
        StorageOwnershipConflictError
      );
      expect(() => fixture.repositories.runState.latestRevision({ projectId: "project-other", runId: RUN_ID, jobId: JOB_ID })).toThrow(
        StorageOwnershipConflictError
      );
      expect(() =>
        fixture.repositories.runState.saveContextPack({
          expectedRevision: 0,
          contextPack: { ...contextPack(JOB_ID, 0), taskContractId: "task-other" }
        })
      ).toThrow(StorageOwnershipConflictError);
      expect(fixture.db.prepare("select count(*) count from context_packs").get()).toEqual({ count: 0 });
    } finally {
      fixture.db.close();
    }
  });

  it("continues one canonical run only through an immutable committed-checkpoint resume lineage", () => {
    const fixture = createFixture();
    try {
      fixture.repositories.runState.saveTaskContract(taskContract());
      fixture.repositories.jobs.enqueue(jobInput(JOB_ID));
      const revision0 = stateRevision(0, JOB_ID);
      fixture.repositories.runState.commitRevision({ expectedRevision: null, revision: revision0 });
      interruptWithCheckpoint(fixture.db, JOB_ID, "checkpoint-state");
      fixture.repositories.jobs.enqueue(jobInput("job-resume", JOB_ID, "checkpoint-state"));

      const resumedOwner = { projectId: PROJECT_ID, runId: RUN_ID, jobId: "job-resume" };
      expect(fixture.repositories.runState.latestRevision(resumedOwner)).toEqual(revision0);
      expect(fixture.db.prepare("select count(*) count from run_job_links").get()).toEqual({ count: 1 });

      const context = contextPack("job-resume", 0);
      fixture.repositories.runState.saveContextPack({ expectedRevision: 0, contextPack: context });
      const revision1 = stateRevision(1, "job-resume", context.id);
      fixture.repositories.runState.commitRevision({ expectedRevision: 0, revision: revision1 });
      expect(fixture.repositories.runState.latestRevision(resumedOwner)).toEqual(revision1);
      expect(fixture.db.prepare("select predecessor_job_id,resume_checkpoint_id from run_job_links where job_id='job-resume'").get()).toEqual({
        predecessor_job_id: JOB_ID,
        resume_checkpoint_id: "checkpoint-state"
      });
      expect(fixture.db.prepare("select job_id,lineage_sequence from run_job_links order by lineage_sequence").all()).toEqual([
        { job_id: JOB_ID, lineage_sequence: 1 },
        { job_id: "job-resume", lineage_sequence: 2 }
      ]);
      expect(() => fixture.repositories.runState.latestRevision({ projectId: PROJECT_ID, runId: RUN_ID, jobId: JOB_ID })).toThrow(
        StorageOwnershipConflictError
      );
    } finally {
      fixture.db.close();
    }
  });

  it("rejects forged core payloads before immutable rows are inserted", () => {
    const fixture = createFixture();
    try {
      const contract = taskContract();
      expect(() =>
        fixture.repositories.runState.saveTaskContract({
          ...contract,
          data: { ...(contract.data as Record<string, unknown>), goal: "Forged without updating the canonical hash." }
        })
      ).toThrow(/hash/i);
      expect(fixture.db.prepare("select count(*) count from task_contracts").get()).toEqual({ count: 0 });

      fixture.repositories.runState.saveTaskContract(contract);
      fixture.repositories.jobs.enqueue(jobInput(JOB_ID));
      const revision0 = stateRevision(0, JOB_ID);
      expect(() =>
        fixture.repositories.runState.commitRevision({
          expectedRevision: null,
          revision: { ...revision0, data: { ...(revision0.data as Record<string, unknown>), updatedAt: "2026-07-14T00:00:01.000Z" } }
        })
      ).toThrow(/hash/i);
      expect(fixture.db.prepare("select count(*) count from run_state_revisions").get()).toEqual({ count: 0 });

      fixture.repositories.runState.commitRevision({ expectedRevision: null, revision: revision0 });
      const pack = contextPack(JOB_ID, 0);
      const body = pack.data as Record<string, unknown>;
      const contentCanary = "CONTEXT_PROVIDER_INPUT_CANARY";
      expect(() =>
        fixture.repositories.runState.saveContextPack({
          expectedRevision: 0,
          contextPack: { ...pack, data: { ...body, providerInput: contentCanary } }
        })
      ).toThrow();
      expect(fixture.db.prepare("select count(*) count from context_packs").get()).toEqual({ count: 0 });
      expect(JSON.stringify(fixture.db.prepare("select data from context_packs").all())).not.toContain(contentCanary);
    } finally {
      fixture.db.close();
    }
  });
});

function createFixture(): { db: DatabaseSync; repositories: StorageV2RepositorySet } {
  const db = new DatabaseSync(":memory:");
  migrateStorageV2Schema(db);
  db.prepare(
    `insert into projects_v2 (id,short_id,project_root,topic,status,created_at,updated_at,data)
     values (?,?,?,?,?,?,?,?)`
  ).run(
    PROJECT_ID,
    "state",
    "state-root",
    "state",
    "active",
    NOW,
    NOW,
    JSON.stringify({ id: PROJECT_ID, projectRoot: "state-root", topic: "state", status: "active", createdAt: NOW, updatedAt: NOW })
  );
  return { db, repositories: createStorageV2Repositories({ appDb: db }) };
}

function taskContract(): StorageTaskContractInput {
  return canonical.taskContract();
}

function stateRevision(revision: 0 | 1, jobId: string, contextPackId?: string): StorageRunStateRevisionInput {
  return canonical.revision(revision, jobId, contextPackId);
}

function contextPack(jobId: string, stateRevision: number) {
  return canonical.contextPack(jobId, stateRevision);
}

function withParentHash(revision: StorageRunStateRevisionInput, parentRevisionHash: string): StorageRunStateRevisionInput {
  const { stateHash: ignored, ...payload } = revision.data as Record<string, unknown>;
  void ignored;
  const nextPayload = { ...payload, parentRevisionHash };
  const stateHash = storageCanonicalHasher.sha256Canonical(nextPayload);
  return { ...revision, parentRevisionHash, stateHash, data: { ...nextPayload, stateHash } };
}

function conflictingTaskContract(): StorageTaskContractInput {
  const current = taskContract();
  const { contentHash: ignored, ...payload } = current.data as Record<string, unknown>;
  void ignored;
  const nextPayload = { ...payload, goal: "Persist a different canonical state." };
  const contentHash = storageCanonicalHasher.sha256Canonical(nextPayload);
  return { ...current, contentHash, data: { ...nextPayload, contentHash } };
}

function jobInput(id: string, resumesJobId?: string, resumeCheckpointId?: string) {
  return {
    id,
    projectId: PROJECT_ID,
    operation: "research_loop",
    createdAt: NOW,
    queuedAt: NOW,
    payload: {
      projectRevision: 1,
      currentStep: "PLAN_RESEARCH",
      ...(resumesJobId ? { resumesJobId, resumeCheckpointId } : {})
    }
  };
}

function interruptWithCheckpoint(db: DatabaseSync, jobId: string, checkpointId: string): void {
  db.prepare("update jobs set status='interrupted',completed_at=?,updated_at=? where id=?").run(NOW, NOW, jobId);
  db.prepare(
    `insert into checkpoints
     (id,project_id,job_id,step,checkpoint_key,status,created_at,committed_at,data)
     values (?,?,?,?,?,'committed',?,?,?)`
  ).run(checkpointId, PROJECT_ID, jobId, "PLAN_RESEARCH", "resume", NOW, NOW, "{}");
}
