import { existsSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { sha256Hex, stableJsonHash, stableStringify } from "./hash.mjs";

export const LEGACY_PROJECT_MUTATION_SCHEMA_VERSION = 1;
export const LEGACY_PROJECT_MUTATION_MIGRATION_NAME = "legacy-project-mutation-receipts-v1";
export const LEGACY_PROJECT_MUTATION_MIGRATION_CHECKSUM = "d25d3de3b7440908969abe2e5fa69273d960ad672279da0bafa8d7bcc7bae9aa";

const schemaSourceUrl = new URL("../server/runtime/storage/legacyProjectMutationSchema.ts", import.meta.url);
const RECEIPT_TABLE = "legacy_project_mutation_receipts";
const OBJECT_NAMES = [
  RECEIPT_TABLE,
  "idx_legacy_project_mutation_receipts_project",
  "legacy_project_mutation_receipts_no_update",
  "legacy_project_mutation_receipts_no_delete"
];
const LEDGER_COLUMNS = ["version", "name", "checksum_sha256", "applied_at"];

export function inspectLegacyProjectMutationSchema(dbPath) {
  if (!existsSync(dbPath)) return missingInspection(dbPath);
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return inspectDatabase(db, dbPath);
  } finally {
    db.close();
  }
}

export function upgradeLegacyProjectMutationSchema(dbPath) {
  const before = inspectLegacyProjectMutationSchema(dbPath);
  if (before.conflicts.length) throw new Error(`Legacy project mutation schema cannot be upgraded: ${before.conflicts.join("; ")}`);
  if (before.ready) return { changed: false, before, after: before };

  const db = new DatabaseSync(dbPath);
  try {
    db.exec("pragma journal_mode = WAL");
    db.exec("begin immediate");
    try {
      db.exec(loadLegacyProjectMutationSchemaSql());
      db.exec("commit");
    } catch (error) {
      if (db.isTransaction) db.exec("rollback");
      throw error;
    }
  } finally {
    db.close();
  }
  const after = inspectLegacyProjectMutationSchema(dbPath);
  if (!after.ready) throw new Error(`Legacy project mutation schema upgrade did not verify: ${[...after.errors, ...after.conflicts].join("; ")}`);
  return { changed: true, before, after };
}

export function loadLegacyProjectMutationSchemaSql() {
  const source = readFileSync(schemaSourceUrl, "utf8");
  const anchorIndex = source.indexOf("function installLegacyProjectMutationObjects");
  const templateStart = source.indexOf("db.exec(`", anchorIndex);
  const sqlStart = templateStart + "db.exec(`".length;
  const sqlEnd = source.indexOf("`);", sqlStart);
  if (anchorIndex < 0 || templateStart < 0 || sqlEnd < 0) throw new Error("Could not extract the legacy project mutation migration SQL.");
  const sql = source.slice(sqlStart, sqlEnd);
  const occurrences = sql.split(LEGACY_PROJECT_MUTATION_MIGRATION_CHECKSUM).length - 1;
  if (occurrences !== 1) throw new Error("Legacy project mutation migration checksum literal is missing or ambiguous.");
  const actualChecksum = sha256Hex(sql.replace(LEGACY_PROJECT_MUTATION_MIGRATION_CHECKSUM, "<checksum>"));
  if (actualChecksum !== LEGACY_PROJECT_MUTATION_MIGRATION_CHECKSUM) {
    throw new Error(
      `Legacy project mutation migration source checksum mismatch: expected ${LEGACY_PROJECT_MUTATION_MIGRATION_CHECKSUM}, computed ${actualChecksum}.`
    );
  }
  return sql;
}

function inspectDatabase(db, dbPath) {
  const errors = [];
  const conflicts = [];
  const objectRows = db.prepare("select type,name,sql from sqlite_master where name in (?, ?, ?, ?) order by name").all(...OBJECT_NAMES);
  const actualObjects = new Map(objectRows.map((row) => [String(row.name), row]));
  const presentCount = OBJECT_NAMES.filter((name) => actualObjects.has(name)).length;
  if (presentCount > 0 && presentCount < OBJECT_NAMES.length) conflicts.push("Legacy project mutation receipt objects are partially installed.");
  for (const name of OBJECT_NAMES) if (!actualObjects.has(name)) errors.push(`Legacy project mutation schema object is missing: ${name}`);
  if (presentCount === OBJECT_NAMES.length) compareObjectDefinitions(actualObjects, conflicts);

  const hasLedger = tableExists(db, "schema_migrations");
  if (!hasLedger) errors.push("Legacy schema migration ledger is missing.");
  else inspectLedger(db, errors, conflicts);
  if (actualObjects.has(RECEIPT_TABLE)) inspectReceiptRows(db, conflicts);
  const installedVersions = readInstalledVersions(db);
  return {
    path: dbPath,
    ready: errors.length === 0 && conflicts.length === 0,
    currentVersion: installedVersions.at(-1) ?? 0,
    installedVersions,
    expectedVersions: [LEGACY_PROJECT_MUTATION_SCHEMA_VERSION],
    errors,
    conflicts
  };
}

