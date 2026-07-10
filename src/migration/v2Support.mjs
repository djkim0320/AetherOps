import { stableJsonHash, stableStringify } from "./hash.mjs";
import { normalizeRowForHash, quoteIdentifier } from "./sqlite.mjs";

export function summarizeTable(sourceTable, rows, targetTable) {
  return {
    table: targetTable,
    sourceTable,
    copied: rows.length,
    rowHash: stableJsonHash(rows.map((row) => normalizeRowForHash(row)))
  };
}

export function readRows(db, tableName) {
  const exists = db.prepare("select 1 from sqlite_master where type = 'table' and name = ?").get(tableName);
  if (!exists) return [];
  const rows = db.prepare(`select * from ${quoteIdentifier(tableName)} order by rowid asc`).all();
  return rows;
}

export function parseJsonField(value, label) {
  if (typeof value !== "string") {
    throw new Error(`Expected ${label} to be JSON text.`);
  }
  try {
    return JSON.parse(value);
  } catch (error) {
    throw new Error(`Invalid JSON at ${label}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
}

export function normalizeJsonText(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return null;
    try {
      return stableStringify(JSON.parse(trimmed));
    } catch {
      return value;
    }
  }
  return stableStringify(value);
}

export function shortProjectId(id) {
  const compact = String(id)
    .replace(/^project[_-]/, "")
    .replace(/[^a-zA-Z0-9]/g, "");
  return (compact || String(id).replace(/[^a-zA-Z0-9]/g, "")).slice(0, 12);
}

export function boolInt(value) {
  return value ? 1 : 0;
}

export function float32EmbeddingToBlob(vector) {
  const source = vector instanceof Float32Array ? vector : Float32Array.from(vector);
  const buffer = Buffer.allocUnsafe(source.length * Float32Array.BYTES_PER_ELEMENT);
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  for (let index = 0; index < source.length; index += 1) {
    view.setFloat32(index * Float32Array.BYTES_PER_ELEMENT, source[index], true);
  }
  return buffer;
}
