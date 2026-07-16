import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { collectFileEntries } from "./files.mjs";
import { stableJsonHash } from "./hash.mjs";
import { inspectSqliteFile } from "./sqlite.mjs";
import { DatabaseSync } from "node:sqlite";

export function verifyBackupManifest(manifest) {
  const errors = [];
  if (!manifest?.backupRoot || !existsSync(manifest.backupRoot)) {
    return { ok: false, errors: ["Backup root is missing."] };
  }
  const actual = collectFileEntries(manifest.backupRoot);
  compareFileEntries(manifest.artifacts ?? [], actual, errors, "backup");
  for (const expected of manifest.databases ?? []) {
    const database = inspectSqliteFile(join(manifest.backupRoot, expected.relativePath));
    if (!isIntegrityOk(database.integrityCheck)) errors.push(`Backup SQLite integrity_check failed: ${expected.relativePath}`);
    if (database.foreignKeyViolations?.length) errors.push(`Backup SQLite foreign_key_check failed: ${expected.relativePath}`);
    if (database.rowIdHash !== expected.rowIdHash) errors.push(`Backup SQLite row ID-set changed: ${expected.relativePath}`);
    if (database.canonicalJsonHash !== expected.canonicalJsonHash) errors.push(`Backup SQLite canonical JSON changed: ${expected.relativePath}`);
    if (database.semanticReadback?.hash !== expected.semanticReadback?.hash) errors.push(`Backup SQLite semantic readback changed: ${expected.relativePath}`);
  }
  if (stableJsonHash(manifest.artifacts ?? []) !== manifest.backupHash) {
    errors.push("Backup manifest canonical hash does not match backupHash.");
  }
  return { ok: errors.length === 0, errors, actual };
}

export function verifyTargetManifest(targetRoot, manifest, options = {}) {
  const errors = [];
  const baselineChanges = [];
  const runtimePolicy = readRuntimePolicy(manifest);
  const dbPath = join(targetRoot, "storage.sqlite");
  const db = inspectSqliteFile(dbPath);
  if (!isIntegrityOk(db.integrityCheck)) errors.push("Target SQLite integrity_check did not return ok.");
  if (db.foreignKeyViolations?.length) errors.push("Target SQLite has foreign-key violations.");
  if (db.semanticReadback?.invalidJson?.length) errors.push("Target SQLite semantic readback found invalid JSON.");
  if (db.semanticReadback?.idMismatches?.length) errors.push("Target SQLite semantic readback found row/data ID mismatches.");
  compareDatabaseSummary(manifest?.targetDbSummary?.verification, db, errors, options.allowDatabaseChanges ? baselineChanges : errors);
  const actualFiles = collectFileEntries(targetRoot, { skipRelativePrefixes: ["manifest.json", "manifest.json.sha256"] });
  const mutablePaths = new Set(runtimePolicy.mutableSqlite.map((entry) => canonicalPath(entry.relativePath)));
  compareFileEntries(
    manifest?.targetFiles ?? [],
    actualFiles,
    errors,
    "target",
    mutablePaths,
    baselineChanges,
    (path) => isAllowedRuntimePath(path, runtimePolicy),
    options.allowDatabaseChanges
  );
  const runtimeValidation = validateRuntimeFiles(targetRoot, actualFiles, manifest?.targetFiles ?? [], runtimePolicy);
  errors.push(...runtimeValidation.errors);
  baselineChanges.push(...runtimeValidation.addedFiles);
  if (!options.allowDatabaseChanges && baselineChanges.length) errors.push(...baselineChanges);
  return { ok: errors.length === 0, errors: [...new Set(errors)], baselineChanges: [...new Set(baselineChanges)], db, actualFiles, runtimeValidation };
}

export function verifyManifestDigest(manifestPath, digestPath, expectedDigest, sha256Hex) {
  const errors = [];
  if (!existsSync(manifestPath) || !existsSync(digestPath)) return { ok: false, errors: ["Manifest or digest file is missing."] };
  const actual = sha256Hex(readFileSync(manifestPath));
  const recorded = readFileSync(digestPath, "utf8").trim();
  if (actual !== recorded) errors.push("Manifest digest sidecar does not match manifest bytes.");
  if (expectedDigest && actual !== expectedDigest) errors.push("Manifest digest does not match current pointer.");
  return { ok: errors.length === 0, errors, actual };
}