function compareObjectDefinitions(actualObjects, conflicts) {
  const expectedObjects = expectedObjectDefinitions();
  for (const name of OBJECT_NAMES) {
    const actual = actualObjects.get(name);
    const expected = expectedObjects.get(name);
    if (!expected || actual?.type !== expected.type || normalizedSqlHash(actual?.sql) !== expected.sqlHash) {
      conflicts.push(`Legacy project mutation schema object definition is incompatible: ${name}`);
    }
  }
}

let cachedExpectedObjects;
function expectedObjectDefinitions() {
  if (cachedExpectedObjects) return cachedExpectedObjects;
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(loadLegacyProjectMutationSchemaSql());
    cachedExpectedObjects = new Map(
      db
        .prepare("select type,name,sql from sqlite_master where name in (?, ?, ?, ?) order by name")
        .all(...OBJECT_NAMES)
        .map((row) => [String(row.name), { type: String(row.type), sqlHash: normalizedSqlHash(row.sql) }])
    );
    return cachedExpectedObjects;
  } finally {
    db.close();
  }
}

function inspectLedger(db, errors, conflicts) {
  const columns = db
    .prepare("pragma table_info(schema_migrations)")
    .all()
    .map((row) => String(row.name));
  if (columns.join("\u0000") !== LEDGER_COLUMNS.join("\u0000")) {
    conflicts.push("Legacy schema migration ledger has an incompatible definition.");
    return;
  }
  const rows = db.prepare("select version,name,checksum_sha256 from schema_migrations order by version").all();
  for (const row of rows) {
    if (Number(row.version) !== LEGACY_PROJECT_MUTATION_SCHEMA_VERSION) {
      conflicts.push(`Unsupported legacy migration version ${String(row.version)} is installed.`);
    } else if (row.name !== LEGACY_PROJECT_MUTATION_MIGRATION_NAME || row.checksum_sha256 !== LEGACY_PROJECT_MUTATION_MIGRATION_CHECKSUM) {
      conflicts.push("Legacy project mutation migration identity or checksum is invalid.");
    }
  }
  if (!rows.some((row) => Number(row.version) === LEGACY_PROJECT_MUTATION_SCHEMA_VERSION)) {
    errors.push(`Legacy project mutation migration ${LEGACY_PROJECT_MUTATION_SCHEMA_VERSION} is missing.`);
  }
}

function inspectReceiptRows(db, conflicts) {
  const rows = db.prepare(`select * from ${RECEIPT_TABLE} order by operation_id`).all();
  for (const row of rows) {
    try {
      const result = JSON.parse(String(row.result_json));
      if (stableStringify(result) !== row.result_json || stableJsonHash(result) !== row.result_hash) throw new Error("result hash");
      const body = {
        operationId: row.operation_id,
        method: row.method,
        requestHash: row.request_hash,
        commandHash: row.command_hash,
        projectId: row.project_id,
        beforeHash: row.before_hash,
        snapshotHash: row.snapshot_hash,
        resultJson: row.result_json,
        resultHash: row.result_hash,
        appliedAt: row.applied_at
      };
      if (stableJsonHash(body) !== row.receipt_hash) throw new Error("receipt hash");
    } catch {
      conflicts.push(`Legacy project mutation receipt hash verification failed: ${String(row.operation_id)}`);
    }
  }
}

function readInstalledVersions(db) {
  if (!tableExists(db, "schema_migrations")) return [];
  try {
    return db
      .prepare("select version from schema_migrations order by version")
      .all()
      .map((row) => Number(row.version));
  } catch {
    return [];
  }
}

function missingInspection(dbPath) {
  return {
    path: dbPath,
    ready: false,
    currentVersion: 0,
    installedVersions: [],
    expectedVersions: [LEGACY_PROJECT_MUTATION_SCHEMA_VERSION],
    errors: ["Legacy project mutation database is missing."],
    conflicts: []
  };
}

function normalizedSqlHash(value) {
  return sha256Hex(
    String(value ?? "")
      .trim()
      .replace(/\s+/g, " ")
      .toLowerCase()
  );
}

function tableExists(db, name) {
  return Boolean(db.prepare("select 1 from sqlite_master where type='table' and name=?").get(name));
}
