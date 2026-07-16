import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { StorageWorkerRuntime } from "../worker/typedRuntime.js";
import { StorageV2Database } from "./connection.js";
import { EventRepository } from "./eventRepository.js";
import { migrateStorageV2Schema } from "./schema.js";

let root: string | undefined;
let storage: StorageV2Database | undefined;

afterEach(() => {
  storage?.close();
  storage = undefined;
  if (root) rmSync(root, { recursive: true, force: true });
  root = undefined;
});

describe("persistent project revision allocation", () => {
  it("exposes a newly created project as revision zero before its first committed event", () => {
    const path = createStorage();
    upsertProject("project-zero");
    expect(storage?.repositories.projectRevisions.current("project-zero")).toEqual({
      projectId: "project-zero",
      revision: 0,
      updatedAt: "2026-07-16T00:00:00.000Z"
    });
    storage?.close();
    storage = undefined;
    const runtime = new StorageWorkerRuntime({ appDbPath: path, vectorDbPath: path, ontologyDbPath: path });
    try {
      expect(runtime.handle({ name: "project.revision.get", projectId: "project-zero" })).toMatchObject({ projectId: "project-zero", revision: 0 });
      expect(runtime.handle({ name: "project.revision.get", projectId: "project-missing" })).toBeUndefined();
    } finally {
      runtime.close();
    }
  });

  it("allocates one revision for every event in one atomic project mutation and zero for exact replay", () => {
    const path = createStorage();
    upsertProject("project-a");
    const append = (statusAt = "2026-07-16T00:00:01.000Z", snapshotAt = "2026-07-16T00:00:02.000Z") =>
      storage?.transaction((repositories) => [
        repositories.events.append({
          eventId: "event-status-a",
          projectId: "project-a",
          type: "run.status.changed",
          createdAt: statusAt,
          payload: { projectRevision: 77, data: { status: "running" } }
        }),
        repositories.events.append({
          eventId: "event-snapshot-a",
          projectId: "project-a",
          type: "project.snapshot.changed",
          createdAt: snapshotAt,
          payload: { projectRevision: 77, data: { snapshotVersion: 77, reason: "job_changed" } }
        })
      ]);

    const first = append();
    expect(first).toEqual([
      expect.objectContaining({ payload: { projectRevision: 1, data: { status: "running" } } }),
      expect.objectContaining({ payload: { projectRevision: 1, data: { snapshotVersion: 1, reason: "job_changed" } } })
    ]);
    expect(append("2026-07-16T00:10:01.000Z", "2026-07-16T00:10:02.000Z")).toEqual(first);
    expect(readCounts(path, "project-a")).toEqual({ revision: 1, receipts: 1, links: 2, events: 2 });
  });

  it("allocates independent project-local revisions inside an interleaved multi-project transaction", () => {
    const path = createStorage();
    upsertProject("project-a");
    upsertProject("project-b");
    storage?.transaction((repositories) => {
      repositories.events.append(event("event-a-1", "project-a"));
      repositories.events.append(event("event-b-1", "project-b"));
      repositories.events.append(event("event-a-2", "project-a"));
    });
    expect(readCounts(path, "project-a")).toEqual({ revision: 1, receipts: 1, links: 2, events: 2 });
    expect(readCounts(path, "project-b")).toEqual({ revision: 1, receipts: 1, links: 1, events: 1 });
  });

  it("reserves an explicit transaction revision and binds the following event to that same revision", () => {
    const path = createStorage();
    upsertProject("project-reserved");
    const result = storage?.transaction((repositories) => {
      repositories.projectRevisions.assertCurrent("project-reserved", 0);
      const revision = repositories.projectRevisions.allocate("project-reserved");
      const stored = repositories.events.append(event("event-reserved", "project-reserved"));
      return { revision, stored };
    });
    expect(result).toMatchObject({ revision: 1, stored: { payload: { projectRevision: 1 } } });
    expect(() => storage?.transaction((repositories) => repositories.projectRevisions.allocate("project-reserved"))).toThrow("has no committed events");
    expect(readCounts(path, "project-reserved")).toEqual({ revision: 1, receipts: 1, links: 1, events: 1 });
  });

  it("rolls events, receipt, and head back together when receipt finalization fails", () => {
    const path = createStorage();
    upsertProject("project-a");
    const fault = new DatabaseSync(path);
    fault.exec(`create trigger fail_revision_receipt before insert on project_revision_receipts
      begin select raise(abort, 'injected revision receipt failure'); end;`);
    fault.close();
    expect(() => storage?.transaction((repositories) => repositories.events.append(event("event-failed", "project-a")))).toThrow(
      "injected revision receipt failure"
    );
    expect(readCounts(path, "project-a")).toEqual({ revision: 0, receipts: 0, links: 0, events: 0 });
  });

  it("continues the persistent head after restart and rejects a divergent stable event replay", () => {
    const path = createStorage();
    upsertProject("project-a");
    storage?.transaction((repositories) => repositories.events.append(event("event-a-1", "project-a")));
    storage?.close();
    storage = openStorage(path);
    const second = storage.transaction((repositories) => repositories.events.append(event("event-a-2", "project-a")));
    expect(second.payload).toMatchObject({ projectRevision: 2 });
    expect(() =>
      storage?.transaction((repositories) =>
        repositories.events.append({ ...event("event-a-2", "project-a"), payload: { projectRevision: 2, data: { status: "failed" } } })
      )
    ).toThrow("Durable event id conflict");
    expect(readCounts(path, "project-a")).toEqual({ revision: 2, receipts: 2, links: 2, events: 2 });
  });
});

