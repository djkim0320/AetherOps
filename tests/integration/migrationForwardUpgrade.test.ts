import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { applyMigration, rollbackMigration, verifyMigration } from "../../src/migration/commands.mjs";
import { collectFileEntries, writeJsonFile } from "../../src/migration/files.mjs";
import { buildForwardReadbackBaseline, verifyForwardReadbackBaseline } from "../../src/migration/forwardReadback.mjs";
import { forwardUpgradeJournalPath, recoverPendingForwardUpgrade, writeForwardUpgradeJournal } from "../../src/migration/forwardUpgradeRecovery.mjs";
import { stableJsonHash } from "../../src/migration/hash.mjs";
import { inspectOperationalSchema } from "../../src/migration/operationalSchema.mjs";
import { acquireStorageOwnerLock } from "../../src/migration/storageOwnerLock.mjs";
import { checkpointSqliteFile, inspectSqliteFile, loadV2BaseSchemaSql, loadV2FtsSql, loadV2OperationalMigrationSql } from "../../src/migration/sqlite.mjs";
import {
  STORAGE_RUN_STATE_MIGRATION_CHECKSUM,
  STORAGE_RUN_STATE_MIGRATION_NAME,
  STORAGE_RUN_STATE_SCHEMA_VERSION
} from "../../src/server/runtime/storage/v2/runStateSchema.js";
import {
  STORAGE_RUN_STATE_BOOTSTRAP_MIGRATION_CHECKSUM,
  STORAGE_RUN_STATE_BOOTSTRAP_MIGRATION_NAME,
  STORAGE_RUN_STATE_BOOTSTRAP_SCHEMA_VERSION
} from "../../src/server/runtime/storage/v2/runStateBootstrapSchema.js";
import { acquireStorageRuntimeOwnerLock } from "../../src/server/runtime/storage/worker/storageOwnerLock.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("applied v2 target forward migration", () => {
  it("backs up and atomically upgrades a populated old-v2 target through v10", () => {
    const fixture = createAppliedOldV2Target("populated");
    expect(verifyMigration(fixture.context)).toMatchObject({ ok: false, status: "mismatch" });
    expect(inspectOperationalSchema(fixture.targetDbPath)).toMatchObject({ ready: false, installedVersions: [] });
    const beforeDb = inspectSqliteFile(fixture.targetDbPath);

    const upgraded = applyMigration(fixture.context);

    expect(upgraded).toMatchObject({
      ok: true,
      applied: true,
      status: "schema-upgraded",
      schemaUpgrade: {
        changed: true,
        databaseUpgrade: { appliedVersions: [2, 3, 4, 5, 6, 7, 8, 9, 10, 11] }
      }
    });
    expect(inspectOperationalSchema(fixture.targetDbPath)).toMatchObject({
      ready: true,
      currentVersion: 11,
      installedVersions: [2, 3, 4, 5, 6, 7, 8, 9, 10, 11]
    });
    const readback = new DatabaseSync(fixture.targetDbPath, { readOnly: true });
    try {
      expect(readback.prepare("select id,topic from projects_v2 where id=?").get(fixture.projectId)).toEqual({
        id: fixture.projectId,
        topic: "Forward migration fixture"
      });
      expect(readback.prepare("select id,status,payload from jobs where id='job-old-v2'").get()).toEqual({
        id: "job-old-v2",
        status: "completed",
        payload: '{"fixture":"old-v2"}'
      });
      expect(readback.prepare("pragma integrity_check").all()).toEqual([{ integrity_check: "ok" }]);
      expect(readback.prepare("pragma foreign_key_check").all()).toEqual([]);
      expect(readback.prepare("select count(*) count from canonical_terminal_verifier_receipts").get()).toEqual({ count: 0 });
      expect(readback.prepare("select count(*) count from canonical_terminal_result_attestations").get()).toEqual({ count: 0 });
      expect(readback.prepare("select count(*) count from sqlite_master where type='trigger' and name like 'trg_terminal_verifier_receipts_%'").get()).toEqual({
        count: 2
      });
    } finally {
      readback.close();
    }
    const backupManifest = readJson<Record<string, unknown>>(upgraded.schemaUpgrade.backup.manifestPath);
    expect(backupManifest).toMatchObject({
      kind: "target-forward-upgrade-backup",
      database: { rawSha256: beforeDb.rawSha256, rowIdHash: beforeDb.rowIdHash, canonicalJsonHash: beforeDb.canonicalJsonHash }
    });
    expect(existsSync(`${upgraded.schemaUpgrade.backup.manifestPath}.sha256`)).toBe(true);
    expect(verifyMigration(fixture.context)).toMatchObject({ ok: true, status: "verified" });

    writeJsonFile(join(fixture.context.migrationRoot, "current.json"), fixture.currentBefore);
    writeForwardUpgradeJournal(fixture.context, recoveryOperation(fixture, upgraded));
    expect(recoverPendingForwardUpgrade(fixture.context)).toMatchObject({ recovered: true, status: "activated" });
    expect(verifyMigration(fixture.context)).toMatchObject({ ok: true, status: "verified" });

    const beforeReapply = snapshotTarget(fixture.context);
    expect(applyMigration(fixture.context)).toMatchObject({ ok: true, status: "already-applied", applied: false });
    expect(snapshotTarget(fixture.context)).toEqual(beforeReapply);

    const rollback = rollbackMigration(fixture.context);
    expect(rollback).toMatchObject({ ok: true, status: "rolled-back", archivedTargetRoot: expect.any(String) });
    expect(existsSync(fixture.targetDbPath)).toBe(false);
    expect(existsSync(join(fixture.context.dataRoot, "aetherops.sqlite"))).toBe(true);
  });

  it("removes unsafe duplicated source policy only from the active target and preserves the original backup", () => {
    const fixture = createAppliedOldV2Target("policy-secret");
    const secretCanary = "POLICY_SECRET_CANARY_8D77";
    const unrelatedCanary = "UNRELATED_PAYLOAD_CANARY_1B42";
    const payload = JSON.stringify({
      chat: { content: unrelatedCanary, token: "legitimate-domain-token", url: "https://example.com/?q=normal" },
      request: {
        toolPolicy: { sourceAccess: { mode: "allowlist", urls: [`https://example.com/data?sig=${secretCanary}`] } },
        canonicalInitializationAnchor: {
          immutablePolicy: {
            toolPolicy: { sourceAccess: { mode: "allowlist", urls: [`https://user:${secretCanary}@example.com/source`] } }
          }
        }
      }
    });
    const source = new DatabaseSync(fixture.targetDbPath);
    try {
      source.prepare("update jobs set status='queued',completed_at=null,payload=? where id='job-old-v2'").run(payload);
    } finally {
      source.close();
    }
    rebaselineTargetManifest(fixture.targetRoot, join(fixture.context.migrationRoot, "current.json"), fixture.currentBefore);

    const upgraded = applyMigration(fixture.context);
    expect(upgraded).toMatchObject({ ok: true, status: "schema-upgraded" });
    const active = new DatabaseSync(fixture.targetDbPath, { readOnly: true });
    try {
      const row = active.prepare("select status,tool_policy,blocked_reason,payload from jobs where id='job-old-v2'").get() as {
        status: string;
        tool_policy: string | null;
        blocked_reason: string | null;
        payload: string;
      };
      expect(row).toMatchObject({ status: "blocked", tool_policy: null, blocked_reason: "replan_required_unsafe_source_policy_removed" });
      expect(row.payload).not.toContain(secretCanary);
      expect(JSON.parse(row.payload)).toMatchObject({ chat: { content: unrelatedCanary, token: "legitimate-domain-token" } });
    } finally {
      active.close();
    }
    expect(readFileSync(fixture.targetDbPath).includes(Buffer.from(secretCanary))).toBe(false);
    expect(JSON.stringify(upgraded)).not.toContain(secretCanary);
    const backupDbPath = join(upgraded.schemaUpgrade.backup.root, "storage.sqlite");
    const backup = new DatabaseSync(backupDbPath, { readOnly: true });
    try {
      expect(String((backup.prepare("select payload from jobs where id='job-old-v2'").get() as { payload: string }).payload)).toContain(secretCanary);
    } finally {
      backup.close();
    }
    const beforeReapply = snapshotTarget(fixture.context);
    expect(applyMigration(fixture.context)).toMatchObject({ ok: true, status: "already-applied", applied: false });
    expect(snapshotTarget(fixture.context)).toEqual(beforeReapply);
  });

  it("does not erase the pre-upgrade rollback data-loss guard when rebasing the schema manifest", () => {
    const fixture = createAppliedOldV2Target("rollback-guard");
    const db = new DatabaseSync(fixture.targetDbPath);
    try {
      db.prepare("insert into storage_v2_meta(key,value,updated_at) values(?,?,?)").run("runtime_after_v2", "preserve", "2026-07-14T00:05:00.000Z");
    } finally {
      db.close();
    }

    expect(applyMigration(fixture.context)).toMatchObject({
      ok: true,
      status: "schema-upgraded",
      current: { rollbackRequiresV2DataLossApproval: true }
    });
    expect(verifyMigration(fixture.context)).toMatchObject({ ok: true, status: "verified" });
    expect(rollbackMigration(fixture.context)).toMatchObject({ ok: false, status: "approval-required" });
    expect(rollbackMigration(fixture.context, { allowV2DataLoss: true })).toMatchObject({ ok: true, status: "rolled-back" });
  });

  it("rejects a busy WAL checkpoint instead of copying an incomplete database", () => {
    const root = createContext("wal-busy").dataRoot;
    const path = join(root, "busy.sqlite");
    const writer = new DatabaseSync(path);
    const reader = new DatabaseSync(path);
    try {
      writer.exec("pragma journal_mode=WAL; create table items(id integer primary key,value text); insert into items(value) values('first')");
      checkpointSqliteFile(path);
      reader.exec("begin");
      reader.prepare("select * from items").all();
      writer.prepare("insert into items(value) values(?)").run("committed-in-wal");
      expect(() => checkpointSqliteFile(path, { busyTimeoutMs: 25 })).toThrow(/WAL checkpoint did not complete.*busy=1/i);
    } finally {
      if (reader.isTransaction) reader.exec("rollback");
      reader.close();
      writer.close();
    }
  });

  it("detects canonical payload mutation and missing operational ledgers", () => {
    const fixture = createAppliedOldV2Target("readback-ledger");
    const baseline = buildForwardReadbackBaseline(fixture.targetDbPath, { normalizeLegacyActiveJobs: true });
    const old = new DatabaseSync(fixture.targetDbPath);
    try {
      old.prepare("update jobs set payload=? where id='job-old-v2'").run('{"fixture":"corrupted"}');
    } finally {
      old.close();
    }
    expect(verifyForwardReadbackBaseline(fixture.targetDbPath, baseline)).toMatchObject({
      ok: false,
      errors: [expect.stringMatching(/canonical row data changed: jobs/)]
    });

    rebaselineTargetManifest(fixture.targetRoot, join(fixture.context.migrationRoot, "current.json"), fixture.currentBefore);
    expect(applyMigration(fixture.context)).toMatchObject({ ok: true, status: "schema-upgraded" });
    const upgraded = new DatabaseSync(fixture.targetDbPath);
    try {
      upgraded.prepare("delete from schema_migrations where version=7").run();
    } finally {
      upgraded.close();
    }
    expect(verifyMigration(fixture.context)).toMatchObject({
      ok: false,
      status: "mismatch",
      operationalSchema: { ready: false, errors: [expect.stringMatching(/migration 7 is missing/i)] }
    });
    const missingIndex = new DatabaseSync(fixture.targetDbPath);
    try {
      missingIndex
        .prepare("insert into schema_migrations(version,name,checksum_sha256,applied_at) values(?,?,?,?)")
        .run(
          STORAGE_RUN_STATE_BOOTSTRAP_SCHEMA_VERSION,
          STORAGE_RUN_STATE_BOOTSTRAP_MIGRATION_NAME,
          STORAGE_RUN_STATE_BOOTSTRAP_MIGRATION_CHECKSUM,
          "2026-07-14T00:00:00.000Z"
        );
      missingIndex.exec("drop index idx_run_state_revisions_project_run");
    } finally {
      missingIndex.close();
    }
    expect(inspectOperationalSchema(fixture.targetDbPath)).toMatchObject({
      ready: false,
      errors: [expect.stringMatching(/index is missing: idx_run_state_revisions_project_run/i)]
    });
  });

  it("restores the previous target after a crash between the two directory renames", () => {
    const fixture = createAppliedOldV2Target("rename-recovery");
    const upgraded = applyMigration(fixture.context);
    expect(upgraded).toMatchObject({ ok: true, status: "schema-upgraded" });
    const operation = recoveryOperation(fixture, upgraded);
    mkdirSync(join(fixture.context.migrationRoot, "staging"), { recursive: true });
    renameSync(fixture.targetRoot, operation.stagingRoot);
    writeJsonFile(join(fixture.context.migrationRoot, "current.json"), fixture.currentBefore);
    writeForwardUpgradeJournal(fixture.context, operation);

    expect(recoverPendingForwardUpgrade(fixture.context)).toMatchObject({ recovered: true, status: "restored" });
    expect(existsSync(fixture.targetDbPath)).toBe(true);
    expect(inspectOperationalSchema(fixture.targetDbPath)).toMatchObject({ ready: false, installedVersions: [] });
    expect(applyMigration(fixture.context)).toMatchObject({ ok: true, status: "schema-upgraded" });
  });

  it("continues a representative populated v4 target through v5-v11", () => {
    const fixture = createAppliedOldV2Target("partial-v4");
    const db = new DatabaseSync(fixture.targetDbPath);
    try {
      const sql = loadV2OperationalMigrationSql();
      db.exec(sql.trace);
      for (const [name, definition] of [
        ["request_hash", "text"],
        ["requested_capabilities", "text"],
        ["effective_capabilities", "text"],
        ["tool_policy", "text"],
        ["blocked_reason", "text"],
        ["failure_reason", "text"],
        ["lease_generation", "integer not null default 0"]
      ]) {
        db.exec(`alter table jobs add column ${name} ${definition}`);
      }
      db.exec(sql.jobFencing);
      db.prepare("delete from schema_migrations where version=6").run();
    } finally {
      db.close();
    }
    rebaselineTargetManifest(fixture.targetRoot, join(fixture.context.migrationRoot, "current.json"), fixture.currentBefore);
    expect(inspectOperationalSchema(fixture.targetDbPath)).toMatchObject({ ready: false, installedVersions: [2, 3, 4] });
    expect(applyMigration(fixture.context)).toMatchObject({
      ok: true,
      status: "schema-upgraded",
      schemaUpgrade: { databaseUpgrade: { appliedVersions: [5, 6, 7, 8, 9, 10, 11] } }
    });
    expect(inspectOperationalSchema(fixture.targetDbPath)).toMatchObject({ ready: true, installedVersions: [2, 3, 4, 5, 6, 7, 8, 9, 10, 11] });
  });

  it("upgrades an otherwise current v8 target through attestation, ownership, and side-effect ledgers", () => {
    const fixture = createAppliedOldV2Target("partial-v8");
    expect(applyMigration(fixture.context)).toMatchObject({ ok: true, status: "schema-upgraded" });
    const db = new DatabaseSync(fixture.targetDbPath);
    try {
      db.exec(`
        drop trigger trg_terminal_attestations_no_update;
        drop trigger trg_terminal_attestations_no_delete;
        drop trigger trg_capability_audits_owner_insert;
        drop trigger trg_capability_audits_owner_update;
        drop trigger trg_tool_attempts_owner_insert;
        drop trigger trg_tool_attempts_owner_update;
        drop trigger trg_tool_output_links_owner_insert;
        drop trigger trg_tool_output_links_owner_update;
        drop trigger trg_tool_side_effect_reservations_owner_insert;
        drop trigger trg_tool_side_effect_reservations_owner_update;
        drop table tool_side_effect_reservations;
        drop table canonical_terminal_result_attestations;
        delete from schema_migrations where version in (9,10,11);
      `);
    } finally {
      db.close();
    }
    const current = readJson<Record<string, unknown>>(join(fixture.context.migrationRoot, "current.json"));
    rebaselineTargetManifest(fixture.targetRoot, join(fixture.context.migrationRoot, "current.json"), current);

    expect(inspectOperationalSchema(fixture.targetDbPath)).toMatchObject({ ready: false, currentVersion: 8, installedVersions: [2, 3, 4, 5, 6, 7, 8] });
    expect(applyMigration(fixture.context)).toMatchObject({
      ok: true,
      status: "schema-upgraded",
      schemaUpgrade: { databaseUpgrade: { appliedVersions: [9, 10, 11] } }
    });
    expect(inspectOperationalSchema(fixture.targetDbPath)).toMatchObject({ ready: true, currentVersion: 11 });
  });

  it("leaves the active target and pointer byte-identical when a staged partial migration fails", () => {
    const fixture = createAppliedOldV2Target("staged-failure");
    const db = new DatabaseSync(fixture.targetDbPath);
    try {
      db.exec("create table schema_migrations(version integer primary key,name text not null,checksum_sha256 text not null,applied_at text not null)");
      db.prepare("insert into schema_migrations(version,name,checksum_sha256,applied_at) values(?,?,?,?)").run(
        STORAGE_RUN_STATE_SCHEMA_VERSION,
        STORAGE_RUN_STATE_MIGRATION_NAME,
        STORAGE_RUN_STATE_MIGRATION_CHECKSUM,
        "2026-07-14T00:00:00.000Z"
      );
    } finally {
      db.close();
    }
    rebaselineTargetManifest(fixture.targetRoot, join(fixture.context.migrationRoot, "current.json"), fixture.currentBefore);
    const before = snapshotTarget(fixture.context);

    expect(applyMigration(fixture.context)).toMatchObject({ ok: false, status: "repair-required" });
    expect(snapshotTarget(fixture.context)).toEqual(before);
    expect(inspectOperationalSchema(fixture.targetDbPath)).toMatchObject({ ready: false, installedVersions: [5] });
  });

  it("rejects a recovery journal that attempts to escape the migration root", () => {
    const context = createContext("journal-traversal");
    const victim = join(context.dataRoot, "victim");
    mkdirSync(victim, { recursive: true });
    writeFileSync(join(victim, "keep.txt"), "keep", "utf8");
    mkdirSync(context.migrationRoot, { recursive: true });
    writeFileSync(
      forwardUpgradeJournalPath(context),
      JSON.stringify({
        version: 1,
        attemptId: "../../victim",
        targetRoot: join(context.migrationRoot, "v2"),
        stagingRoot: victim,
        displacedRoot: victim,
        previousCurrent: {},
        nextCurrent: {}
      }),
      "utf8"
    );
    expect(() => recoverPendingForwardUpgrade(context)).toThrow(/journal is invalid/i);
    expect(readFileSync(join(victim, "keep.txt"), "utf8")).toBe("keep");
  });

  it("mutually excludes a live storage runtime and migration activation", () => {
    const context = createContext("storage-owner-lock");
    const appDbPath = join(context.migrationRoot, "v2", "storage.sqlite");
    const releaseMigration = acquireStorageOwnerLock(context.migrationRoot, "migration-test");
    try {
      expect(() => acquireStorageRuntimeOwnerLock(appDbPath)).toThrow(/owned by active migration-test process/i);
    } finally {
      releaseMigration();
    }

    const releaseRuntime = acquireStorageRuntimeOwnerLock(appDbPath);
    try {
      expect(applyMigration(context)).toMatchObject({ ok: false, status: "not-ready", error: expect.stringMatching(/storage-worker-runtime/) });
    } finally {
      releaseRuntime();
    }
  });
});

