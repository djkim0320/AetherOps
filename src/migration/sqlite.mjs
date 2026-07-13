import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { normalizeForStableJson, semanticTextHash, sha256Hex, stableJsonHash, stableStringify } from "./hash.mjs";

const v2SchemaSourceUrl = new URL("../server/runtime/storage/v2/schema.ts", import.meta.url);
const traceSchemaSourceUrl = new URL("../server/runtime/storage/v2/traceSchema.ts", import.meta.url);
const jobSchemaSourceUrl = new URL("../server/runtime/storage/v2/jobSchema.ts", import.meta.url);
const canonicalEntityTables = new Set([
  "projects_v2",
  "records_v2",
  "memory_items_v2",
  "ontology_entities_v2",
  "ontology_relations_v2",
  "ontology_constraints_v2"
]);

export function checkpointSqliteFile(dbPath) {
  if (!existsSync(dbPath)) return { path: dbPath, present: false };
  const db = openDatabase(dbPath);
  try {
    db.exec("pragma wal_checkpoint(truncate)");
    return { path: dbPath, present: true };
  } finally {
    db.close();
  }
}

export function inspectSqliteFile(dbPath) {
  if (!existsSync(dbPath)) {
    return {
      path: dbPath,
      present: false
    };
  }

  const raw = readFileSync(dbPath);
  const db = openReadOnlyDatabase(dbPath);
  try {
    const quickCheck = readPragmaValues(db, "quick_check");
    const integrityCheck = readPragmaValues(db, "integrity_check");
    const foreignKeyViolations = readForeignKeyViolations(db);
    const verification = buildDatabaseVerification(db);
    return {
      path: dbPath,
      present: true,
      size: raw.byteLength,
      rawSha256: sha256Hex(raw),
      schemaFingerprint: verification.schemaFingerprint,
      quickCheck,
      integrityCheck,
      foreignKeyViolations,
      tables: verification.tables,
      rowIdHash: verification.rowIdHash,
      canonicalJsonHash: verification.canonicalJsonHash,
      semanticReadback: verification.semanticReadback
    };
  } finally {
    db.close();
  }
}

export function buildDatabaseVerification(db) {
  const tables = readUserTableSummaries(db);
  const semanticReadback = readSemanticSnapshot(db);
  return {
    schemaFingerprint: sqliteSchemaFingerprint(db),
    tables,
    rowIdHash: stableJsonHash(tables.map(({ name, idSetHash, rowCount }) => ({ name, idSetHash, rowCount }))),
    canonicalJsonHash: stableJsonHash(tables.map(({ name, canonicalJsonHash }) => ({ name, canonicalJsonHash }))),
    semanticReadback,
    semanticReadbackHash: semanticReadback.hash
  };
}

export function sqliteSchemaFingerprint(dbOrPath) {
  const db = typeof dbOrPath === "string" ? openDatabase(dbOrPath) : dbOrPath;
  const shouldClose = typeof dbOrPath === "string";
  try {
    const rows = db.prepare("select type, name, tbl_name, sql from sqlite_master where name not like 'sqlite_%' order by type asc, name asc").all();
    const normalized = rows.map((row) => normalizeForStableJson(row));
    return stableJsonHash(normalized);
  } finally {
    if (shouldClose) {
      db.close();
    }
  }
}

export function buildV2SchemaFingerprint() {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec("pragma foreign_keys = on");
    db.exec("pragma journal_mode = WAL");
    db.exec(loadV2SchemaSql());
    db.exec(loadV2FtsSql());
    return sqliteSchemaFingerprint(db);
  } finally {
    db.close();
  }
}

