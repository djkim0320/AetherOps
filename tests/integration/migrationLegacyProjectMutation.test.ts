import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { applyMigration, inspectMigration, verifyMigration } from "../../src/migration/commands.mjs";
import { sha256Hex, stableJsonHash } from "../../src/migration/hash.mjs";
import { inspectLegacyProjectMutationSchema } from "../../src/migration/legacyProjectMutationSchema.mjs";
import { inspectOperationalSchema } from "../../src/migration/operationalSchema.mjs";
import { inspectProjectMutationCrossDatabase } from "../../src/migration/projectMutationCrossDatabase.mjs";
import { DurableJobRuntime } from "../../src/server/composition/durableJobRuntime.js";
import { ProjectMutationSagaCoordinator } from "../../src/server/composition/projectMutationSagaCoordinator.js";
import { createLegacyStorageWorker } from "../../src/server/runtime/storage/worker/legacyStorageClient.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("legacy project mutation migration coordination", () => {
  it("migrates only the staged legacy copy, verifies read-only, and is byte-idempotent", () => {
    const context = createContext("initial");
    const sourcePath = writeLegacySource(context.dataRoot);
    const sourceBefore = sha256Hex(readFileSync(sourcePath));

    const applied = applyMigration(context);
    expect(applied).toMatchObject({ ok: true, status: "applied", legacyMutationSchema: { changed: true } });
    expect(sha256Hex(readFileSync(sourcePath))).toBe(sourceBefore);
    expect(sha256Hex(readFileSync(join(applied.backupManifest.backupRoot, "aetherops.sqlite")))).toBe(sourceBefore);
    const legacyPath = join(context.migrationRoot, "v2", "legacy-research.sqlite");
    expect(inspectLegacyProjectMutationSchema(legacyPath)).toMatchObject({ ready: true, installedVersions: [1], conflicts: [] });
    expect(readMarker(legacyPath)).toBe("preserve-me");

    const beforeReadOnly = targetHashes(context);
    expect(inspectMigration(context)).toMatchObject({ ok: true, verified: true, legacyMutationSchema: { ready: true } });
    expect(verifyMigration(context)).toMatchObject({ ok: true, legacyMutationSchema: { ready: true } });
    expect(targetHashes(context)).toEqual(beforeReadOnly);
    expect(applyMigration(context)).toMatchObject({ ok: true, status: "already-applied", applied: false });
    expect(targetHashes(context)).toEqual(beforeReadOnly);
  });

  it("forward-upgrades an exact pre-ledger v2 legacy database through backup and staging without changing rows", () => {
    const context = createContext("forward");
    writeLegacySource(context.dataRoot);
    expect(applyMigration(context)).toMatchObject({ ok: true });
    const legacyPath = join(context.migrationRoot, "v2", "legacy-research.sqlite");
    const old = new DatabaseSync(legacyPath);
    old.exec("drop table schema_migrations");
    old.close();
    const beforeUpgrade = sha256Hex(readFileSync(legacyPath));
    expect(verifyMigration(context)).toMatchObject({ ok: false, status: "mismatch" });

    const upgraded = applyMigration(context);
    expect(upgraded).toMatchObject({
      ok: true,
      status: "schema-upgraded",
      schemaUpgrade: { changed: true, legacyDatabaseUpgrade: { changed: true, after: { ready: true } } }
    });
    expect(readMarker(legacyPath)).toBe("preserve-me");
    expect(inspectLegacyProjectMutationSchema(legacyPath)).toMatchObject({ ready: true, installedVersions: [1] });
    const backupLegacy = join(upgraded.schemaUpgrade.backup.root, "legacy-research.sqlite");
    expect(sha256Hex(readFileSync(backupLegacy))).toBe(beforeUpgrade);

    const afterUpgrade = targetHashes(context);
    expect(applyMigration(context)).toMatchObject({ ok: true, status: "already-applied", applied: false });
    expect(targetHashes(context)).toEqual(afterUpgrade);
  });

  it("fails closed without rewriting a partial or checksum-tampered legacy schema", () => {
    const context = createContext("tamper");
    writeLegacySource(context.dataRoot);
    expect(applyMigration(context)).toMatchObject({ ok: true });
    const legacyPath = join(context.migrationRoot, "v2", "legacy-research.sqlite");
    const db = new DatabaseSync(legacyPath);
    db.exec("drop trigger legacy_project_mutation_receipts_no_delete");
    db.close();
    const before = targetHashes(context);

    expect(inspectMigration(context)).toMatchObject({ verified: false, legacyMutationSchema: { ready: false } });
    expect(verifyMigration(context)).toMatchObject({ ok: false, status: "mismatch" });
    expect(applyMigration(context)).toMatchObject({ ok: false, status: "repair-required" });
    expect(targetHashes(context)).toEqual(before);
  });

  it("rejects either direction of a valid-but-split operational journal and legacy receipt pair", async () => {
    const context = createContext("split-brain");
    writeLegacySource(context.dataRoot);
    expect(applyMigration(context)).toMatchObject({ ok: true });
    const targetRoot = join(context.migrationRoot, "v2");
    const operationalPath = join(targetRoot, "storage.sqlite");
    const legacyPath = join(targetRoot, "legacy-research.sqlite");
    const preOperational = join(context.migrationRoot, "cross-pre-storage.sqlite");
    const preLegacy = join(context.migrationRoot, "cross-pre-legacy.sqlite");
    const postOperational = join(context.migrationRoot, "cross-post-storage.sqlite");
    const postLegacy = join(context.migrationRoot, "cross-post-legacy.sqlite");
    copyFileSync(operationalPath, preOperational);
    copyFileSync(legacyPath, preLegacy);

    const runtime = new DurableJobRuntime(operationalPath, { dataRoot: context.dataRoot });
    const legacy = createLegacyStorageWorker(legacyPath, join(context.dataRoot, "settings.json"));
    await legacy.ready;
    try {
      const coordinator = new ProjectMutationSagaCoordinator({
        operational: runtime.projectMutations,
        legacy: legacy.projectMutations,
        getSnapshot: (projectId) => legacy.researchStore.getSnapshot(projectId),
        getProjectRevisionHead: (projectId) => runtime.getProjectRevisionHead(projectId),
        projectRootBase: join(context.dataRoot, "projects"),
        resultMapper: {
          project: (snapshot, revision) => ({ id: snapshot.project.id, revision }),
          session: (session) => ({ id: session.id }),
          deleted: () => ({ deleted: true })
        },
        now: () => "2026-07-16T02:00:00.000Z"
      });
      await coordinator.create("cross-database-create", {
        goal: "Verify cross-database receipts",
        topic: "Split brain",
        scope: "Temporary SQLite only",
        budget: "Bounded"
      });
    } finally {
      await runtime.close();
      await legacy.close();
    }
    copyFileSync(operationalPath, postOperational);
    copyFileSync(legacyPath, postLegacy);
    expect(inspectProjectMutationCrossDatabase(operationalPath, legacyPath)).toMatchObject({ ready: true, matchedCount: 1 });
    expect(verifyMigration(context)).toMatchObject({ ok: true });

    replaceDatabase(preLegacy, legacyPath);
    expect(inspectOperationalSchema(operationalPath)).toMatchObject({ ready: true });
    expect(inspectLegacyProjectMutationSchema(legacyPath)).toMatchObject({ ready: true });
    expect(inspectProjectMutationCrossDatabase(operationalPath, legacyPath)).toMatchObject({
      ready: false,
      conflicts: [expect.stringMatching(/no legacy receipt/i)]
    });
    expect(verifyMigration(context)).toMatchObject({ ok: false, status: "mismatch" });

    replaceDatabase(postLegacy, legacyPath);
    replaceDatabase(preOperational, operationalPath);
    expect(inspectOperationalSchema(operationalPath)).toMatchObject({ ready: true });
    expect(inspectLegacyProjectMutationSchema(legacyPath)).toMatchObject({ ready: true });
    expect(inspectProjectMutationCrossDatabase(operationalPath, legacyPath)).toMatchObject({
      ready: false,
      conflicts: [expect.stringMatching(/no operational journal/i)]
    });
    expect(verifyMigration(context)).toMatchObject({ ok: false, status: "mismatch" });

    replaceDatabase(postOperational, operationalPath);
    expect(verifyMigration(context)).toMatchObject({ ok: true, projectMutationCrossDatabase: { ready: true, matchedCount: 1 } });
  });
});

