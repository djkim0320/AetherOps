import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { ResearchLoopStep, type ResearchProject, type ResearchSession } from "../../../core/shared/types.js";
import { storageCanonicalHasher } from "./v2/runStatePayloadValidator.js";
import { legacyProjectMutationReceiptHash, legacyProjectMutationResultHash, legacyProjectSnapshotHash } from "./legacyProjectMutationHash.js";
import { migrateLegacyProjectMutationSchema } from "./legacyProjectMutationSchema.js";
import type { LegacyProjectMutationRequest } from "./legacyProjectMutationTypes.js";
import { SqliteResearchStore } from "./sqliteStore.js";
import { createLegacyStorageWorker, type LegacyStorageWorkerHandle } from "./worker/legacyStorageClient.js";

let tempRoot: string | undefined;
let store: SqliteResearchStore | undefined;
let worker: LegacyStorageWorkerHandle | undefined;

afterEach(async () => {
  await worker?.close();
  worker = undefined;
  store?.close();
  store = undefined;
  if (tempRoot) rmSync(tempRoot, { recursive: true, force: true });
  tempRoot = undefined;
});

describe("legacy project mutation storage", () => {
  it("applies all metadata methods atomically with deterministic snapshots and receipts", async () => {
    const sqlitePath = createPaths().sqlitePath;
    store = new SqliteResearchStore(sqlitePath);
    const project = testProject();

    const created = await store.applyProjectMutation(request("project-create", "a", "project.create", null, { project }, project.createdAt));
    expect(created.exactReplay).toBe(false);
    expect(created.snapshot.project).toEqual(project);
    expect(created.receipt.snapshotHash).toBe(legacyProjectSnapshotHash(created.snapshot));
    expect(created.receipt.snapshotHash).toBe(
      storageCanonicalHasher.sha256Canonical({ project: created.snapshot.project, sessions: created.snapshot.sessions })
    );
    verifyReceipt(created.receipt);

    const updatedProject = { ...created.snapshot.project, topic: "updated deterministic topic", updatedAt: "2026-07-16T01:00:00.000Z" };
    const updated = await store.applyProjectMutation(
      request("project-update", "b", "project.update", created.receipt.snapshotHash, { project: updatedProject }, updatedProject.updatedAt)
    );
    expect(updated.snapshot.project.topic).toBe("updated deterministic topic");

    const session: ResearchSession = {
      id: "session-deterministic-1",
      projectId: project.id,
      title: "Deterministic session",
      focus: "Atomic metadata mutation",
      createdAt: "2026-07-16T02:00:00.000Z"
    };
    const sessionCreated = await store.applyProjectMutation(
      request("session-create", "c", "session.create", updated.receipt.snapshotHash, { session }, session.createdAt)
    );
    expect(sessionCreated.snapshot.sessions).toEqual([session]);
    expect(JSON.parse(sessionCreated.receipt.resultJson)).toEqual({ kind: "session", projectId: project.id, sessionId: session.id, state: "created" });

    const sessionDeleted = await store.applyProjectMutation(
      request("session-delete", "d", "session.delete", sessionCreated.receipt.snapshotHash, { sessionId: session.id }, "2026-07-16T03:00:00.000Z")
    );
    expect(sessionDeleted.snapshot.sessions).toEqual([]);
    expect((await store.listProjectMutationReceipts({ projectId: project.id })).map((receipt) => receipt.operationId)).toEqual([
      "project-create",
      "project-update",
      "session-create",
      "session-delete"
    ]);
  });

  it("replays exactly after worker restart and rejects divergent operation reuse", async () => {
    const paths = createPaths();
    worker = createLegacyStorageWorker(paths.sqlitePath, paths.settingsPath);
    const project = testProject();
    const command = request("restart-operation", "e", "project.create", null, { project }, project.createdAt);

    const first = await worker.projectMutations.apply(command);
    await worker.close();
    worker = createLegacyStorageWorker(paths.sqlitePath, paths.settingsPath);

    const stored = await worker.projectMutations.getReceipt(command.operationId);
    const replay = await worker.projectMutations.apply(command);
    expect(stored).toEqual(first.receipt);
    expect(replay).toEqual({ ...first, exactReplay: true });
    expect(await worker.projectMutations.listReceipts()).toEqual([first.receipt]);

    await expect(worker.projectMutations.apply({ ...command, requestHash: hash("f") })).rejects.toMatchObject({
      name: "LegacyProjectMutationConflictError"
    });
    await expect(worker.projectMutations.apply({ ...command, command: { project: { ...project, topic: "divergent command" } } })).rejects.toMatchObject({
      name: "LegacyProjectMutationConflictError"
    });
    expect(await worker.projectMutations.listReceipts()).toHaveLength(1);
  });

  it("fails closed on stale before hashes without applying a partial mutation", async () => {
    const paths = createPaths();
    store = new SqliteResearchStore(paths.sqlitePath);
    const project = testProject();
    const created = await store.applyProjectMutation(request("stale-create", "1", "project.create", null, { project }, project.createdAt));
    const updatedProject = { ...created.snapshot.project, topic: "new state", updatedAt: "2026-07-16T04:00:00.000Z" };
    const updated = await store.applyProjectMutation(
      request("stale-update", "2", "project.update", created.receipt.snapshotHash, { project: updatedProject }, updatedProject.updatedAt)
    );
    const staleSession: ResearchSession = {
      id: "stale-session",
      projectId: project.id,
      title: "Must not persist",
      focus: "Stale CAS",
      createdAt: "2026-07-16T05:00:00.000Z"
    };

    await expect(
      store.applyProjectMutation(
        request("stale-session-create", "3", "session.create", created.receipt.snapshotHash, { session: staleSession }, staleSession.createdAt)
      )
    ).rejects.toMatchObject({ name: "LegacyProjectMutationDriftError" });
    expect((await store.getSnapshot(project.id)).sessions).toEqual([]);
    expect(await store.getProjectMutationReceipt("stale-session-create")).toBeUndefined();
    expect(legacyProjectSnapshotHash(await store.getSnapshot(project.id))).toBe(updated.receipt.snapshotHash);
  });

  it("serializes concurrent worker mutations so only one stale-CAS contender commits", async () => {
    const paths = createPaths();
    worker = createLegacyStorageWorker(paths.sqlitePath, paths.settingsPath);
    const project = testProject();
    const created = await worker.projectMutations.apply(request("concurrent-create", "7", "project.create", null, { project }, project.createdAt));
    const sessions = ["a", "b"].map((suffix): ResearchSession => ({
      id: `concurrent-session-${suffix}`,
      projectId: project.id,
      title: `Concurrent ${suffix}`,
      focus: "Exactly one commit",
      createdAt: `2026-07-16T06:00:0${suffix === "a" ? "0" : "1"}.000Z`
    }));

    const attempts = await Promise.allSettled(
      sessions.map((session, index) =>
        worker!.projectMutations.apply(
          request(`concurrent-session-${index}`, index ? "9" : "8", "session.create", created.receipt.snapshotHash, { session }, session.createdAt)
        )
      )
    );
    expect(attempts.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(attempts.filter((result) => result.status === "rejected")).toHaveLength(1);
    const snapshot = await worker.researchStore.getSnapshot(project.id);
    expect(snapshot.sessions).toHaveLength(1);
    expect(await worker.projectMutations.listReceipts()).toHaveLength(2);
  });

  it("rolls back the metadata row when immutable receipt persistence fails", async () => {
    const paths = createPaths();
    store = new SqliteResearchStore(paths.sqlitePath);
    const injector = new DatabaseSync(paths.sqlitePath);
    injector.exec(`
      create trigger reject_test_mutation_receipt
      before insert on legacy_project_mutation_receipts
      when new.operation_id = 'rollback-operation'
      begin select raise(abort, 'receipt fault injection'); end;
    `);
    injector.close();
    const project = testProject();

    await expect(store.applyProjectMutation(request("rollback-operation", "4", "project.create", null, { project }, project.createdAt))).rejects.toThrow(
      /receipt fault injection/
    );
    expect(await store.getProject(project.id)).toBeUndefined();
    expect(await store.getProjectMutationReceipt("rollback-operation")).toBeUndefined();
  });

  it("prevents receipt mutation at the SQLite boundary", async () => {
    const paths = createPaths();
    store = new SqliteResearchStore(paths.sqlitePath);
    const project = testProject();
    await store.applyProjectMutation(request("immutable-operation", "5", "project.create", null, { project }, project.createdAt));
    const inspector = new DatabaseSync(paths.sqlitePath);
    try {
      expect(() =>
        inspector.prepare("update legacy_project_mutation_receipts set request_hash = ? where operation_id = ?").run(hash("6"), "immutable-operation")
      ).toThrow(/immutable/);
      expect(() => inspector.prepare("delete from legacy_project_mutation_receipts where operation_id = ?").run("immutable-operation")).toThrow(/immutable/);
    } finally {
      inspector.close();
    }
  });
});

function request(
  operationId: string,
  requestHashSeed: string,
  method: LegacyProjectMutationRequest["method"],
  expectedBeforeHash: string | null,
  command: LegacyProjectMutationRequest["command"],
  appliedAt: string
): LegacyProjectMutationRequest {
  return { operationId, method, requestHash: hash(requestHashSeed), projectId: "project-deterministic", expectedBeforeHash, command, appliedAt };
}

function testProject(): ResearchProject {
  return {
    id: "project-deterministic",
    goal: "Verify atomic metadata mutations",
    topic: "deterministic project",
    scope: "Legacy research SQLite only",
    budget: "bounded",
    autonomyPolicy: { toolApproval: "manual", allowExternalSearch: false, allowCodeExecution: false },
    createdAt: "2026-07-16T00:00:00.000Z",
    updatedAt: "2026-07-16T00:00:00.000Z",
    currentStep: ResearchLoopStep.CreateResearchDb,
    status: "idle",
    projectRoot: "D:/isolated/project-deterministic"
  };
}

function createPaths(): { sqlitePath: string; settingsPath: string } {
  tempRoot ??= mkdtempSync(join(tmpdir(), "aetherops-legacy-project-mutation-"));
  const sqlitePath = join(tempRoot, "legacy-research.sqlite");
  const database = new DatabaseSync(sqlitePath);
  try {
    migrateLegacyProjectMutationSchema(database);
  } finally {
    database.close();
  }
  return { sqlitePath, settingsPath: join(tempRoot, "settings.json") };
}

function hash(seed: string): string {
  return seed.repeat(64).slice(0, 64);
}

function verifyReceipt(receipt: Awaited<ReturnType<SqliteResearchStore["applyProjectMutation"]>>["receipt"]): void {
  const { receiptHash, ...body } = receipt;
  expect(receipt.commandHash).toMatch(/^[a-f0-9]{64}$/);
  expect(receipt.resultHash).toBe(legacyProjectMutationResultHash(receipt.resultJson));
  expect(receiptHash).toBe(legacyProjectMutationReceiptHash(body));
}
