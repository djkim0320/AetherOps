import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { recordCapabilityAuditSet } from "./capabilityAuditAtomic.js";
import { StorageV2Database } from "./connection.js";
import { IdempotencyConflictError } from "./jobErrors.js";
import { enqueueJob } from "./jobEnqueueAtomic.js";
import { finalizeProjectMutation, markProjectMutationLegacyApplied, prepareProjectMutation } from "./projectMutationAtomic.js";
import { ProjectMutationReservationConflictError } from "./projectMutationTypes.js";
import { commitProjectSnapshot } from "./projectSnapshotAtomic.js";
import { StorageRevisionConflictError } from "./runStateErrors.js";
import { storageCanonicalHasher } from "./runStatePayloadValidator.js";
import { migrateStorageV2Schema } from "./schema.js";
import type { StorageCapabilityAudit, StorageJobInput, StorageJsonObject } from "./types.js";

const roots: string[] = [];
const requestHash = "1".repeat(64);
const beforeHash = "2".repeat(64);
const receiptHash = "3".repeat(64);
const snapshotHash = "4".repeat(64);

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("project mutation roll-forward journal", () => {
  it("reserves an absent create project and atomically finalizes revision one", () => {
    const fixture = createFixture();
    const project = projectPayload(fixture.root, "project-create", "2026-07-16T00:00:03.000Z");
    try {
      const prepared = fixture.storage.transaction((repositories) => prepareProjectMutation(repositories, prepareInput(project.id)));
      expect(prepared).toMatchObject({ exactReplay: false, journal: { state: "prepared", projectId: project.id, expectedProjectRevision: 0 } });
      const replay = fixture.storage.transaction((repositories) => prepareProjectMutation(repositories, prepareInput(project.id)));
      expect(replay).toMatchObject({ exactReplay: true, journal: { operationId: prepared.journal.operationId } });
      expect(() =>
        fixture.storage.transaction((repositories) => prepareProjectMutation(repositories, { ...prepareInput(project.id), requestHash: "9".repeat(64) }))
      ).toThrow(IdempotencyConflictError);
      expect(() => fixture.storage.repositories.projects.upsert(project)).toThrow(ProjectMutationReservationConflictError);
      expect(() =>
        fixture.storage.transaction((repositories) => prepareProjectMutation(repositories, { ...prepareInput(project.id), requestId: "request-other" }))
      ).toThrow(ProjectMutationReservationConflictError);

      const legacy = fixture.storage.transaction((repositories) =>
        markProjectMutationLegacyApplied(repositories, {
          operationId: prepared.journal.operationId,
          legacyReceiptHash: receiptHash,
          snapshotHash,
          appliedAt: "2026-07-16T00:00:02.000Z"
        })
      );
      expect(legacy).toMatchObject({ exactReplay: false, journal: { state: "legacy_applied" } });
      const publicResult = { project: { id: project.id }, projectRevision: 1 };
      const publicResultHash = storageCanonicalHasher.sha256Canonical(publicResult);
      const finalizeInput = {
        operationId: prepared.journal.operationId,
        project,
        eventId: "project-create-snapshot",
        snapshotHash,
        occurredAt: "2026-07-16T00:00:03.000Z",
        publicResult,
        publicResultHash
      } as const;
      const finalized = fixture.storage.transaction((repositories) => finalizeProjectMutation(repositories, finalizeInput));
      expect(finalized).toMatchObject({ exactReplay: false, projectRevision: 1, journal: { state: "finalized", publicResultHash } });
      expect(fixture.storage.repositories.projectRevisions.current(project.id)).toMatchObject({ revision: 1 });
      expect(fixture.storage.repositories.projectMutations.listPending()).toEqual({ mutations: [] });
      const replayedFinalize = fixture.storage.transaction((repositories) => finalizeProjectMutation(repositories, finalizeInput));
      expect(replayedFinalize).toMatchObject({ exactReplay: true, projectRevision: 1, publicResultHash });
      expect(fixture.storage.repositories.events.after(project.id)).toHaveLength(1);
      expect(readCounts(fixture.path, project.id)).toEqual({ revisions: 1, events: 1, finalized: 1 });
    } finally {
      fixture.storage.close();
    }
  });

  it("rejects preparation over queued work and rejects revision mutations while reserved", () => {
    const fixture = createFixture();
    const project = projectPayload(fixture.root, "project-existing", "2026-07-16T00:00:00.000Z");
    try {
      fixture.storage.repositories.projects.upsert(project);
      fixture.storage.repositories.jobs.enqueue({ id: "queued-job", projectId: project.id, operation: "chat", createdAt: project.createdAt });
      expect(() =>
        fixture.storage.transaction((repositories) =>
          prepareProjectMutation(repositories, { ...prepareInput(project.id, "projects.update"), expectedProjectRevision: 0 })
        )
      ).toThrow(ProjectMutationReservationConflictError);
      fixture.storage.repositories.jobs.updateStatus("queued-job", { status: "aborted", completedAt: "2026-07-16T00:00:01.000Z" });
      const prepared = fixture.storage.transaction((repositories) =>
        prepareProjectMutation(repositories, { ...prepareInput(project.id, "projects.update"), expectedProjectRevision: 0 })
      );
      expect(() =>
        fixture.storage.transaction((repositories) =>
          repositories.events.append({ eventId: "blocked-event", projectId: project.id, type: "run.status.changed", payload: { status: "idle" } })
        )
      ).toThrow(ProjectMutationReservationConflictError);
      expect(fixture.storage.repositories.events.get("blocked-event")).toBeUndefined();
      expect(fixture.storage.repositories.projectMutations.get(prepared.journal.operationId)?.state).toBe("prepared");
    } finally {
      fixture.storage.close();
    }
  });

  it("fails stale CAS and rolls finalization back to legacy_applied", () => {
    const fixture = createFixture();
    const owner = projectPayload(fixture.root, "project-owner", "2026-07-16T00:00:00.000Z");
    const target = projectPayload(fixture.root, "project-target", "2026-07-16T00:00:03.000Z");
    try {
      fixture.storage.repositories.projects.upsert(owner);
      expect(() =>
        fixture.storage.transaction((repositories) =>
          prepareProjectMutation(repositories, { ...prepareInput(owner.id, "projects.update"), expectedProjectRevision: 1 })
        )
      ).toThrow(/revision changed/i);
      const prepared = fixture.storage.transaction((repositories) => prepareProjectMutation(repositories, prepareInput(target.id)));
      fixture.storage.transaction((repositories) =>
        markProjectMutationLegacyApplied(repositories, {
          operationId: prepared.journal.operationId,
          legacyReceiptHash: receiptHash,
          snapshotHash,
          appliedAt: "2026-07-16T00:00:02.000Z"
        })
      );
      seedConcurrentRevision(fixture.path, target);
      const publicResult = { projectId: target.id, projectRevision: 1 };
      expect(() =>
        fixture.storage.transaction((repositories) =>
          finalizeProjectMutation(repositories, {
            operationId: prepared.journal.operationId,
            project: target,
            eventId: "rollback-event",
            snapshotHash,
            occurredAt: target.updatedAt,
            publicResult,
            publicResultHash: storageCanonicalHasher.sha256Canonical(publicResult)
          })
        )
      ).toThrow(StorageRevisionConflictError);
      expect(fixture.storage.repositories.projectMutations.get(prepared.journal.operationId)).toMatchObject({ state: "legacy_applied" });
      expect(fixture.storage.repositories.projects.get(target.id)).toEqual(target);
      expect(fixture.storage.repositories.events.get("rollback-event")).toBeUndefined();
    } finally {
      fixture.storage.close();
    }
  });

  it("rejects secret-bearing prepare commands", () => {
    const fixture = createFixture();
    try {
      expect(() =>
        fixture.storage.transaction((repositories) =>
          prepareProjectMutation(repositories, { ...prepareInput("project-secret"), command: { authorization: "Bearer secret" } })
        )
      ).toThrow(/prohibited field/i);
    } finally {
      fixture.storage.close();
    }
  });

  it("rejects unsafe public results without advancing a legacy-applied journal", () => {
    const fixture = createFixture();
    const project = projectPayload(fixture.root, "project-result-validation", "2026-07-16T00:00:03.000Z");
    try {
      const operationId = prepareLegacyApplied(fixture.storage, project.id);
      const base = {
        operationId,
        project,
        eventId: "project-result-validation-snapshot",
        snapshotHash,
        occurredAt: project.updatedAt
      } as const;
      const secretResult = { project: { id: project.id, metadata: { clientSecret: "must-not-persist" } } };
      expect(() =>
        fixture.storage.transaction((repositories) =>
          finalizeProjectMutation(repositories, {
            ...base,
            publicResult: secretResult,
            publicResultHash: storageCanonicalHasher.sha256Canonical(secretResult)
          })
        )
      ).toThrow(/prohibited field/i);

      const validResult = { projectId: project.id, projectRevision: 1 };
      expect(() =>
        fixture.storage.transaction((repositories) =>
          finalizeProjectMutation(repositories, { ...base, publicResult: validResult, publicResultHash: "f".repeat(64) })
        )
      ).toThrow(/hash does not match/i);

      const nonCanonical = {} as StorageJsonObject;
      Object.defineProperty(nonCanonical, "projectId", { enumerable: true, get: () => project.id });
      expect(() =>
        fixture.storage.transaction((repositories) =>
          finalizeProjectMutation(repositories, {
            ...base,
            publicResult: nonCanonical,
            publicResultHash: storageCanonicalHasher.sha256Canonical(nonCanonical)
          })
        )
      ).toThrow(/plain data properties/i);

      const oversizedResult = Object.fromEntries(Array.from({ length: 129 }, (_, index) => [`field${index}`, "x".repeat(1_024)]));
      expect(() =>
        fixture.storage.transaction((repositories) =>
          finalizeProjectMutation(repositories, {
            ...base,
            publicResult: oversizedResult,
            publicResultHash: storageCanonicalHasher.sha256Canonical(oversizedResult)
          })
        )
      ).toThrow(/exceeds its durable size limit/i);

      expect(fixture.storage.repositories.projectMutations.get(operationId)).toMatchObject({ state: "legacy_applied" });
      expect(fixture.storage.repositories.projects.get(project.id)).toBeUndefined();
      expect(fixture.storage.repositories.events.get(base.eventId)).toBeUndefined();
      expect(fixture.storage.repositories.projectRevisions.current(project.id)).toBeUndefined();
    } finally {
      fixture.storage.close();
    }
  });

  it("rolls back new enqueue work while reserved but permits an exact enqueue receipt replay", () => {
    const fixture = createFixture();
    const project = projectPayload(fixture.root, "project-enqueue-reservation", "2026-07-16T00:00:00.000Z");
    try {
      fixture.storage.repositories.projects.upsert(project);
      const original = enqueueInput("job-before-reservation", project.id, 0, "existing-enqueue", "existing-request", 1);
      const receipt = fixture.storage.transaction((repositories) => enqueueJob(repositories, original));
      fixture.storage.repositories.jobs.updateStatus(original.id, {
        status: "aborted",
        completedAt: "2026-07-16T00:00:01.000Z",
        updatedAt: "2026-07-16T00:00:01.000Z"
      });
      fixture.storage.transaction((repositories) =>
        prepareProjectMutation(repositories, {
          ...prepareInput(project.id, "projects.update"),
          expectedProjectRevision: 1,
          requestId: "request-enqueue-reservation"
        })
      );

      const replay = fixture.storage.transaction((repositories) =>
        enqueueJob(repositories, {
          ...original,
          id: "job-retry-different-id",
          expectedProjectRevision: 999,
          payload: { projectRevision: 999 }
        })
      );
      expect(replay.job).toEqual({
        ...receipt.job,
        status: "aborted",
        completedAt: "2026-07-16T00:00:01.000Z",
        updatedAt: "2026-07-16T00:00:01.000Z"
      });
      expect(replay.event).toEqual(receipt.event);
      expect(replay.capabilityAudits).toEqual(receipt.capabilityAudits);

      const rejected = enqueueInput("job-new-during-reservation", project.id, 1, "new-enqueue", "new-request", 2);
      expect(() => fixture.storage.transaction((repositories) => enqueueJob(repositories, rejected))).toThrow(ProjectMutationReservationConflictError);
      expect(fixture.storage.repositories.jobs.get(rejected.id)).toBeUndefined();
      expect(fixture.storage.repositories.projectRevisions.current(project.id)).toMatchObject({ revision: 1 });
      expect(fixture.storage.repositories.events.after(project.id)).toHaveLength(1);
    } finally {
      fixture.storage.close();
    }
  });

  it("rolls back capability-set projections and snapshot commits while reserved", () => {
    const fixture = createFixture();
    const project = projectPayload(fixture.root, "project-projection-reservation", "2026-07-16T00:00:00.000Z");
    try {
      fixture.storage.repositories.projects.upsert(project);
      fixture.storage.transaction((repositories) =>
        prepareProjectMutation(repositories, {
          ...prepareInput(project.id, "projects.update"),
          requestId: "request-projection-reservation"
        })
      );
      const changedProject = { ...project, topic: "must roll back", updatedAt: "2026-07-16T00:00:02.000Z" };

      expect(() => fixture.storage.transaction((repositories) => recordCapabilityAuditSet(repositories, capabilityAudits(project.id), changedProject))).toThrow(
        ProjectMutationReservationConflictError
      );
      expect(fixture.storage.repositories.capabilities.listProject(project.id)).toEqual([]);

      expect(() =>
        fixture.storage.transaction((repositories) =>
          commitProjectSnapshot(repositories, {
            project: changedProject,
            expectedProjectRevision: 0,
            eventId: "blocked-project-snapshot",
            snapshotHash: "8".repeat(64),
            occurredAt: changedProject.updatedAt,
            reason: "project_updated"
          })
        )
      ).toThrow(ProjectMutationReservationConflictError);
      expect(fixture.storage.repositories.projects.get(project.id)).toEqual(project);
      expect(fixture.storage.repositories.events.get("blocked-project-snapshot")).toBeUndefined();
      expect(fixture.storage.repositories.projectRevisions.current(project.id)).toMatchObject({ revision: 0 });
    } finally {
      fixture.storage.close();
    }
  });
});

