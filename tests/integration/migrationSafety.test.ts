import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { applyMigration, inspectMigration, rollbackMigration, verifyMigration } from "../../src/migration/commands.mjs";
import { parseMigrationArgs } from "../../src/migration/cli.mjs";
import { acquireMigrationLock } from "../../src/migration/lock.mjs";
import { migrateCodexSettingsObject } from "../../src/migration/settings.mjs";
import { prepareDataRoot } from "../../scripts/selftest/migration.mjs";
import { satisfiesNodeEngine } from "../../scripts/lib/checks.mjs";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("migration safety", () => {
  it("rejects missing migration data-root arguments", () => {
    expect(() => parseMigrationArgs(["apply", "--data-root"])).toThrow("--data-root requires a value");
    expect(() => parseMigrationArgs(["apply", "--data-root", "--json"])).toThrow("--data-root requires a value");
    expect(() => parseMigrationArgs(["apply", "--data-root="])).toThrow("--data-root requires a value");
    expect(parseMigrationArgs(["apply", "--data-root", ".tmp/migration-test"])).toMatchObject({
      command: "apply",
      dataRoot: ".tmp/migration-test"
    });
  });

  it("enforces both bounds of the supported Node range", () => {
    expect(satisfiesNodeEngine("22.16.0", ">=22.16.0 <23")).toBe(true);
    expect(satisfiesNodeEngine("22.22.2", ">=22.16.0 <23")).toBe(true);
    expect(satisfiesNodeEngine("22.15.9", ">=22.16.0 <23")).toBe(false);
    expect(satisfiesNodeEngine("23.0.0", ">=22.16.0 <23")).toBe(false);
  });

  it("only clears dedicated top-level self-test directories", async () => {
    const unsafeRoot = join(process.cwd(), ".tmp", `not-selftest-${process.pid}-${Date.now()}`);
    mkdirSync(unsafeRoot, { recursive: true });
    writeFileSync(join(unsafeRoot, "keep.txt"), "keep", "utf8");
    roots.push(unsafeRoot);
    await expect(prepareDataRoot({ repoRoot: process.cwd(), dataRoot: unsafeRoot })).rejects.toThrow(".tmp/aetherops-selftest");
    expect(readFileSync(join(unsafeRoot, "keep.txt"), "utf8")).toBe("keep");

    const safeRoot = join(process.cwd(), ".tmp", `aetherops-selftest-safety-${process.pid}-${Date.now()}`);
    mkdirSync(safeRoot, { recursive: true });
    writeFileSync(join(safeRoot, "clear.txt"), "clear", "utf8");
    roots.push(safeRoot);
    await prepareDataRoot({ repoRoot: process.cwd(), dataRoot: safeRoot });
    expect(existsSync(join(safeRoot, "clear.txt"))).toBe(false);
  });

  it("maps every unsupported legacy Codex model to the current default", () => {
    for (const model of ["gpt-5", "gpt-5.5-codex", "gpt-5.6-typo"]) {
      const migrated = migrateCodexSettingsObject({ openCodeLlm: { source: "codex-oauth", model } });
      expect(migrated).toMatchObject({ changed: true, originalModel: model, model: "gpt-5.6", reason: "unsupported_model" });
      expect(migrated.settings.codex).toEqual({ model: "gpt-5.6", reasoningEffort: "xhigh", timeoutMs: 180_000, taskTimeoutMs: 600_000 });
    }
  });

  it("prefers valid active Codex settings and bounds the migrated task timeout", () => {
    const active = migrateCodexSettingsObject({
      codex: { model: "gpt-5.6-sol", reasoningEffort: "high", timeoutMs: 120_000, taskTimeoutMs: 700_000 },
      openCodeLlm: { model: "gpt-5.5", reasoningEffort: "xhigh", timeoutMs: 90_000 },
      openCode: { timeoutMs: 900_000 }
    });
    expect(active.settings.codex).toEqual({ model: "gpt-5.6-sol", reasoningEffort: "high", timeoutMs: 120_000, taskTimeoutMs: 700_000 });

    const legacy = migrateCodexSettingsObject({
      openCodeLlm: { model: "gpt-5.5", reasoningEffort: "high", timeoutMs: 75_000 },
      openCode: { timeoutMs: 850_000 }
    });
    expect(legacy.settings.codex).toEqual({ model: "gpt-5.5", reasoningEffort: "high", timeoutMs: 75_000, taskTimeoutMs: 850_000 });
  });

  it("uses an exclusive lock for mutating migration commands", () => {
    const context = createContext("lock");
    const release = acquireMigrationLock(context.migrationRoot, "test-holder");
    try {
      expect(() => applyMigration(context)).toThrow(/already locked/i);
      expect(() => rollbackMigration(context)).toThrow(/already locked/i);
    } finally {
      release();
    }
    expect(applyMigration(context).ok).toBe(true);
  });

  it("keeps check and verify read-only while validating the complete baseline", () => {
    const context = createContext("read-only");
    writeV1Project(context.dataRoot);
    const applied = applyMigration(context);
    expect(applied.ok).toBe(true);
    const before = snapshotWriteState(context.dataRoot);
    const checked = inspectMigration(context);
    const verified = verifyMigration(context);
    const after = snapshotWriteState(context.dataRoot);
    expect(checked.ok).toBe(true);
    expect(verified, JSON.stringify(verified, null, 2)).toMatchObject({ ok: true });
    expect(after).toEqual(before);

    const manifest = JSON.parse(readFileSync(join(context.migrationRoot, "v2", "manifest.json"), "utf8"));
    expect(manifest.targetFiles.length).toBeGreaterThan(0);
    expect(manifest.targetDbSummary.verification).toMatchObject({
      schemaFingerprint: expect.any(String),
      rowIdHash: expect.any(String),
      canonicalJsonHash: expect.any(String),
      semanticReadbackHash: expect.any(String)
    });
  });

  it("detects target file SHA-256 changes", () => {
    const context = createContext("file-tamper");
    expect(applyMigration(context).ok).toBe(true);
    writeFileSync(join(context.migrationRoot, "v2", "settings.archive.json"), '{"present":true}\n', "utf8");
    const verified = verifyMigration(context);
    expect(verified.ok).toBe(false);
    expect(verified.error).toMatch(/SHA-256 changed/);
  });

  it("migrates deprecated settings once while archiving and retiring OpenCode", () => {
    const context = createContext("codex-settings");
    const settingsPath = join(context.dataRoot, "settings.json");
    const original = {
      openCodeLlm: { source: "codex-oauth", model: "gpt-5.5-codex" },
      openCode: { enabled: true, command: "opencode", provider: "openai", model: "engineering-model", timeoutMs: 90_000 },
      encryptedEmbeddingKey: "enc:v1:preserve-embedding",
      encryptedWebSearchKey: "enc:v1:preserve-search",
      updatedAt: "2026-07-01T00:00:00.000Z"
    };
    writeFileSync(settingsPath, `${JSON.stringify(original, null, 2)}\n`, "utf8");

    const applied = applyMigration(context);
    expect(applied).toMatchObject({ ok: true, settingsMigration: { changed: true, originalModel: "gpt-5.5-codex", model: "gpt-5.6" } });
    const migrated = JSON.parse(readFileSync(settingsPath, "utf8"));
    expect(migrated.codex).toEqual({ model: "gpt-5.6", reasoningEffort: "xhigh", timeoutMs: 180_000, taskTimeoutMs: 600_000 });
    expect(migrated.openCodeLlm).toBeUndefined();
    expect(migrated.openCode).toBeUndefined();
    expect(migrated.encryptedEmbeddingKey).toBe(original.encryptedEmbeddingKey);
    expect(migrated.encryptedWebSearchKey).toBe(original.encryptedWebSearchKey);

    const archive = JSON.parse(readFileSync(join(context.migrationRoot, "v2", "settings.archive.json"), "utf8"));
    expect(archive.codexMigration).toMatchObject({ changed: true, originalModel: "gpt-5.5-codex", model: "gpt-5.6" });
    expect(archive.codexMigration.retiredExecutors.openCode.value).toEqual(original.openCode);
    const journal = JSON.parse(readFileSync(join(context.migrationRoot, "codex-settings-journal.json"), "utf8"));
    expect(journal).toMatchObject({ changed: true, originalModel: "gpt-5.5-codex", model: "gpt-5.6" });

    expect(applyMigration(context)).toMatchObject({ ok: true, status: "already-applied", applied: false, settingsMigration: { changed: false } });
    expect(rollbackMigration(context)).toMatchObject({ ok: true, status: "rolled-back" });
    expect(JSON.parse(readFileSync(settingsPath, "utf8"))).toEqual(original);
  });

  it("preserves a supported compatibility Codex model", () => {
    const context = createContext("codex-compatible");
    const settingsPath = join(context.dataRoot, "settings.json");
    writeFileSync(
      settingsPath,
      `${JSON.stringify({ openCodeLlm: { source: "codex-oauth", model: "gpt-5.5", reasoningEffort: "high", timeoutMs: 75_000 } }, null, 2)}\n`,
      "utf8"
    );

    expect(applyMigration(context)).toMatchObject({ ok: true, settingsMigration: { changed: true } });
    expect(JSON.parse(readFileSync(settingsPath, "utf8")).codex).toEqual({
      model: "gpt-5.5",
      reasoningEffort: "high",
      timeoutMs: 75_000,
      taskTimeoutMs: 600_000
    });
  });

  it("refuses to discard post-migration v2 data without explicit approval", () => {
    const context = createContext("rollback-guard");
    expect(applyMigration(context).ok).toBe(true);
    const targetDb = join(context.migrationRoot, "v2", "storage.sqlite");
    const db = new DatabaseSync(targetDb);
    db.prepare("insert into storage_v2_meta (key, value, updated_at) values (?, ?, datetime('now'))").run("post_migration", "present");
    db.close();

    const reapply = applyMigration(context);
    expect(reapply).toMatchObject({ ok: true, status: "already-applied" });
    expect(verifyMigration(context)).toMatchObject({ ok: true, status: "verified-with-v2-changes" });
    const readback = new DatabaseSync(targetDb, { readOnly: true });
    expect(readback.prepare("select value from storage_v2_meta where key = ?").get("post_migration")).toMatchObject({ value: "present" });
    readback.close();

    const denied = rollbackMigration(context);
    expect(denied).toMatchObject({ ok: false, status: "approval-required" });
    expect(existsSync(targetDb)).toBe(true);
    expect(existsSync(join(context.migrationRoot, "current.json"))).toBe(true);

    const approved = rollbackMigration(context, { allowV2DataLoss: true });
    expect(approved).toMatchObject({ ok: true, status: "rolled-back" });
    expect(existsSync(targetDb)).toBe(false);
    expect(existsSync(approved.archivedTargetRoot)).toBe(true);
  });

  it("allows only declared runtime files and validates every runtime SQLite", () => {
    const context = createContext("runtime-policy");
    expect(applyMigration(context).ok).toBe(true);
    const targetRoot = join(context.migrationRoot, "v2");
    const runtimeDbPath = join(targetRoot, "main", "main.sqlite");
    mkdirSync(join(targetRoot, "main", "files", "artifacts"), { recursive: true });
    const runtimeDb = new DatabaseSync(runtimeDbPath);
    runtimeDb.exec("create table runtime_items (id text primary key, data text not null)");
    runtimeDb.prepare("insert into runtime_items (id, data) values (?, ?)").run("runtime-1", JSON.stringify({ value: "valid" }));
    runtimeDb.close();
    writeFileSync(join(targetRoot, "main", "files", "artifacts", "result.txt"), "runtime artifact\n", "utf8");

    expect(verifyMigration(context)).toMatchObject({ ok: true, status: "verified-with-v2-changes" });
    writeFileSync(join(targetRoot, "unexpected.bin"), "not declared", "utf8");
    expect(verifyMigration(context)).toMatchObject({ ok: false, status: "mismatch" });
  });

  it("rejects operational schema drift even when runtime row changes are allowed", () => {
    const context = createContext("runtime-schema-drift");
    expect(applyMigration(context).ok).toBe(true);
    const targetDb = join(context.migrationRoot, "v2", "storage.sqlite");
    const db = new DatabaseSync(targetDb);
    db.prepare("insert into storage_v2_meta (key, value, updated_at) values (?, ?, datetime('now'))").run("runtime-row", "allowed");
    db.exec("create table unauthorized_runtime_table (id text primary key)");
    db.close();

    expect(verifyMigration(context)).toMatchObject({
      ok: false,
      status: "mismatch",
      error: expect.stringMatching(/schema fingerprint|table set/i)
    });
  });

  it("rejects same-name operational trigger definition drift", () => {
    const context = createContext("runtime-trigger-drift");
    expect(applyMigration(context).ok).toBe(true);
    const targetDb = join(context.migrationRoot, "v2", "storage.sqlite");
    const db = new DatabaseSync(targetDb);
    db.exec(`
      drop trigger trg_engineering_promotions_stale_only;
      create trigger trg_engineering_promotions_stale_only before update on engineering_result_promotions
        begin select 1; end;
    `);
    expect(db.prepare("select count(*) count from sqlite_master where type='trigger' and name=?").get("trg_engineering_promotions_stale_only")).toEqual({
      count: 1
    });
    db.close();

    expect(verifyMigration(context)).toMatchObject({
      ok: false,
      status: "mismatch",
      error: expect.stringMatching(/schema fingerprint/i)
    });
  });

  it("accepts only hash-addressed runtime CAS bytes and reports unreferenced objects for bounded startup cleanup", () => {
    const context = createContext("runtime-cas-policy");
    expect(applyMigration(context).ok).toBe(true);
    const bytes = Buffer.from("uncommitted but hash-valid CAS bytes", "utf8");
    const hash = createHash("sha256").update(bytes).digest("hex");
    const directory = join(context.migrationRoot, "v2", "terminal-cas", "sha256", hash.slice(0, 2));
    mkdirSync(directory, { recursive: true });
    const path = join(directory, hash);
    writeFileSync(path, bytes);

    const valid = verifyMigration(context);
    expect(valid).toMatchObject({ ok: true, status: "verified-with-v2-changes" });
    expect(valid.verification.baselineChanges).toEqual(expect.arrayContaining([expect.stringMatching(/unreferenced CAS object pending bounded cleanup/)]));
    writeFileSync(path, "tampered bytes", "utf8");
    expect(verifyMigration(context)).toMatchObject({
      ok: false,
      status: "mismatch",
      error: expect.stringMatching(/content-addressed file identity is invalid/)
    });
  });
});

