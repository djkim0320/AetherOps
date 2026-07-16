import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { StorageV2Database } from "./connection.js";
import { commitProjectSnapshot, type StorageProjectSnapshotCommitInput } from "./projectSnapshotAtomic.js";
import { migrateStorageV2Schema } from "./schema.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("atomic project snapshot projection", () => {
  it("commits the project projection, expected head, event, and receipt as one revision", () => {
    const fixture = createFixture();
    try {
      const input = snapshotInput(fixture.root, "snapshot-created", "2026-07-16T01:00:00.000Z", 0, "created");
      const result = fixture.storage.transaction((repositories) => commitProjectSnapshot(repositories, input));

      expect(result).toMatchObject({ projectRevision: 1, exactReplay: false, event: { eventId: "snapshot-created" } });
      expect(result.projectionHash).toMatch(/^[a-f0-9]{64}$/);
      expect(result.event.payload).toEqual({
        projectionHash: result.projectionHash,
        mutationHash: input.snapshotHash,
        projectRevision: 1,
        data: { snapshotVersion: 1, reason: "project_updated" }
      });
      expect(fixture.storage.repositories.projects.get("project-snapshot")).toMatchObject({ topic: "created" });
      expect(fixture.storage.repositories.projectRevisions.current("project-snapshot")).toMatchObject({ revision: 1 });
    } finally {
      fixture.storage.close();
    }
  });

  it("validates and returns an exact replay before checking its now-stale expected head", () => {
    const fixture = createFixture();
    try {
      const first = snapshotInput(fixture.root, "snapshot-first", "2026-07-16T01:00:00.000Z", 0, "first");
      fixture.storage.transaction((repositories) => commitProjectSnapshot(repositories, first));
      fixture.storage.transaction((repositories) =>
        commitProjectSnapshot(repositories, snapshotInput(fixture.root, "snapshot-second", "2026-07-16T01:01:00.000Z", 1, "second"))
      );

      const replay = fixture.storage.transaction((repositories) => commitProjectSnapshot(repositories, first));
      expect(replay).toMatchObject({ exactReplay: true, projectRevision: 1, event: { eventId: "snapshot-first" } });
      expect(fixture.storage.repositories.projectRevisions.current("project-snapshot")).toMatchObject({ revision: 2 });
      expect(fixture.storage.repositories.projects.get("project-snapshot")).toMatchObject({ topic: "second" });
    } finally {
      fixture.storage.close();
    }
  });

  it("rolls the project projection and event back when the expected head mismatches", () => {
    const fixture = createFixture();
    try {
      fixture.storage.transaction((repositories) =>
        commitProjectSnapshot(repositories, snapshotInput(fixture.root, "snapshot-first", "2026-07-16T01:00:00.000Z", 0, "first"))
      );
      const stale = snapshotInput(fixture.root, "snapshot-stale", "2026-07-16T01:01:00.000Z", 0, "must-rollback");

      expect(() => fixture.storage.transaction((repositories) => commitProjectSnapshot(repositories, stale))).toThrow(/revision changed/i);
      expect(fixture.storage.repositories.projects.get("project-snapshot")).toMatchObject({ topic: "first" });
      expect(fixture.storage.repositories.events.get("snapshot-stale")).toBeUndefined();
      expect(fixture.storage.repositories.projectRevisions.current("project-snapshot")).toMatchObject({ revision: 1 });
    } finally {
      fixture.storage.close();
    }
  });

  it("rejects a divergent projection replay before its stale expected head can mask the conflict", () => {
    const fixture = createFixture();
    try {
      const first = snapshotInput(fixture.root, "snapshot-first", "2026-07-16T01:00:00.000Z", 0, "first");
      fixture.storage.transaction((repositories) => commitProjectSnapshot(repositories, first));
      fixture.storage.transaction((repositories) =>
        commitProjectSnapshot(repositories, snapshotInput(fixture.root, "snapshot-second", "2026-07-16T01:01:00.000Z", 1, "second"))
      );
      const divergent = { ...first, project: { ...first.project, topic: "divergent" } };

      expect(() => fixture.storage.transaction((repositories) => commitProjectSnapshot(repositories, divergent))).toThrow(/event id conflict/i);
      expect(fixture.storage.repositories.projectRevisions.current("project-snapshot")).toMatchObject({ revision: 2 });
      expect(fixture.storage.repositories.projects.get("project-snapshot")).toMatchObject({ topic: "second" });
    } finally {
      fixture.storage.close();
    }
  });

  it("rejects a divergent full snapshot even when its project projection is unchanged", () => {
    const fixture = createFixture();
    try {
      const first = snapshotInput(fixture.root, "snapshot-first", "2026-07-16T01:00:00.000Z", 0, "first");
      fixture.storage.transaction((repositories) => commitProjectSnapshot(repositories, first));
      const divergent = { ...first, snapshotHash: "f".repeat(64) };

      expect(() => fixture.storage.transaction((repositories) => commitProjectSnapshot(repositories, divergent))).toThrow(/event id conflict/i);
      expect(fixture.storage.repositories.projectRevisions.current("project-snapshot")).toMatchObject({ revision: 1 });
    } finally {
      fixture.storage.close();
    }
  });
});

function createFixture(): { root: string; storage: StorageV2Database } {
  const root = mkdtempSync(join(tmpdir(), "aetherops-project-snapshot-"));
  roots.push(root);
  const path = join(root, "storage.sqlite");
  const db = new DatabaseSync(path);
  migrateStorageV2Schema(db);
  db.close();
  mkdirSync(join(root, "project"));
  return { root, storage: new StorageV2Database({ appDbPath: path, vectorDbPath: path, ontologyDbPath: path }) };
}

function snapshotInput(root: string, eventId: string, occurredAt: string, expectedProjectRevision: number, topic: string): StorageProjectSnapshotCommitInput {
  return {
    project: {
      id: "project-snapshot",
      projectRoot: join(root, "project"),
      topic,
      status: "active",
      createdAt: "2026-07-16T00:00:00.000Z",
      updatedAt: occurredAt
    },
    expectedProjectRevision,
    eventId,
    snapshotHash: createHash("sha256").update(`${eventId}:${topic}`).digest("hex"),
    occurredAt,
    reason: "project_updated"
  };
}
