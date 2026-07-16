import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import type { ResearchSnapshot } from "../../core/shared/types.js";
import { migrateLegacyProjectMutationSchema } from "../runtime/storage/legacyProjectMutationSchema.js";
import type { LegacyProjectMutationPort, LegacyProjectMutationRequest } from "../runtime/storage/legacyProjectMutationTypes.js";
import { createLegacyStorageWorker, type LegacyStorageWorkerHandle } from "../runtime/storage/worker/legacyStorageClient.js";
import { createStorageWorkerClient, type StorageWorkerClient } from "../runtime/storage/worker/typedRuntime.js";
import { migrateStorageV2Schema } from "../runtime/storage/v2/schema.js";
import type { StorageJsonObject } from "../runtime/storage/v2/types.js";
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

describe("project mutation saga crash matrix with real storage workers", () => {
  it("recovers a prepare-only mutation after both workers restart", async () => {
    const fixture = createFixture();
    const coordinator = coordinatorFor(fixture, {
      legacy: failLegacyApply(fixture.legacy.projectMutations, () => true, "injected failure after prepare")
    });
    const input = projectInput("prepare-only restart");

    await expect(coordinator.create("prepare-only-request", input)).rejects.toThrow("injected failure after prepare");
    const [prepared] = await fixture.runtime.projectMutations.listPending();
    expect(prepared).toMatchObject({ state: "prepared", expectedProjectRevision: 0 });
    expect(await fixture.legacy.projectMutations.listReceipts()).toEqual([]);

    await closeFixtureWorkers(fixture);
    const restarted = reopenFixture(fixture.root);
    const recovery = coordinatorFor(restarted);
    await recovery.recoverPending();

    expect(await restarted.runtime.projectMutations.listPending()).toEqual([]);
    expect(await restarted.runtime.getProjectRevision(prepared!.projectId)).toBe(1);
    expect(await restarted.runtime.eventsAfter(prepared!.projectId)).toHaveLength(1);
    expect(await restarted.legacy.projectMutations.listReceipts({ projectId: prepared!.projectId })).toHaveLength(1);
    await expect(recovery.create("prepare-only-request", input)).resolves.toMatchObject({ id: prepared!.projectId, revision: 1 });
  });

  it("recovers a legacy-applied mutation after both workers restart", async () => {
    const fixture = createFixture();
    const coordinator = coordinatorFor(fixture, { operational: failFinalizeBeforeCommit(fixture.runtime.projectMutations) });
    const input = projectInput("legacy-applied restart");

    await expect(coordinator.create("legacy-applied-request", input)).rejects.toThrow("injected failure before finalize");
    const [pending] = await fixture.runtime.projectMutations.listPending();
    expect(pending).toMatchObject({ state: "legacy_applied", expectedProjectRevision: 0 });
    expect(await fixture.legacy.projectMutations.listReceipts({ projectId: pending!.projectId })).toHaveLength(1);
    expect(await fixture.runtime.getProjectRevision(pending!.projectId)).toBeUndefined();

    await closeFixtureWorkers(fixture);
    const restarted = reopenFixture(fixture.root);
    const recovery = coordinatorFor(restarted);
    await recovery.recoverPending();

    expect(await restarted.runtime.projectMutations.listPending()).toEqual([]);
    expect(await restarted.runtime.getProjectRevision(pending!.projectId)).toBe(1);
    expect(await restarted.runtime.eventsAfter(pending!.projectId)).toHaveLength(1);
    await expect(recovery.create("legacy-applied-request", input)).resolves.toMatchObject({ id: pending!.projectId, revision: 1 });
  });

  it("replays one committed event to SSE subscribers after a lost finalize response without duplicating durable state", async () => {
    const fixture = createFinalizeResponseLossFixture();
    const deliveredEventIds: string[] = [];
    const unsubscribe = fixture.runtime.subscribe((event) => deliveredEventIds.push(event.id));
    const coordinator = coordinatorFor(fixture);
    const input = projectInput("finalize response loss");

    const result = await coordinator.create("finalize-response-loss-request", input);
    const [receipt] = await fixture.legacy.projectMutations.listReceipts();
    const projectId = receipt!.projectId;
    expect(result).toMatchObject({ id: projectId, revision: 1 });
    expect(() => coordinator.assertReadable(projectId)).not.toThrow();
    const committedEvents = await fixture.runtime.eventsAfter(projectId);
    expect(committedEvents).toHaveLength(1);
    expect(deliveredEventIds).toEqual([committedEvents[0]!.id]);

    const retry = await coordinator.create("finalize-response-loss-request", input);
    unsubscribe();

    expect(retry).toMatchObject({ id: projectId, revision: 1 });
    expect(() => coordinator.assertReadable(projectId)).not.toThrow();
    expect(await fixture.runtime.projectMutations.listPending()).toEqual([]);
    expect(await fixture.runtime.eventsAfter(projectId)).toEqual(committedEvents);
    expect(await fixture.legacy.projectMutations.listReceipts({ projectId })).toEqual([receipt]);
    expect(deliveredEventIds).toEqual([committedEvents[0]!.id]);
  });

  it("recovers 251 ordered pending mutations across pages while isolating one project failure", async () => {
    const fixture = createFixture();
    const seedCoordinator = coordinatorFor(fixture, {
      legacy: failLegacyApply(fixture.legacy.projectMutations, () => true, "injected seed interruption")
    });
    const seedResults = await Promise.allSettled(
      Array.from({ length: 251 }, (_, index) => seedCoordinator.create(`paged-request-${String(index).padStart(3, "0")}`, projectInput(`paged ${index}`)))
    );
    expect(seedResults.every((result) => result.status === "rejected" && String(result.reason).includes("injected seed interruption"))).toBe(true);

    const pendingBeforeRestart = await fixture.runtime.projectMutations.listPending();
    expect(pendingBeforeRestart).toHaveLength(251);
    expect(pendingBeforeRestart.map((item) => item.operationId)).toEqual(
      [...pendingBeforeRestart]
        .sort((left, right) => left.preparedAt.localeCompare(right.preparedAt) || left.operationId.localeCompare(right.operationId))
        .map((item) => item.operationId)
    );
    expect(await fixture.legacy.projectMutations.listReceipts({ limit: 1_000 })).toEqual([]);

    await closeFixtureWorkers(fixture);
    const restarted = reopenFixture(fixture.root);
    const firstOperationId = pendingBeforeRestart[0]!.operationId;
    const recoveryOrder: string[] = [];
    const faultingLegacy = recordLegacyApplyOrder(
      failLegacyApply(restarted.legacy.projectMutations, onceForOperation(firstOperationId), "injected isolated recovery failure"),
      recoveryOrder
    );
    const recovery = coordinatorFor(restarted, { legacy: faultingLegacy });

    await expect(recovery.recoverPending()).rejects.toThrow("injected isolated recovery failure");
    expect(recoveryOrder).toEqual(pendingBeforeRestart.map((item) => item.operationId));
    expect(await restarted.runtime.projectMutations.listPending()).toEqual([pendingBeforeRestart[0]]);
    expect(readOperationalCounts(join(restarted.root, "storage.sqlite"))).toEqual({ events: 250, finalized: 250, heads: 250, pending: 1, projects: 250 });

    await recovery.recoverPending();

    expect(recoveryOrder).toEqual([...pendingBeforeRestart.map((item) => item.operationId), firstOperationId]);
    expect(await restarted.runtime.projectMutations.listPending()).toEqual([]);
    expect(await restarted.legacy.projectMutations.listReceipts({ limit: 1_000 })).toHaveLength(251);
    expect(readOperationalCounts(join(restarted.root, "storage.sqlite"))).toEqual({ events: 251, finalized: 251, heads: 251, pending: 0, projects: 251 });
  });
});