function createFixture(): { root: string; path: string; storage: StorageV2Database } {
  const root = mkdtempSync(join(tmpdir(), "aetherops-project-mutation-"));
  roots.push(root);
  const path = join(root, "storage.sqlite");
  const db = new DatabaseSync(path);
  migrateStorageV2Schema(db);
  db.close();
  return { root, path, storage: new StorageV2Database({ appDbPath: path, vectorDbPath: path, ontologyDbPath: path }) };
}

function seedConcurrentRevision(path: string, project: ReturnType<typeof projectPayload>): void {
  const db = new DatabaseSync(path);
  try {
    db.exec("begin immediate");
    db.prepare("insert into projects_v2(id,short_id,project_root,topic,status,created_at,updated_at,data) values(?,?,?,?,?,?,?,?)").run(
      project.id,
      project.id,
      project.projectRoot,
      project.topic,
      project.status,
      project.createdAt,
      project.updatedAt,
      JSON.stringify(project)
    );
    db.prepare("insert into job_events(event_id,project_id,type,created_at,payload) values(?,?,?,?,?)").run(
      "concurrent-event",
      project.id,
      "project.snapshot.changed",
      project.updatedAt,
      JSON.stringify({ projectRevision: 1, data: { snapshotVersion: 1 } })
    );
    db.prepare(
      `insert into project_revision_receipts
      (id,schema_version,project_id,revision,mutation_id,mutation_hash,anchor_event_id,reason,committed_at) values(?,1,?,1,?,?,?,?,?)`
    ).run("concurrent-receipt", project.id, "concurrent-mutation", "9".repeat(64), "concurrent-event", "project_updated", project.updatedAt);
    db.prepare("insert into project_revision_event_links(event_id,receipt_id,project_id,revision,linked_at) values(?,?,?,1,?)").run(
      "concurrent-event",
      "concurrent-receipt",
      project.id,
      project.updatedAt
    );
    db.prepare("insert into project_revision_heads(project_id,revision,last_receipt_id,updated_at) values(?,1,?,?)").run(
      project.id,
      "concurrent-receipt",
      project.updatedAt
    );
    db.exec("commit");
  } catch (error) {
    if (db.isTransaction) db.exec("rollback");
    throw error;
  } finally {
    db.close();
  }
}