function createAppliedOldV2Target(label: string) {
  const context = createContext(label);
  const projectId = `project_forward_${label}`;
  writeV1Project(context.dataRoot, projectId);
  expect(applyMigration(context)).toMatchObject({ ok: true, status: "applied" });
  const currentPath = join(context.migrationRoot, "current.json");
  const current = readJson<FixturePointer>(currentPath);
  const targetRoot = current.targetRoot;
  const targetDbPath = current.targetDbPath;
  rmSync(targetDbPath, { force: true });
  rmSync(`${targetDbPath}-wal`, { force: true });
  rmSync(`${targetDbPath}-shm`, { force: true });

  const db = new DatabaseSync(targetDbPath);
  try {
    db.exec("pragma foreign_keys=on");
    db.exec(loadV2BaseSchemaSql());
    db.exec(loadV2FtsSql());
    for (const column of [
      "lease_generation",
      "request_hash",
      "requested_capabilities",
      "effective_capabilities",
      "tool_policy",
      "blocked_reason",
      "failure_reason"
    ]) {
      db.exec(`alter table jobs drop column ${column}`);
    }
    db.prepare("insert into storage_v2_meta(key,value,updated_at) values('schema_version','2',?)").run("2026-07-14T00:00:00.000Z");
    const project = {
      id: projectId,
      projectRoot: `forward-${label}-root`,
      topic: "Forward migration fixture",
      status: "idle",
      createdAt: "2026-07-14T00:00:00.000Z",
      updatedAt: "2026-07-14T00:00:00.000Z"
    };
    db.prepare("insert into projects_v2(id,short_id,project_root,topic,status,current_step,created_at,updated_at,data) values(?,?,?,?,?,?,?,?,?)").run(
      project.id,
      project.id.slice(-12),
      project.projectRoot,
      project.topic,
      project.status,
      null,
      project.createdAt,
      project.updatedAt,
      JSON.stringify(project)
    );
    db.prepare(
      `insert into jobs(id,project_id,operation,status,priority,attempt,queued_at,completed_at,created_at,updated_at,payload)
       values(?,?,?,'completed',0,1,?,?,?,?,?)`
    ).run(
      "job-old-v2",
      projectId,
      "research_loop",
      "2026-07-14T00:00:00.000Z",
      "2026-07-14T00:01:00.000Z",
      "2026-07-14T00:00:00.000Z",
      "2026-07-14T00:01:00.000Z",
      '{"fixture":"old-v2"}'
    );
  } finally {
    db.close();
  }
  rebaselineTargetManifest(targetRoot, currentPath, current);
  return { context, projectId, targetRoot, targetDbPath, currentBefore: readJson<FixturePointer>(currentPath) };
}