export function createV2Database(dbPath, metadata = {}) {
  ensureParentDir(dbPath);
  const db = new DatabaseSync(dbPath);
  try {
    db.exec("pragma foreign_keys = on");
    db.exec("pragma journal_mode = WAL");
    db.exec(loadV2SchemaSql());
    db.exec(loadV2FtsSql());
    if (metadata.schemaVersion !== undefined) {
      db.prepare(
        "insert into storage_v2_meta (key, value, updated_at) values (?, ?, datetime('now')) on conflict(key) do update set value = excluded.value, updated_at = excluded.updated_at"
      ).run("schema_version", String(metadata.schemaVersion));
    }
    for (const [key, value] of Object.entries(metadata)) {
      if (key === "schemaVersion") continue;
      db.prepare(
        "insert into storage_v2_meta (key, value, updated_at) values (?, ?, datetime('now')) on conflict(key) do update set value = excluded.value, updated_at = excluded.updated_at"
      ).run(key, typeof value === "string" ? value : stableStringify(value));
    }
    return db;
  } catch (error) {
    db.close();
    rmSync(dbPath, { force: true });
    throw error;
  }
}

export function loadV2SchemaSql() {
  const base = extractTemplateSql(v2SchemaSourceUrl, "export function migrateStorageV2Schema", "${jobStatusCheck}", [
    "'queued'",
    "'running'",
    "'pause_requested'",
    "'paused'",
    "'cancel_requested'",
    "'aborted'",
    "'interrupted'",
    "'blocked'",
    "'failed'",
    "'completed'"
  ]);
  const trace = extractTemplateSql(traceSchemaSourceUrl, "export function migrateStorageTraceV3Schema");
  const jobFencing = extractTemplateSql(jobSchemaSourceUrl, "function installStorageJobV4Objects");
  return `${base}\n${trace}\n${jobFencing}`;
}

export function loadV2FtsSql() {
  return extractTemplateSql(v2SchemaSourceUrl, "function createFtsTables");
}

export function openDatabase(dbPath) {
  ensureParentDir(dbPath);
  return new DatabaseSync(dbPath);
}

export function openReadOnlyDatabase(dbPath) {
  return new DatabaseSync(dbPath, { readOnly: true });
}

export function readPragmaValues(db, pragmaName) {
  try {
    const rows = db.prepare(`pragma ${pragmaName}`).all();
    return rows.map((row) => normalizeForStableJson(row));
  } catch {
    return [];
  }
}

export function readForeignKeyViolations(db) {
  try {
    const rows = db.prepare("pragma foreign_key_check").all();
    return rows.map((row) => normalizeForStableJson(row));
  } catch {
    return [];
  }
}

export function readUserTableSummaries(db) {
  const tables = db.prepare("select name, sql from sqlite_master where type = 'table' and name not like 'sqlite_%' order by name asc").all();
  const summaries = [];
  for (const table of tables) {
    const name = String(table.name);
    if (isVirtualOrShadowTable(name, table.sql)) {
      continue;
    }
    const rows = readTableRows(db, name);
    const rowHash = stableJsonHash(rows);
    const ids = rows.map((row) => row.id ?? row.event_id ?? row.sequence).filter((value) => value !== undefined && value !== null);
    summaries.push({
      name,
      rowCount: rows.length,
      rowHash,
      idCount: ids.length,
      idSetHash: stableJsonHash(ids.map(String).sort((left, right) => left.localeCompare(right))),
      canonicalJsonHash: stableJsonHash(rows),
      semanticHash: rowHash,
      firstRow: rows.at(0),
      lastRow: rows.at(-1)
    });
  }
  return summaries;
}