function compareDatabaseSummary(expected, actual, structuralErrors, dataChanges) {
  if (!expected) {
    structuralErrors.push("Target manifest has no database verification baseline.");
    return;
  }
  if (expected.schemaFingerprint !== actual.schemaFingerprint) structuralErrors.push("Target schema fingerprint changed.");
  if (expected.canonicalJsonHash !== actual.canonicalJsonHash) dataChanges.push("Target canonical JSON hash changed.");
  if (expected.rowIdHash !== actual.rowIdHash) dataChanges.push("Target row ID-set hash changed.");
  if (expected.semanticReadbackHash !== actual.semanticReadback?.hash) dataChanges.push("Target semantic snapshot readback changed.");
  const expectedTables = new Map((expected.tables ?? []).map((table) => [table.name, table]));
  const actualTables = new Map((actual.tables ?? []).map((table) => [table.name, table]));
  if (expectedTables.size !== actualTables.size || [...expectedTables.keys()].some((name) => !actualTables.has(name))) {
    structuralErrors.push("Target table set changed.");
  }
  for (const [name, table] of expectedTables) {
    const found = actualTables.get(name);
    if (
      !found ||
      table.rowCount !== found.rowCount ||
      table.rowHash !== found.rowHash ||
      table.idSetHash !== found.idSetHash ||
      table.canonicalJsonHash !== found.canonicalJsonHash
    ) {
      dataChanges.push(`Target table row hashes changed: ${name}`);
    }
  }
}

function compareFileEntries(
  expected,
  actual,
  errors,
  label,
  mutablePaths = new Set(),
  baselineChanges = errors,
  allowUnrecorded = () => false,
  allowMutableChanges = false
) {
  const expectedMap = new Map(expected.map((entry) => [canonicalPath(entry.relativePath), entry]));
  const actualMap = new Map(actual.map((entry) => [canonicalPath(entry.relativePath), entry]));
  for (const [path, entry] of expectedMap) {
    const found = actualMap.get(path);
    if (!found) errors.push(`${label} file is missing: ${path}`);
    else if (entry.rawSha256 !== found.rawSha256)
      (allowMutableChanges && mutablePaths.has(path) ? baselineChanges : errors).push(`${label} file SHA-256 changed: ${path}`);
  }
  for (const path of actualMap.keys()) {
    if (!expectedMap.has(path) && !allowUnrecorded(path)) errors.push(`${label} contains an unrecorded file: ${path}`);
  }
}

function readRuntimePolicy(manifest) {
  const policy = manifest?.runtimePolicy;
  return {
    mutableSqlite: Array.isArray(policy?.mutableSqlite) ? policy.mutableSqlite : [],
    mutableFilePrefixes: Array.isArray(policy?.mutableFilePrefixes) ? policy.mutableFilePrefixes.map(canonicalPath) : [],
    contentAddressedFiles: Array.isArray(policy?.contentAddressedFiles) ? policy.contentAddressedFiles : []
  };
}

function isAllowedRuntimePath(path, policy) {
  const normalized = canonicalPath(path);
  if (policy.mutableSqlite.some((entry) => canonicalPath(entry.relativePath) === normalized)) return true;
  return policy.mutableFilePrefixes.some((prefix) => normalized.startsWith(prefix));
}

function validateRuntimeFiles(targetRoot, actualFiles, expectedFiles, policy) {
  const errors = [];
  const addedFiles = [];
  const actualPaths = new Set(actualFiles.map((entry) => canonicalPath(entry.relativePath)));
  const databaseReports = [];
  for (const entry of policy.mutableSqlite) {
    const relativePath = canonicalPath(entry.relativePath);
    if (!actualPaths.has(relativePath)) {
      if (entry.required) errors.push(`Required runtime SQLite is missing: ${relativePath}`);
      continue;
    }
    const report = inspectSqliteFile(join(targetRoot, relativePath));
    if (!isIntegrityOk(report.integrityCheck)) errors.push(`Runtime SQLite integrity_check failed: ${relativePath}`);
    if (report.foreignKeyViolations?.length) errors.push(`Runtime SQLite foreign_key_check failed: ${relativePath}`);
    if (report.semanticReadback?.invalidJson?.length) errors.push(`Runtime SQLite semantic readback found invalid JSON: ${relativePath}`);
    if (report.semanticReadback?.idMismatches?.length) errors.push(`Runtime SQLite semantic readback found ID mismatches: ${relativePath}`);
    databaseReports.push({
      relativePath,
      role: entry.role,
      integrityCheck: report.integrityCheck,
      rowIdHash: report.rowIdHash,
      canonicalJsonHash: report.canonicalJsonHash,
      semanticReadbackHash: report.semanticReadback?.hash
    });
  }
  const baselinePaths = new Set(expectedFiles.map((entry) => canonicalPath(entry.relativePath)));
  for (const file of actualFiles) {
    const path = canonicalPath(file.relativePath);
    if (isAllowedRuntimePath(path, policy) && !baselinePaths.has(path)) addedFiles.push(`runtime file present: ${path} (${file.rawSha256})`);
  }
  const contentAddressed = validateContentAddressedFiles(targetRoot, actualFiles, policy.contentAddressedFiles);
  errors.push(...contentAddressed.errors);
  addedFiles.push(...contentAddressed.notices);
  return { ok: errors.length === 0, errors, addedFiles, databaseReports };
}