interface Fixture {
  root: string;
  runtime: DurableJobRuntime;
  legacy: LegacyStorageWorkerHandle;
}

interface CoordinatorOverrides {
  operational?: DurableProjectMutationStorage;
  legacy?: LegacyProjectMutationPort;
}

function createFixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), "aetherops-project-saga-crash-matrix-"));
  roots.push(root);
  const operational = new DatabaseSync(join(root, "storage.sqlite"));
  migrateStorageV2Schema(operational);
  operational.close();
  const legacy = new DatabaseSync(join(root, "legacy-research.sqlite"));
  migrateLegacyProjectMutationSchema(legacy);
  legacy.close();
  return openFixture(root);
}

function createFinalizeResponseLossFixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), "aetherops-project-saga-finalize-loss-"));
  roots.push(root);
  const operationalPath = join(root, "storage.sqlite");
  const operational = new DatabaseSync(operationalPath);
  migrateStorageV2Schema(operational);
  operational.close();
  const legacyPath = join(root, "legacy-research.sqlite");
  const legacyDatabase = new DatabaseSync(legacyPath);
  migrateLegacyProjectMutationSchema(legacyDatabase);
  legacyDatabase.close();
  const client = createStorageWorkerClient({ appDbPath: operationalPath, vectorDbPath: operationalPath, ontologyDbPath: operationalPath, dataRoot: root });
  const runtime = new DurableJobRuntime(operationalPath, { dataRoot: root, storageClient: loseFirstFinalizeWorkerResponse(client) });
  const legacy = createLegacyStorageWorker(legacyPath, join(root, "settings.json"));
  runtimes.push(runtime);
  legacyWorkers.push(legacy);
  return { root, runtime, legacy };
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