describe("project revision storage boundary", () => {
  it("keeps a minimal event-only repository fixture usable when projects_v2 is absent", () => {
    const db = new DatabaseSync(":memory:");
    try {
      db.exec(`create table job_events(
        sequence integer primary key autoincrement,event_id text not null unique,project_id text not null,
        job_id text,type text not null,created_at text not null,payload text not null
      )`);
      expect(
        new EventRepository(db).append({ eventId: "fixture-event", projectId: "fixture-project", type: "fixture.changed", payload: { fixture: true } })
      ).toMatchObject({ eventId: "fixture-event", payload: { fixture: true } });
    } finally {
      db.close();
    }
  });

  it("fails closed when an operational projects_v2 database is missing the v13 revision schema", () => {
    const db = new DatabaseSync(":memory:");
    try {
      db.exec("create table projects_v2(id text primary key)");
      expect(() => new EventRepository(db)).toThrow("project revision schema is not ready");
    } finally {
      db.close();
    }
  });
});

function createStorage(): string {
  root = mkdtempSync(join(tmpdir(), "aetherops-project-revision-"));
  const path = join(root, "storage.sqlite");
  const db = new DatabaseSync(path);
  migrateStorageV2Schema(db);
  db.close();
  storage = openStorage(path);
  return path;
}

function openStorage(path: string): StorageV2Database {
  return new StorageV2Database({ appDbPath: path, vectorDbPath: path, ontologyDbPath: path });
}

function upsertProject(projectId: string): void {
  const projectRoot = join(root as string, projectId);
  mkdirSync(projectRoot);
  storage?.repositories.projects.upsert({
    id: projectId,
    projectRoot,
    topic: projectId,
    status: "active",
    createdAt: "2026-07-16T00:00:00.000Z",
    updatedAt: "2026-07-16T00:00:00.000Z"
  });
}

function event(eventId: string, projectId: string) {
  return {
    eventId,
    projectId,
    type: "run.status.changed",
    createdAt: "2026-07-16T00:00:01.000Z",
    payload: { projectRevision: 999, data: { status: "running" } }
  };
}

function readCounts(path: string, projectId: string) {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const revision = Number((db.prepare("select revision from project_revision_heads where project_id=?").get(projectId) as { revision: number }).revision);
    const receipts = Number((db.prepare("select count(*) count from project_revision_receipts where project_id=?").get(projectId) as { count: number }).count);
    const links = Number((db.prepare("select count(*) count from project_revision_event_links where project_id=?").get(projectId) as { count: number }).count);
    const events = Number((db.prepare("select count(*) count from job_events where project_id=?").get(projectId) as { count: number }).count);
    return { revision, receipts, links, events };
  } finally {
    db.close();
  }
}