function recoveryOperation(
  fixture: ReturnType<typeof createAppliedOldV2Target>,
  upgraded: { current: FixturePointer; schemaUpgrade: { forwardUpgrade: { attemptId: string } } }
) {
  const attemptId = upgraded.schemaUpgrade.forwardUpgrade.attemptId;
  return {
    version: 1,
    status: "prepared",
    attemptId,
    targetRoot: fixture.targetRoot,
    stagingRoot: join(fixture.context.migrationRoot, "staging", attemptId),
    displacedRoot: join(fixture.context.migrationRoot, "replaced", attemptId),
    previousCurrent: fixture.currentBefore,
    nextCurrent: upgraded.current,
    createdAt: "2026-07-14T00:10:00.000Z"
  };
}

function rebaselineTargetManifest(targetRoot: string, currentPath: string, current: Record<string, unknown>) {
  const manifestPath = join(targetRoot, "manifest.json");
  const existing = readJson<FixtureTargetManifest>(manifestPath);
  const database = inspectSqliteFile(join(targetRoot, "storage.sqlite"));
  const targetFiles = collectFileEntries(targetRoot, { skipRelativePrefixes: ["manifest.json", "manifest.json.sha256"] });
  const targetDbSummary = {
    ...existing.targetDbSummary,
    targetSchemaFingerprint: database.schemaFingerprint,
    schemaFingerprint: database.schemaFingerprint,
    verification: {
      schemaFingerprint: database.schemaFingerprint,
      tables: database.tables,
      rowIdHash: database.rowIdHash,
      canonicalJsonHash: database.canonicalJsonHash,
      semanticReadback: database.semanticReadback,
      semanticReadbackHash: database.semanticReadback.hash
    }
  };
  const withoutHash = {
    ...existing,
    targetFiles,
    targetDbSummary,
    targetSchemaFingerprint: database.schemaFingerprint,
    schemaFingerprint: database.schemaFingerprint
  };
  delete withoutHash.manifestHash;
  const nextManifest = { ...withoutHash, manifestHash: stableJsonHash(withoutHash) };
  const manifestWrite = writeJsonFile(manifestPath, nextManifest);
  writeFileSync(`${manifestPath}.sha256`, `${manifestWrite.sha256}\n`, "utf8");
  writeJsonFile(currentPath, { ...current, targetManifestSha256: manifestWrite.sha256 });
}

