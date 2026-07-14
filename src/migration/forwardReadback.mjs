import { DatabaseSync } from "node:sqlite";
import { stableJsonHash, stableStringify } from "./hash.mjs";
import { isVirtualOrShadowTable, normalizeRowForHash, quoteIdentifier } from "./sqlite.mjs";
import { migratedJobPolicyDisposition } from "./v2JobPolicySanitizer.mjs";

export function buildForwardReadbackBaseline(dbPath, options = {}) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const tables = readPreservedTables(db).map((table) => {
      const columns = readColumns(db, table.name);
      const rows = readProjectedRows(db, table.name, columns).map((row) =>
        table.name === "jobs" ? migratedJobPolicyDisposition(row, { interruptActive: options.normalizeLegacyActiveJobs }).row : row
      );
      return { name: table.name, columns, rowCount: rows.length, canonicalHash: canonicalRowsHash(rows) };
    });
    return { version: 1, tables, hash: stableJsonHash(tables) };
  } finally {
    db.close();
  }
}

export function verifyForwardReadbackBaseline(dbPath, baseline) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  const errors = [];
  const preservedTables = [];
  try {
    for (const expected of baseline.tables ?? []) {
      if (!tableExists(db, expected.name)) {
        errors.push(`Upgraded SQLite table is missing: ${expected.name}`);
        continue;
      }
      const actualColumns = new Set(readColumns(db, expected.name));
      const missingColumns = expected.columns.filter((column) => !actualColumns.has(column));
      if (missingColumns.length) {
        errors.push(`Upgraded SQLite columns changed: ${expected.name}.${missingColumns.join(",")}`);
        continue;
      }
      const rows = readProjectedRows(db, expected.name, expected.columns);
      const canonicalHash = canonicalRowsHash(rows);
      if (rows.length !== expected.rowCount || canonicalHash !== expected.canonicalHash) {
        errors.push(`Upgraded SQLite canonical row data changed: ${expected.name}`);
        continue;
      }
      preservedTables.push({ name: expected.name, rowCount: expected.rowCount, canonicalHash });
    }
    return { ok: errors.length === 0, errors, preservedTables, hash: stableJsonHash(preservedTables) };
  } finally {
    db.close();
  }
}

function readPreservedTables(db) {
  return db
    .prepare("select name,sql from sqlite_master where type='table' and name not like 'sqlite_%' order by name")
    .all()
    .filter((table) => table.name !== "schema_migrations" && !isVirtualOrShadowTable(String(table.name), table.sql));
}

function readColumns(db, table) {
  return db
    .prepare(`pragma table_info(${quoteIdentifier(table)})`)
    .all()
    .map((column) => String(column.name));
}

function readProjectedRows(db, table, columns) {
  if (!columns.length) return [];
  const projection = columns.map(quoteIdentifier).join(",");
  return db.prepare(`select ${projection} from ${quoteIdentifier(table)}`).all();
}

function canonicalRowsHash(rows) {
  const canonical = rows.map((row) => stableStringify(normalizeRowForHash(row))).sort((left, right) => left.localeCompare(right));
  return stableJsonHash(canonical);
}

function tableExists(db, name) {
  return Boolean(db.prepare("select 1 from sqlite_master where type='table' and name=?").get(name));
}