function validateContentAddressedFiles(targetRoot, actualFiles, definitions) {
  const errors = [];
  const notices = [];
  const actualByPath = new Map(actualFiles.map((entry) => [canonicalPath(entry.relativePath), entry]));
  for (const definition of definitions) {
    const prefix = canonicalPrefix(definition?.prefix);
    const database = safeSqlIdentifier(definition?.database, true);
    if (!prefix || !database || !Array.isArray(definition?.references)) {
      errors.push("Runtime content-addressed storage policy is malformed.");
      continue;
    }
    const files = actualFiles.filter((entry) => canonicalPath(entry.relativePath).startsWith(prefix));
    for (const file of files) {
      const path = canonicalPath(file.relativePath);
      const match = path.slice(prefix.length).match(/^([a-f0-9]{2})\/([a-f0-9]{64})$/);
      if (!match || match[1] !== match[2]?.slice(0, 2) || file.rawSha256 !== match[2]) {
        errors.push(`Runtime content-addressed file identity is invalid: ${path}`);
      }
    }
    const dbPath = join(targetRoot, database);
    if (!existsSync(dbPath)) {
      errors.push(`Runtime content-addressed reference database is missing: ${database}`);
      continue;
    }
    const referenced = new Set();
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      const installedVersions = readInstalledMigrationVersions(db);
      for (const reference of definition.references) {
        const table = safeSqlIdentifier(reference?.table);
        const locatorColumn = safeSqlIdentifier(reference?.locatorColumn);
        const hashColumn = safeSqlIdentifier(reference?.hashColumn);
        const byteLengthColumn = safeSqlIdentifier(reference?.byteLengthColumn);
        const introducedInVersion = Number(reference?.introducedInVersion);
        if (!table || !locatorColumn || !hashColumn || !byteLengthColumn || !Number.isSafeInteger(introducedInVersion) || introducedInVersion < 1) {
          errors.push("Runtime content-addressed reference policy is malformed.");
          continue;
        }
        if (!installedVersions.has(introducedInVersion)) continue;
        if (!db.prepare("select 1 from sqlite_master where type='table' and name=?").get(table)) {
          errors.push(`Runtime content-addressed reference table is missing: ${table}`);
          continue;
        }
        const rows = db.prepare(`select ${locatorColumn} locator,${hashColumn} hash,${byteLengthColumn} byte_length from ${table}`).all();
        for (const row of rows) {
          const locator = canonicalPath(row.locator);
          const hash = String(row.hash ?? "");
          const byteLength = Number(row.byte_length);
          const expectedPath = `${prefix}${hash.slice(0, 2)}/${hash}`;
          if (!/^[a-f0-9]{64}$/.test(hash) || locator !== expectedPath || !Number.isSafeInteger(byteLength) || byteLength < 0) {
            errors.push(`Runtime content-addressed reference is malformed: ${table}`);
            continue;
          }
          const file = actualByPath.get(locator);
          if (!file || file.rawSha256 !== hash || file.size !== byteLength) {
            errors.push(`Runtime content-addressed reference readback failed: ${table}:${locator}`);
            continue;
          }
          referenced.add(locator);
        }
      }
    } finally {
      db.close();
    }
    for (const file of files) {
      const path = canonicalPath(file.relativePath);
      if (!referenced.has(path)) notices.push(`runtime unreferenced CAS object pending bounded cleanup: ${path} (${file.rawSha256})`);
    }
  }
  return { errors, notices };
}

function readInstalledMigrationVersions(db) {
  const hasLedger = db.prepare("select 1 from sqlite_master where type='table' and name='schema_migrations'").get();
  if (!hasLedger) return new Set();
  return new Set(
    db
      .prepare("select version from schema_migrations")
      .all()
      .map((row) => Number(row.version))
  );
}

function canonicalPrefix(value) {
  if (typeof value !== "string" || !value.trim()) return undefined;
  const normalized = canonicalPath(value);
  return normalized.endsWith("/") ? normalized : `${normalized}/`;
}

function safeSqlIdentifier(value, allowDot = false) {
  if (typeof value !== "string") return undefined;
  const pattern = allowDot ? /^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*$/ : /^[A-Za-z_][A-Za-z0-9_]*$/;
  return pattern.test(value) ? value : undefined;
}

function canonicalPath(path) {
  const normalized = String(path).replace(/\\/g, "/").replace(/^\.\//, "");
  return normalized.endsWith("/") ? normalized : normalized;
}

function isIntegrityOk(rows) {
  return Array.isArray(rows) && rows.length === 1 && Object.values(rows[0] ?? {}).some((value) => String(value).toLowerCase() === "ok");
}
