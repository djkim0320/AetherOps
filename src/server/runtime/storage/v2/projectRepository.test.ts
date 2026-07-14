import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { StorageImmutableConflictError } from "./runStateErrors.js";
import { ProjectRepository } from "./projectRepository.js";
import { migrateStorageV2Schema } from "./schema.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("project storage ownership", () => {
  it("returns a full projection readback while keeping an established root immutable and uniquely owned", () => {
    const root = mkdtempSync(join(tmpdir(), "aetherops-project-ownership-"));
    roots.push(root);
    const firstRoot = join(root, "first");
    const secondRoot = join(root, "second");
    mkdirSync(firstRoot);
    mkdirSync(secondRoot);
    const db = new DatabaseSync(":memory:");
    try {
      migrateStorageV2Schema(db);
      const repository = new ProjectRepository(db);
      const first = project("project-first", firstRoot, "Initial topic");
      expect(repository.upsert(first)).toEqual(first);
      const updated = { ...first, topic: "Updated topic", updatedAt: "2026-07-14T00:01:00.000Z" };
      expect(repository.upsert(updated)).toEqual(updated);
      expect(repository.upsert(updated)).toEqual(updated);
      expect(() => repository.upsert(first)).toThrow(StorageImmutableConflictError);
      expect(() => repository.upsert({ ...updated, topic: "Conflicting same-revision topic" })).toThrow(StorageImmutableConflictError);
      expect(() => repository.upsert({ ...updated, projectRoot: secondRoot })).toThrow(StorageImmutableConflictError);
      expect(() => repository.upsert(project("project-second", firstRoot, "Duplicate owner"))).toThrow(StorageImmutableConflictError);
      expect(repository.upsert(project("project-second", secondRoot, "Unique owner"))).toMatchObject({ id: "project-second", projectRoot: secondRoot });
      expect(() => repository.assertOwnershipIntegrity()).not.toThrow();
      db.prepare("update projects_v2 set data=? where id=?").run(JSON.stringify({ ...updated, id: "project-split-owner" }), "project-first");
      expect(() => repository.assertOwnershipIntegrity()).toThrow(StorageImmutableConflictError);
    } finally {
      db.close();
    }
  });

  it("rejects project roots that contain or are contained by another project root", () => {
    const root = mkdtempSync(join(tmpdir(), "aetherops-project-overlap-"));
    roots.push(root);
    const parentFirst = join(root, "parent-first");
    const parentFirstChild = join(parentFirst, "child");
    const childFirstParent = join(root, "child-first");
    const childFirst = join(childFirstParent, "child");
    mkdirSync(parentFirstChild, { recursive: true });
    mkdirSync(childFirst, { recursive: true });
    const db = new DatabaseSync(":memory:");
    try {
      migrateStorageV2Schema(db);
      const repository = new ProjectRepository(db);
      repository.upsert(project("project-parent-first", parentFirst, "Parent first"));
      expect(() => repository.upsert(project("project-child-rejected", parentFirstChild, "Child rejected"))).toThrow(StorageImmutableConflictError);
      repository.upsert(project("project-child-first", childFirst, "Child first"));
      expect(() => repository.upsert(project("project-parent-rejected", childFirstParent, "Parent rejected"))).toThrow(StorageImmutableConflictError);
    } finally {
      db.close();
    }
  });
});

function project(id: string, projectRoot: string, topic: string) {
  return {
    id,
    projectRoot,
    topic,
    status: "active",
    createdAt: "2026-07-14T00:00:00.000Z",
    updatedAt: "2026-07-14T00:00:00.000Z"
  };
}