function prepareInput(projectId: string, method: "projects.create" | "projects.update" = "projects.create") {
  return {
    method,
    requestId: "request-create",
    requestHash,
    projectId,
    expectedProjectRevision: 0,
    command: { projectId, mutation: method },
    legacyBeforeHash: beforeHash,
    preparedAt: "2026-07-16T00:00:01.000Z"
  } as const;
}

function prepareLegacyApplied(storage: StorageV2Database, projectId: string): string {
  const prepared = storage.transaction((repositories) => prepareProjectMutation(repositories, prepareInput(projectId)));
  storage.transaction((repositories) =>
    markProjectMutationLegacyApplied(repositories, {
      operationId: prepared.journal.operationId,
      legacyReceiptHash: receiptHash,
      snapshotHash,
      appliedAt: "2026-07-16T00:00:02.000Z"
    })
  );
  return prepared.journal.operationId;
}

function enqueueInput(
  id: string,
  projectId: string,
  expectedProjectRevision: number,
  idempotencyKey: string,
  request: string,
  projectRevision: number
): StorageJobInput {
  return {
    id,
    projectId,
    operation: "chat",
    expectedProjectRevision,
    idempotencyKey,
    requestHash: storageCanonicalHasher.sha256Canonical({ request }),
    payload: { projectRevision },
    createdAt: "2026-07-16T00:00:00.000Z",
    queuedAt: "2026-07-16T00:00:00.000Z"
  };
}