function createContext(label: string) {
  const parent = join(process.cwd(), ".tmp", "migration-tests");
  mkdirSync(parent, { recursive: true });
  const dataRoot = join(parent, `${label}-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  mkdirSync(dataRoot, { recursive: true });
  roots.push(dataRoot);
  return { dataRoot, migrationRoot: join(dataRoot, "migration") };
}

function writeV1Project(dataRoot: string) {
  const db = new DatabaseSync(join(dataRoot, "aetherops.sqlite"));
  db.exec("create table projects (id text primary key, data text not null)");
  const project = {
    id: "project_migration_safety",
    projectRoot: "migration-safety-2026-projectmig",
    topic: "Migration safety",
    status: "idle",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z"
  };
  db.prepare("insert into projects (id, data) values (?, ?)").run(project.id, JSON.stringify(project));
  db.close();
}

function snapshotWriteState(root: string) {
  const output: Record<string, { size: number; mtimeMs: number }> = {};
  const walk = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolute = join(directory, entry.name);
      if (entry.isDirectory()) walk(absolute);
      else if (entry.isFile()) {
        if (/\.sqlite-(?:shm|wal)$/i.test(entry.name)) continue;
        const stats = statSync(absolute);
        output[absolute.slice(root.length + 1)] = { size: stats.size, mtimeMs: stats.mtimeMs };
      }
    }
  };
  walk(root);
  return output;
}
