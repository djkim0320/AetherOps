import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { migrateStorageV2Schema } from "../runtime/storage/v2/schema.js";
import { migrateLegacyProjectMutationSchema } from "../runtime/storage/legacyProjectMutationSchema.js";
import { createLegacyStorageWorker, type LegacyStorageWorkerHandle } from "../runtime/storage/worker/legacyStorageClient.js";
import { DurableJobRuntime } from "./durableJobRuntime.js";
import type { DurableProjectMutationStorage } from "./durableProjectMutationStorage.js";
import { ProjectMutationSagaCoordinator } from "./projectMutationSagaCoordinator.js";

const roots: string[] = [];
const runtimes: DurableJobRuntime[] = [];
const legacyWorkers: LegacyStorageWorkerHandle[] = [];

afterEach(async () => {
  await Promise.allSettled(runtimes.splice(0).map((runtime) => runtime.close()));
  await Promise.allSettled(legacyWorkers.splice(0).map((worker) => worker.close()));
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("project mutation saga coordinator with real storage workers", () => {
  it("commits one legacy mutation, revision, event, and exact response for concurrent retries", async () => {
    const fixture = createFixture();
    let clockCall = 0;
    const coordinator = coordinatorFor(fixture, fixture.runtime.projectMutations, () => new Date(Date.UTC(2026, 6, 16, 0, 0, clockCall++)).toISOString());
    const input = { goal: "Prove exact replay", topic: "Project saga", scope: "Local SQLite only", budget: "One bounded run" };

    const [first, concurrentRetry] = await Promise.all([
      coordinator.create("request-create-concurrent", input),
      coordinator.create("request-create-concurrent", input)
    ]);
    const projectId = String(first.id);
    const events = await fixture.runtime.eventsAfter(projectId);
    const receipts = await fixture.legacy.projectMutations.listReceipts({ projectId });

    expect(concurrentRetry).toEqual(first);
    expect(clockCall).toBe(1);
    expect(await fixture.runtime.getProjectRevision(projectId)).toBe(1);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "project.snapshot.changed", projectRevision: 1 });
    expect(receipts).toHaveLength(1);
    expect((await fixture.legacy.researchStore.getSnapshot(projectId)).project.id).toBe(projectId);

    const responseLossRetry = await coordinator.create("request-create-concurrent", input);
    expect(responseLossRetry).toEqual(first);
    expect(await fixture.runtime.eventsAfter(projectId)).toHaveLength(1);
    expect(await fixture.legacy.projectMutations.listReceipts({ projectId })).toHaveLength(1);
  });

  it("recovers after legacy commit and before operational acknowledgement across worker restart", async () => {
    const fixture = createFixture();
    const faultingStorage = failOnceBeforeLegacyAcknowledgement(fixture.runtime.projectMutations);
    const firstCoordinator = coordinatorFor(fixture, faultingStorage, () => "2026-07-16T00:00:00.000Z");
    const input = { goal: "Recover commit split", topic: "Restart recovery", scope: "Local SQLite only", budget: "One bounded run" };

    await expect(firstCoordinator.create("request-create-recovery", input)).rejects.toThrow("injected acknowledgement failure");
    const legacyReceipt = (await fixture.legacy.projectMutations.listReceipts()).at(0);
    expect(legacyReceipt).toBeDefined();
    expect(await fixture.runtime.getProjectRevision(legacyReceipt!.projectId)).toBeUndefined();

    await closeFixtureWorkers(fixture);
    const restarted = reopenFixture(fixture.root);
    const recoveredCoordinator = coordinatorFor(restarted, restarted.runtime.projectMutations, () => "2026-07-16T00:01:00.000Z");
    await recoveredCoordinator.recoverPending();

    expect(await restarted.runtime.getProjectRevision(legacyReceipt!.projectId)).toBe(1);
    expect(await restarted.runtime.eventsAfter(legacyReceipt!.projectId)).toHaveLength(1);
    expect(await restarted.legacy.projectMutations.listReceipts({ projectId: legacyReceipt!.projectId })).toEqual([legacyReceipt]);
    const replay = await recoveredCoordinator.create("request-create-recovery", input);
    expect(replay).toMatchObject({ id: legacyReceipt!.projectId, revision: 1 });
  });

  it("reconciles a committed prepare when only the storage response is lost", async () => {
    const fixture = createFixture();
    const responseLosingStorage = loseFirstPrepareResponse(fixture.runtime.projectMutations);
    const coordinator = coordinatorFor(fixture, responseLosingStorage, () => "2026-07-16T00:00:00.000Z");
    const input = { goal: "Reconcile prepare", topic: "Response loss", scope: "Local SQLite only", budget: "One bounded run" };

    const result = await coordinator.create("request-prepare-response-loss", input);
    const projectId = String(result.id);

    expect(result).toMatchObject({ revision: 1 });
    expect(() => coordinator.assertReadable(projectId)).not.toThrow();
    expect(await fixture.runtime.getProjectRevision(projectId)).toBe(1);
    expect(await fixture.runtime.eventsAfter(projectId)).toHaveLength(1);
    expect(await fixture.legacy.projectMutations.listReceipts({ projectId })).toHaveLength(1);
  });

  it("commits update and session mutations with monotonic timestamps when the clock does not advance", async () => {
    const fixture = createFixture();
    const coordinator = coordinatorFor(fixture, fixture.runtime.projectMutations, () => "2026-07-16T00:00:00.000Z");
    const created = await coordinator.create("request-sequence-create", {
      goal: "Initial goal",
      topic: "Monotonic saga",
      scope: "Local SQLite only",
      budget: "One bounded run"
    });
    const projectId = String(created.id);

    const updated = await coordinator.update("request-sequence-update", projectId, 1, { goal: "Updated goal" });
    const session = await coordinator.createSession("request-sequence-session-create", projectId, "검증 채팅", "동일 시각 직렬화");
    const deleted = await coordinator.deleteSession("request-sequence-session-delete", projectId, String(session.id));

    const snapshot = await fixture.legacy.researchStore.getSnapshot(projectId);
    const receipts = await fixture.legacy.projectMutations.listReceipts({ projectId });
    expect(updated).toMatchObject({ id: projectId, revision: 2 });
    expect(deleted).toEqual({ deleted: true });
    expect(snapshot.project).toMatchObject({ goal: "Updated goal", updatedAt: "2026-07-16T00:00:00.001Z" });
    expect(snapshot.sessions).toEqual([]);
    expect(receipts.map((receipt) => receipt.appliedAt)).toEqual([
      "2026-07-16T00:00:00.000Z",
      "2026-07-16T00:00:00.001Z",
      "2026-07-16T00:00:00.002Z",
      "2026-07-16T00:00:00.003Z"
    ]);
    expect(await fixture.runtime.getProjectRevision(projectId)).toBe(4);
    expect(await fixture.runtime.eventsAfter(projectId)).toHaveLength(4);
  });
});