function createContext(label: string): { dataRoot: string; migrationRoot: string } {
  const dataRoot = mkdtempSync(join(tmpdir(), `aetherops-legacy-migration-${label}-`));
  roots.push(dataRoot);
  return { dataRoot, migrationRoot: join(dataRoot, "migration") };
}

function writeLegacySource(dataRoot: string): string {
  mkdirSync(dataRoot, { recursive: true });
  const path = join(dataRoot, "aetherops.sqlite");
  const db = new DatabaseSync(path);
  try {
    db.exec(
      "create table projects(id text primary key,created_at text not null,data text not null); create table legacy_marker(id text primary key,value text not null)"
    );
    const project = {
      id: "legacy-project",
      projectRoot: "legacy-project-root",
      topic: "Legacy receipt migration",
      status: "idle",
      createdAt: "2026-07-16T00:00:00.000Z",
      updatedAt: "2026-07-16T00:00:00.000Z"
    };
    db.prepare("insert into projects(id,created_at,data) values(?,?,?)").run(project.id, project.createdAt, JSON.stringify(project));
    db.prepare("insert into legacy_marker(id,value) values('marker','preserve-me')").run();
  } finally {
    db.close();
  }
  return path;
}

function readMarker(path: string): string {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    return String(db.prepare("select value from legacy_marker where id='marker'").get()?.value);
  } finally {
    db.close();
  }
}

function targetHashes(context: { migrationRoot: string }): Record<string, string> {
  const root = join(context.migrationRoot, "v2");
  return Object.fromEntries(
    ["storage.sqlite", "legacy-research.sqlite", "manifest.json", "manifest.json.sha256"]
      .map((name) => [name, sha256Hex(readFileSync(join(root, name)))])
      .concat([["current.json", stableJsonHash(readFileSync(join(context.migrationRoot, "current.json")))]])
  );
}

function replaceDatabase(source: string, target: string): void {
  rmSync(`${target}-wal`, { force: true });
  rmSync(`${target}-shm`, { force: true });
  copyFileSync(source, target);
}