function coordinatorFor(fixture: Fixture, overrides: CoordinatorOverrides = {}): ProjectMutationSagaCoordinator {
  return new ProjectMutationSagaCoordinator({
    operational: overrides.operational ?? fixture.runtime.projectMutations,
    legacy: overrides.legacy ?? fixture.legacy.projectMutations,
    getSnapshot: (projectId) => fixture.legacy.researchStore.getSnapshot(projectId),
    getProjectRevisionHead: (projectId) => fixture.runtime.getProjectRevisionHead(projectId),
    projectRootBase: join(fixture.root, "projects"),
    resultMapper: {
      project: (snapshot, revision) => projectResult(snapshot, revision),
      session: (session) => ({ id: session.id }),
      deleted: () => ({ deleted: true })
    },
    now: () => "2026-07-16T00:00:00.000Z"
  });
}

function projectInput(label: string) {
  return { goal: `Verify ${label}`, topic: `Saga ${label}`, scope: "Local SQLite workers", budget: "One bounded recovery" };
}

function projectResult(snapshot: ResearchSnapshot, revision: number): StorageJsonObject {
  return { id: snapshot.project.id, revision };
}

function failLegacyApply(
  target: LegacyProjectMutationPort,
  shouldFail: (request: LegacyProjectMutationRequest) => boolean,
  message: string
): LegacyProjectMutationPort {
  return new Proxy(target, {
    get(port, property) {
      if (property === "apply") {
        return async (request: LegacyProjectMutationRequest) => {
          if (shouldFail(request)) throw new Error(message);
          return port.apply(request);
        };
      }
      const value = Reflect.get(port, property, port) as unknown;
      return typeof value === "function" ? value.bind(port) : value;
    }
  });
}

function recordLegacyApplyOrder(target: LegacyProjectMutationPort, order: string[]): LegacyProjectMutationPort {
  return new Proxy(target, {
    get(port, property) {
      if (property === "apply") {
        return async (request: LegacyProjectMutationRequest) => {
          order.push(request.operationId);
          return port.apply(request);
        };
      }
      const value = Reflect.get(port, property, port) as unknown;
      return typeof value === "function" ? value.bind(port) : value;
    }
  });
}

function onceForOperation(operationId: string): (request: LegacyProjectMutationRequest) => boolean {
  let failed = false;
  return (request) => {
    if (failed || request.operationId !== operationId) return false;
    failed = true;
    return true;
  };
}

function failFinalizeBeforeCommit(target: DurableProjectMutationStorage): DurableProjectMutationStorage {
  return new Proxy(target, {
    get(storage, property) {
      if (property === "finalize") return async () => Promise.reject(new Error("injected failure before finalize"));
      const value = Reflect.get(storage, property, storage) as unknown;
      return typeof value === "function" ? value.bind(storage) : value;
    }
  });
}

function loseFirstFinalizeWorkerResponse(target: StorageWorkerClient): StorageWorkerClient {
  let responseLost = false;
  return new Proxy(target, {
    get(client, property) {
      if (property === "request") {
        return async <T>(...args: Parameters<StorageWorkerClient["request"]>): Promise<T> => {
          const result = await client.request<T>(...args);
          if (!responseLost && args[0].name === "projectMutation.finalize") {
            responseLost = true;
            throw new Error("injected worker finalize response loss");
          }
          return result;
        };
      }
      const value = Reflect.get(client, property, client) as unknown;
      return typeof value === "function" ? value.bind(client) : value;
    }
  });
}

function readOperationalCounts(path: string): { events: number; finalized: number; heads: number; pending: number; projects: number } {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    return {
      events: count(db, "select count(*) as count from job_events"),
      finalized: count(db, "select count(*) as count from project_mutation_journal where state='finalized'"),
      heads: count(db, "select count(*) as count from project_revision_heads where revision=1"),
      pending: count(db, "select count(*) as count from project_mutation_journal where state in ('prepared','legacy_applied')"),
      projects: count(db, "select count(*) as count from projects_v2")
    };
  } finally {
    db.close();
  }
}

function count(db: DatabaseSync, sql: string): number {
  return Number((db.prepare(sql).get() as { count: number }).count);
}

function removeOnce<T>(items: T[], item: T): void {
  const index = items.indexOf(item);
  if (index >= 0) items.splice(index, 1);
}