interface Fixture {
  root: string;
  runtime: DurableJobRuntime;
  legacy: LegacyStorageWorkerHandle;
}

function createFixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), "aetherops-project-mutation-saga-"));
  roots.push(root);
  const operationalPath = join(root, "storage.sqlite");
  const database = new DatabaseSync(operationalPath);
  migrateStorageV2Schema(database);
  database.close();
  const legacyDatabase = new DatabaseSync(join(root, "legacy-research.sqlite"));
  migrateLegacyProjectMutationSchema(legacyDatabase);
  legacyDatabase.close();
  return openFixture(root);
}

function reopenFixture(root: string): Fixture {
  return openFixture(root);
}

function openFixture(root: string): Fixture {
  const runtime = new DurableJobRuntime(join(root, "storage.sqlite"), { dataRoot: root });
  const legacy = createLegacyStorageWorker(join(root, "legacy-research.sqlite"), join(root, "settings.json"));
  runtimes.push(runtime);
  legacyWorkers.push(legacy);
  return { root, runtime, legacy };
}

async function closeFixtureWorkers(fixture: Fixture): Promise<void> {
  await fixture.runtime.close();
  await fixture.legacy.close();
  removeOnce(runtimes, fixture.runtime);
  removeOnce(legacyWorkers, fixture.legacy);
}

function coordinatorFor(fixture: Fixture, operational: DurableProjectMutationStorage, now: () => string): ProjectMutationSagaCoordinator {
  return new ProjectMutationSagaCoordinator({
    operational,
    legacy: fixture.legacy.projectMutations,
    getSnapshot: (projectId) => fixture.legacy.researchStore.getSnapshot(projectId),
    getProjectRevisionHead: (projectId) => fixture.runtime.getProjectRevisionHead(projectId),
    projectRootBase: join(fixture.root, "projects"),
    resultMapper: {
      project: (snapshot, revision) => ({ id: snapshot.project.id, revision }),
      session: (session) => ({ id: session.id }),
      deleted: () => ({ deleted: true })
    },
    now
  });
}

function failOnceBeforeLegacyAcknowledgement(storage: DurableProjectMutationStorage): DurableProjectMutationStorage {
  const failure = vi.fn().mockRejectedValueOnce(new Error("injected acknowledgement failure"));
  return new Proxy(storage, {
    get(target, property) {
      if (property === "markLegacyApplied" && failure.mock.calls.length === 0) return failure;
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    }
  });
}

function loseFirstPrepareResponse(storage: DurableProjectMutationStorage): DurableProjectMutationStorage {
  let responseLost = false;
  return new Proxy(storage, {
    get(target, property) {
      if (property === "prepare") {
        return async (...args: Parameters<DurableProjectMutationStorage["prepare"]>) => {
          const result = await target.prepare(...args);
          if (!responseLost) {
            responseLost = true;
            throw new Error("injected prepare response loss");
          }
          return result;
        };
      }
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    }
  });
}

function removeOnce<T>(items: T[], item: T): void {
  const index = items.indexOf(item);
  if (index >= 0) items.splice(index, 1);
}