export function readSemanticSnapshot(db) {
  const tables = db.prepare("select name from sqlite_master where type = 'table' and name not like 'sqlite_%' order by name asc").all();
  const snapshots = [];
  const invalidJson = [];
  const idMismatches = [];
  for (const table of tables) {
    const name = String(table.name);
    if (isVirtualOrShadowTable(name)) continue;
    const columns = db
      .prepare(`pragma table_info(${quoteIdentifier(name)})`)
      .all()
      .map((column) => String(column.name));
    if (!columns.includes("data")) continue;
    const idColumn = columns.includes("id") ? "id" : columns.includes("sequence") ? "sequence" : undefined;
    const select = idColumn ? `${quoteIdentifier(idColumn)} as row_id, data` : "rowid as row_id, data";
    const rows = db.prepare(`select ${select} from ${quoteIdentifier(name)} order by rowid asc`).all();
    const values = [];
    for (const row of rows) {
      if (row.data === null || row.data === undefined) continue;
      const parsed = tryParseJson(String(row.data));
      if (!parsed.ok) {
        invalidJson.push({ table: name, rowId: String(row.row_id) });
        continue;
      }
      if (
        canonicalEntityTables.has(name) &&
        parsed.value &&
        typeof parsed.value === "object" &&
        "id" in parsed.value &&
        String(parsed.value.id) !== String(row.row_id)
      ) {
        idMismatches.push({ table: name, rowId: String(row.row_id), dataId: String(parsed.value.id) });
      }
      values.push({ rowId: String(row.row_id), data: normalizeForStableJson(parsed.value) });
    }
    snapshots.push({ table: name, count: values.length, hash: stableJsonHash(values) });
  }
  return {
    snapshots,
    invalidJson,
    idMismatches,
    hash: stableJsonHash(snapshots)
  };
}

export function readTableRows(db, tableName) {
  const rows = db.prepare(`select * from ${quoteIdentifier(tableName)} order by rowid asc`).all();
  return rows.map((row) => normalizeRowForHash(row));
}

export function normalizeRowForHash(row) {
  const output = {};
  for (const [key, value] of Object.entries(row)) {
    output[key] = normalizeValueForHash(key, value);
  }
  return normalizeForStableJson(output);
}

export function normalizeValueForHash(columnName, value) {
  if (value === null || value === undefined) return null;
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
    return { $type: "blob", base64: Buffer.from(value).toString("base64") };
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (shouldParseJsonText(columnName, trimmed)) {
      const parsed = tryParseJson(trimmed);
      if (parsed.ok) {
        return parsed.value;
      }
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => normalizeValueForHash(columnName, entry));
  }
  if (typeof value === "object") {
    return normalizeForStableJson(value);
  }
  return value;
}

export function isVirtualOrShadowTable(name, sql) {
  const lower = String(name).toLowerCase();
  if (lower.endsWith("_fts") || lower.includes("_fts_")) return true;
  if (typeof sql === "string" && sql.toLowerCase().startsWith("create virtual table")) return true;
  return false;
}

export function shouldParseJsonText(columnName, text) {
  if (!text) return false;
  if (!["data", "payload", "result", "metadata", "request", "response", "project", "settings", "graph", "spec", "plan"].includes(String(columnName))) {
    return false;
  }
  return text.startsWith("{") || text.startsWith("[") || text.startsWith('"');
}

export function tryParseJson(text) {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false };
  }
}

export function ensureParentDir(dbPath) {
  mkdirSync(dirname(resolve(dbPath)), { recursive: true });
}

export function quoteIdentifier(identifier) {
  return `"${String(identifier).replace(/"/g, '""')}"`;
}

export function computeTextHash(text) {
  return semanticTextHash(text);
}

function extractTemplateSql(url, anchor, placeholder, replacements = []) {
  const source = readFileSync(url, "utf8");
  const anchorIndex = source.indexOf(anchor);
  const templateStart = source.indexOf("db.exec(`", anchorIndex);
  const sqlStart = templateStart + "db.exec(`".length;
  const sqlEnd = source.indexOf("`);", sqlStart);
  if (anchorIndex < 0 || templateStart < 0 || sqlEnd < 0) {
    throw new Error(`Could not extract SQLite schema SQL from ${url.pathname ?? String(url)}.`);
  }
  let sql = source.slice(sqlStart, sqlEnd);
  if (placeholder) {
    sql = sql.replace(placeholder, replacements.join(", "));
  }
  return sql;
}
