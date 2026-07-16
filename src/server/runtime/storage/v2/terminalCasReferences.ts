import type { DatabaseSync } from "node:sqlite";
import { requiredNumber, requiredString } from "./repositorySupport.js";
import type { StorageTerminalCasObject, StorageTerminalCasReferenceSource } from "./terminalCasStore.js";

const ALL_REFERENCES_SQL = `
  select cas_locator,cas_hash,byte_length from canonical_terminal_result_attestations
  union
  select cas_locator,artifact_hash as cas_hash,artifact_bytes as byte_length from engineering_result_promotions
  order by cas_locator,cas_hash,byte_length
`;

const REFERENCE_BY_LOCATOR_SQL = `
  select cas_locator,cas_hash,byte_length from canonical_terminal_result_attestations where cas_locator=?
  union
  select cas_locator,artifact_hash as cas_hash,artifact_bytes as byte_length from engineering_result_promotions where cas_locator=?
  order by cas_locator,cas_hash,byte_length
  limit 2
`;

interface TerminalCasReferenceRow {
  cas_locator?: unknown;
  cas_hash?: unknown;
  byte_length?: unknown;
}

/**
 * SQLite owns cross-table de-duplication so startup verification can stream any number of durable
 * references without retaining a process-sized locator set.
 */
export function createStorageTerminalCasReferenceSource(db: DatabaseSync): StorageTerminalCasReferenceSource {
  return {
    *iterate() {
      const rows = db.prepare(ALL_REFERENCES_SQL).iterate() as Iterable<TerminalCasReferenceRow>;
      for (const row of rows) yield terminalCasObject(row);
    },
    find(casLocator) {
      const rows = db.prepare(REFERENCE_BY_LOCATOR_SQL).all(casLocator, casLocator) as TerminalCasReferenceRow[];
      if (!rows.length) return undefined;
      const selected = terminalCasObject(rows[0]!);
      if (rows.length > 1) throw new Error("Canonical terminal CAS locator has conflicting durable receipts.");
      return selected;
    }
  };
}

function terminalCasObject(row: TerminalCasReferenceRow): StorageTerminalCasObject {
  return {
    casLocator: requiredString(row.cas_locator, "terminal CAS locator"),
    casHash: requiredString(row.cas_hash, "terminal CAS hash"),
    byteLength: requiredNumber(row.byte_length, "terminal CAS byte length")
  };
}
