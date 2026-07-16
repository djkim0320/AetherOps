import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { inspectOperationalSchema, upgradeOperationalSchema } from "../../src/migration/operationalSchema.mjs";
import { StorageV2Database } from "../../src/server/runtime/storage/v2/connection.js";
import { migrateStorageV2Schema } from "../../src/server/runtime/storage/v2/schema.js";
import {
  STORAGE_PROJECT_REVISION_MIGRATION_CHECKSUM,
  STORAGE_PROJECT_REVISION_MIGRATION_NAME
} from "../../src/server/runtime/storage/v2/projectRevisionSchema.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("operational project revision v13 forward upgrade", () => {
  it("verifies runtime receipts with ordinal event and canonical payload-key ordering", () => {
    const root = mkdtempSync(join(tmpdir(), "aetherops-project-revision-ordering-"));
    roots.push(root);
    const path = join(root, "storage.sqlite");
    const seed = new DatabaseSync(path);
    migrateStorageV2Schema(seed);
    seed.close();
    const storage = new StorageV2Database({ appDbPath: path, vectorDbPath: path, ontologyDbPath: path });
    try {
      const projectRoot = join(root, "project");
      mkdirSync(projectRoot);
      storage.repositories.projects.upsert({
        id: "project-ordering",
        projectRoot,
        topic: "Receipt ordering",
        status: "active",
        createdAt: "2026-07-16T00:00:00.000Z",
        updatedAt: "2026-07-16T00:00:00.000Z"
      });
      storage.transaction((repositories) => {
        repositories.events.append({
          eventId: "event_a",
          projectId: "project-ordering",
          type: "run.step.changed",
          payload: { data: { _: true, a: true, A: true } }
        });
        repositories.events.append({
          eventId: "event-Z",
          projectId: "project-ordering",
          type: "run.status.changed",
          payload: { data: { _: false, a: false, A: false } }
        });
      });
    } finally {
      storage.close();
    }
    expect(inspectOperationalSchema(path)).toMatchObject({ ready: true, currentVersion: 14 });
    const readback = new DatabaseSync(path, { readOnly: true });
    try {
      expect(readback.prepare("select anchor_event_id from project_revision_receipts where project_id=?").get("project-ordering")).toEqual({
        anchor_event_id: "event-Z"
      });
    } finally {
      readback.close();
    }
  });

  it("backfills legacy event revisions with immutable receipts and is idempotent", () => {
    const fixture = createV12Fixture(false);
    expect(inspectOperationalSchema(fixture.path)).toMatchObject({ ready: false, currentVersion: 12 });

    expect(upgradeOperationalSchema(fixture.path)).toMatchObject({ changed: true, appliedVersions: [13, 14] });
    expect(inspectOperationalSchema(fixture.path)).toMatchObject({ ready: true, currentVersion: 14 });
    const db = new DatabaseSync(fixture.path, { readOnly: true });
    try {
      expect(db.prepare("select revision from project_revision_heads where project_id=?").get(fixture.projectId)).toEqual({ revision: 4 });
      expect(db.prepare("select revision,reason from project_revision_receipts where project_id=? order by revision").all(fixture.projectId)).toEqual([
        { revision: 3, reason: "legacy_unavailable" },
        { revision: 4, reason: "legacy_unavailable" }
      ]);
      expect(db.prepare("select event_id,revision from project_revision_event_links where project_id=? order by revision").all(fixture.projectId)).toEqual([
        { event_id: "legacy-status-revision-3", revision: 3 },
        { event_id: "legacy-snapshot-revision-4", revision: 4 }
      ]);
      expect(db.prepare("select name,checksum_sha256 from schema_migrations where version=13").get()).toEqual({
        name: STORAGE_PROJECT_REVISION_MIGRATION_NAME,
        checksum_sha256: STORAGE_PROJECT_REVISION_MIGRATION_CHECKSUM
      });
    } finally {
      db.close();
    }
    const beforeReapply = databaseSnapshot(fixture.path);
    expect(upgradeOperationalSchema(fixture.path)).toMatchObject({ changed: false, appliedVersions: [] });
    expect(databaseSnapshot(fixture.path)).toEqual(beforeReapply);
  });

  it("rolls the v13 migration back when a legacy snapshotVersion disagrees with projectRevision", () => {
    const fixture = createV12Fixture(true);
    const before = databaseSnapshot(fixture.path);
    expect(() => upgradeOperationalSchema(fixture.path)).toThrow(/project revision event link is invalid/i);
    expect(databaseSnapshot(fixture.path)).toEqual(before);
    expect(inspectOperationalSchema(fixture.path)).toMatchObject({ ready: false, currentVersion: 12 });
  });
});

function createV12Fixture(invalidSnapshot: boolean): { root: string; path: string; projectId: string } {
  const root = mkdtempSync(join(tmpdir(), "aetherops-project-revision-migration-"));
  roots.push(root);
  const path = join(root, "storage.sqlite");
  const projectId = "project-v13-forward";
  const projectRoot = join(root, "project");
  mkdirSync(projectRoot);
  const db = new DatabaseSync(path);
  try {
    migrateStorageV2Schema(db);
    const project = {
      id: projectId,
      projectRoot,
      topic: "Project revision migration",
      status: "active",
      createdAt: "2026-07-14T00:00:00.000Z",
      updatedAt: "2026-07-14T00:00:00.000Z"
    };
    db.prepare("insert into projects_v2(id,short_id,project_root,topic,status,created_at,updated_at,data) values(?,?,?,?,?,?,?,?)").run(
      projectId,
      "v13-forward",
      projectRoot,
      project.topic,
      project.status,
      project.createdAt,
      project.updatedAt,
      JSON.stringify(project)
    );
    dropV13(db);
    insertLegacyEvent(db, projectId, "legacy-status-revision-3", "run.status.changed", {
      projectRevision: 3,
      data: { status: "running" }
    });
    insertLegacyEvent(db, projectId, "legacy-snapshot-revision-4", "project.snapshot.changed", {
      projectRevision: 4,
      data: { snapshotVersion: invalidSnapshot ? 3 : 4, reason: "job_changed" }
    });
  } finally {
    db.close();
  }
  return { root, path, projectId };
}

function dropV13(db: DatabaseSync): void {
  db.exec(`
    drop table project_mutation_journal;
    drop table project_revision_heads;
    drop table project_revision_event_links;
    drop table project_revision_receipts;
    delete from schema_migrations where version in (13,14);
  `);
}

function insertLegacyEvent(db: DatabaseSync, projectId: string, eventId: string, type: string, payload: unknown): void {
  db.prepare("insert into job_events(event_id,project_id,job_id,type,created_at,payload) values(?,?,null,?,?,?)").run(
    eventId,
    projectId,
    type,
    "2026-07-14T00:03:00.000Z",
    JSON.stringify(payload)
  );
}

function databaseSnapshot(path: string): unknown {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    return {
      schema: db.prepare("select type,name,tbl_name,sql from sqlite_master where name not like 'sqlite_%' order by type,name").all(),
      migrations: db.prepare("select version,name,checksum_sha256 from schema_migrations order by version").all(),
      events: db.prepare("select * from job_events order by sequence").all()
    };
  } finally {
    db.close();
  }
}