function createContext(label: string) {
  const parent = join(process.cwd(), ".tmp", "migration-forward-tests");
  mkdirSync(parent, { recursive: true });
  const dataRoot = join(parent, `${label}-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  mkdirSync(dataRoot, { recursive: true });
  roots.push(dataRoot);
  return { dataRoot, migrationRoot: join(dataRoot, "migration") };
}

function writeV1Project(dataRoot: string, projectId: string) {
  const db = new DatabaseSync(join(dataRoot, "aetherops.sqlite"));
  try {
    db.exec("create table projects(id text primary key,data text not null)");
    const project = {
      id: projectId,
      projectRoot: `${projectId}-root`,
      topic: "Forward migration fixture",
      status: "idle",
      createdAt: "2026-07-14T00:00:00.000Z",
      updatedAt: "2026-07-14T00:00:00.000Z"
    };
    db.prepare("insert into projects(id,data) values(?,?)").run(project.id, JSON.stringify(project));
  } finally {
    db.close();
  }
}

function snapshotTarget(context: { migrationRoot: string }) {
  const current = readFileSync(join(context.migrationRoot, "current.json"));
  const manifest = readFileSync(join(context.migrationRoot, "v2", "manifest.json"));
  const database = readFileSync(join(context.migrationRoot, "v2", "storage.sqlite"));
  return { current: stableJsonHash(current), manifest: stableJsonHash(manifest), database: stableJsonHash(database) };
}

interface FixturePointer extends Record<string, unknown> {
  targetRoot: string;
  targetDbPath: string;
}

interface FixtureTargetManifest extends Record<string, unknown> {
  targetDbSummary: Record<string, unknown>;
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}