function capabilityAudits(projectId: string): StorageCapabilityAudit[] {
  return (["agent", "engineering", "search"] as const).map((capability) => ({
    id: `reservation-audit-${capability}`,
    projectId,
    operation: capability,
    capability,
    appAllowed: true,
    projectAllowed: true,
    operationAllowed: true,
    allowed: true,
    data: { jobKind: "research_loop" },
    auditedAt: "2026-07-16T00:00:02.000Z"
  }));
}

function projectPayload(root: string, id: string, updatedAt: string, projectRoot = join(root, id)) {
  mkdirSync(projectRoot, { recursive: true });
  return { id, projectRoot, topic: id, status: "active", createdAt: "2026-07-16T00:00:00.000Z", updatedAt };
}

function readCounts(path: string, projectId: string): { revisions: number; events: number; finalized: number } {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    return {
      revisions: Number((db.prepare("select count(*) count from project_revision_receipts where project_id=?").get(projectId) as { count: number }).count),
      events: Number((db.prepare("select count(*) count from job_events where project_id=?").get(projectId) as { count: number }).count),
      finalized: Number(
        (db.prepare("select count(*) count from project_mutation_journal where project_id=? and state='finalized'").get(projectId) as { count: number }).count
      )
    };
  } finally {
    db.close();
  }
}
