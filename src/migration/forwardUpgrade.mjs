import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { replaceDirectoryAtomically, restoreDisplacedDirectory, writeJsonFileAtomic } from "./atomic.mjs";
import { cleanupPath } from "./cliState.mjs";
import { collectFileEntries, copyFileEntries, writeJsonFile } from "./files.mjs";
import { buildForwardReadbackBaseline, verifyForwardReadbackBaseline } from "./forwardReadback.mjs";
import { finishForwardUpgradeJournal, writeForwardUpgradeJournal } from "./forwardUpgradeRecovery.mjs";
import { sha256Hex, stableJsonHash } from "./hash.mjs";
import { inspectOperationalSchema, upgradeOperationalSchema } from "./operationalSchema.mjs";
import { checkpointSqliteFile, inspectSqliteFile } from "./sqlite.mjs";
import { verifyManifestDigest, verifyTargetManifest } from "./verification.mjs";

export function forwardUpgradeAppliedTarget(context, current, baselineChanges = []) {
  const schema = inspectOperationalSchema(current.targetDbPath);
  if (schema.conflicts.length) throw new Error(`Existing v2 operational schema is incompatible: ${schema.conflicts.join("; ")}`);
  if (schema.ready) return { changed: false, current, schema };

  checkpointSqliteFile(current.targetDbPath);
  const attemptId = `forward-${Date.now().toString(36)}-${process.pid.toString(36)}`;
  const backupRoot = join(context.migrationRoot, "backups", attemptId, "target-before-upgrade");
  const backupManifestPath = join(context.migrationRoot, "backups", attemptId, "target-manifest.json");
  const stagingRoot = join(context.migrationRoot, "staging", attemptId);
  cleanupPath(backupRoot);
  cleanupPath(stagingRoot);
  mkdirSync(backupRoot, { recursive: true });
  mkdirSync(stagingRoot, { recursive: true });

  const sourceEntries = collectFileEntries(current.targetRoot);
  const beforeDatabase = inspectSqliteFile(current.targetDbPath);
  const readbackBaseline = buildForwardReadbackBaseline(current.targetDbPath, {
    normalizeLegacyActiveJobs: !schema.installedVersions.includes(4)
  });
  copyFileEntries(sourceEntries, current.targetRoot, backupRoot);
  const backup = writeTargetBackup(backupRoot, backupManifestPath, current, sourceEntries, beforeDatabase, attemptId);
  copyFileEntries(sourceEntries, current.targetRoot, stagingRoot);

  const stagedDbPath = join(stagingRoot, "storage.sqlite");
  const databaseUpgrade = upgradeOperationalSchema(stagedDbPath);
  checkpointSqliteFile(stagedDbPath);
  const afterDatabase = inspectSqliteFile(stagedDbPath);
  const preservation = verifyForwardReadbackBaseline(stagedDbPath, readbackBaseline);
  const readback = verifyForwardUpgradeReadback(afterDatabase, preservation);
  if (!readback.ok) throw new Error(`Forward migration readback verification failed: ${readback.errors.join("; ")}`);

  const existingManifest = readJson(join(stagingRoot, "manifest.json"));
  if (!existingManifest) throw new Error("Existing v2 target manifest is missing or invalid.");
  const targetFiles = collectFileEntries(stagingRoot, { skipRelativePrefixes: ["manifest.json", "manifest.json.sha256"] });
  const upgradedAt = new Date().toISOString();
  const forwardUpgrade = {
    attemptId,
    fromVersion: schema.currentVersion,
    toVersion: databaseUpgrade.after.currentVersion,
    appliedVersions: databaseUpgrade.appliedVersions,
    upgradedAt,
    backupManifestPath,
    backupManifestSha256: backup.manifestSha256,
    beforeDatabaseSha256: beforeDatabase.rawSha256,
    afterDatabaseSha256: afterDatabase.rawSha256,
    readbackHash: preservation.hash
  };
  const nextManifest = buildForwardManifest(existingManifest, current, targetFiles, afterDatabase, forwardUpgrade);
  const manifestPath = join(stagingRoot, "manifest.json");
  const manifestWrite = writeJsonFile(manifestPath, nextManifest);
  writeFileSync(`${manifestPath}.sha256`, `${manifestWrite.sha256}\n`, "utf8");
  assertVerified(verifyManifestDigest(manifestPath, `${manifestPath}.sha256`, manifestWrite.sha256, sha256Hex), "Forward target manifest digest failed");
  assertVerified(verifyTargetManifest(stagingRoot, nextManifest), "Forward staged target verification failed");

  const nextCurrent = {
    ...current,
    targetManifestSha256: manifestWrite.sha256,
    schemaUpgradedAt: upgradedAt,
    rollbackRequiresV2DataLossApproval: Boolean(current.rollbackRequiresV2DataLossApproval || baselineChanges.length),
    forwardUpgrade
  };
  assertSourceTargetUnchanged(current, sourceEntries, beforeDatabase);
  const operation = {
    version: 1,
    status: "prepared",
    attemptId,
    targetRoot: current.targetRoot,
    stagingRoot,
    displacedRoot: join(dirname(current.targetRoot), "replaced", attemptId),
    previousCurrent: current,
    nextCurrent,
    createdAt: upgradedAt
  };
  writeForwardUpgradeJournal(context, operation);
  let replacement;
  let activated = false;
  try {
    replacement = replaceDirectoryAtomically(stagingRoot, current.targetRoot, attemptId);
    assertVerified(verifyTargetManifest(current.targetRoot, nextManifest), "Forward installed target verification failed");
    writeJsonFileAtomic(join(context.migrationRoot, "current.json"), nextCurrent, attemptId);
    activated = true;
    finishForwardUpgradeJournal(context);
  } catch (error) {
    if (!activated) {
      const failedRoot = join(context.migrationRoot, "failed", attemptId);
      mkdirSync(join(context.migrationRoot, "failed"), { recursive: true });
      if (replacement) restoreDisplacedDirectory(current.targetRoot, replacement.displacedRoot, failedRoot);
      finishForwardUpgradeJournal(context);
    }
    throw error;
  }
  return { changed: true, current: nextCurrent, schema: databaseUpgrade.after, databaseUpgrade, backup, readback, forwardUpgrade };
}

function assertSourceTargetUnchanged(current, sourceEntries, beforeDatabase) {
  checkpointSqliteFile(current.targetDbPath);
  const actualDatabase = inspectSqliteFile(current.targetDbPath);
  const databaseChanged =
    actualDatabase.schemaFingerprint !== beforeDatabase.schemaFingerprint ||
    actualDatabase.rowIdHash !== beforeDatabase.rowIdHash ||
    actualDatabase.canonicalJsonHash !== beforeDatabase.canonicalJsonHash ||
    actualDatabase.semanticReadback?.hash !== beforeDatabase.semanticReadback?.hash;
  if (databaseChanged) throw new Error("Existing v2 target changed while its forward migration was staged.");
  const withoutDatabase = (entries) => entries.filter((entry) => entry.relativePath.replace(/\\/g, "/") !== "storage.sqlite");
  const fileErrors = compareEntries(withoutDatabase(sourceEntries), withoutDatabase(collectFileEntries(current.targetRoot)));
  if (fileErrors.length) throw new Error(`Existing v2 target files changed while staging: ${fileErrors.join("; ")}`);
}

function writeTargetBackup(backupRoot, manifestPath, current, sourceEntries, sourceDatabase, attemptId) {
  const actualEntries = collectFileEntries(backupRoot);
  const backupDatabase = inspectSqliteFile(join(backupRoot, "storage.sqlite"));
  const errors = compareEntries(sourceEntries, actualEntries);
  if (sourceDatabase.rawSha256 !== backupDatabase.rawSha256) errors.push("Target backup SQLite SHA-256 changed during copy.");
  if (sourceDatabase.rowIdHash !== backupDatabase.rowIdHash) errors.push("Target backup SQLite row ID-set changed during copy.");
  if (sourceDatabase.canonicalJsonHash !== backupDatabase.canonicalJsonHash) errors.push("Target backup SQLite canonical JSON changed during copy.");
  if (sourceDatabase.semanticReadback?.hash !== backupDatabase.semanticReadback?.hash) {
    errors.push("Target backup SQLite semantic readback changed during copy.");
  }
  if (errors.length) throw new Error(`Target backup verification failed: ${errors.join("; ")}`);
  const manifest = {
    kind: "target-forward-upgrade-backup",
    version: 1,
    attemptId,
    sourceTargetRoot: current.targetRoot,
    backupRoot,
    createdAt: new Date().toISOString(),
    files: sourceEntries,
    filesHash: stableJsonHash(sourceEntries),
    database: backupDatabaseSummary(sourceDatabase)
  };
  const write = writeJsonFile(manifestPath, manifest);
  writeFileSync(`${manifestPath}.sha256`, `${write.sha256}\n`, "utf8");
  assertVerified(verifyManifestDigest(manifestPath, `${manifestPath}.sha256`, write.sha256, sha256Hex), "Target backup manifest digest failed");
  return { root: backupRoot, manifestPath, manifestSha256: write.sha256, manifest };
}

function buildForwardManifest(existing, current, targetFiles, database, forwardUpgrade) {
  const targetDbSummary = {
    ...existing.targetDbSummary,
    targetPath: current.targetDbPath,
    targetSchemaFingerprint: database.schemaFingerprint,
    schemaFingerprint: database.schemaFingerprint,
    verification: databaseVerification(database)
  };
  const withoutHash = {
    ...existing,
    targetFiles,
    targetDbSummary,
    targetSchemaFingerprint: database.schemaFingerprint,
    schemaFingerprint: database.schemaFingerprint,
    forwardUpgrades: [...(existing.forwardUpgrades ?? []), forwardUpgrade]
  };
  delete withoutHash.manifestHash;
  return { ...withoutHash, manifestHash: stableJsonHash(withoutHash) };
}

function databaseVerification(database) {
  return {
    schemaFingerprint: database.schemaFingerprint,
    tables: database.tables,
    rowIdHash: database.rowIdHash,
    canonicalJsonHash: database.canonicalJsonHash,
    semanticReadback: database.semanticReadback,
    semanticReadbackHash: database.semanticReadback?.hash
  };
}

function verifyForwardUpgradeReadback(after, preservation) {
  const errors = [...preservation.errors];
  if (!isIntegrityOk(after.integrityCheck)) errors.push("Upgraded SQLite integrity_check did not return ok.");
  if (after.foreignKeyViolations?.length) errors.push("Upgraded SQLite has foreign-key violations.");
  if (after.semanticReadback?.invalidJson?.length) errors.push("Upgraded SQLite semantic readback found invalid JSON.");
  if (after.semanticReadback?.idMismatches?.length) errors.push("Upgraded SQLite semantic readback found row/data ID mismatches.");
  return { ok: errors.length === 0, errors, preservedTables: preservation.preservedTables };
}

function backupDatabaseSummary(database) {
  return {
    path: database.path,
    present: database.present,
    size: database.size,
    rawSha256: database.rawSha256,
    schemaFingerprint: database.schemaFingerprint,
    integrityCheck: database.integrityCheck,
    foreignKeyViolations: database.foreignKeyViolations,
    rowIdHash: database.rowIdHash,
    canonicalJsonHash: database.canonicalJsonHash,
    semanticReadbackHash: database.semanticReadback?.hash
  };
}

function compareEntries(expected, actual) {
  const errors = [];
  const actualMap = new Map(actual.map((entry) => [entry.relativePath, entry]));
  for (const entry of expected) {
    const found = actualMap.get(entry.relativePath);
    if (!found) errors.push(`Target backup file is missing: ${entry.relativePath}`);
    else if (found.rawSha256 !== entry.rawSha256) errors.push(`Target backup file SHA-256 changed: ${entry.relativePath}`);
  }
  if (expected.length !== actual.length) errors.push("Target backup file set changed during copy.");
  return errors;
}

function readJson(path) {
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
}

function assertVerified(result, prefix) {
  if (!result.ok) throw new Error(`${prefix}: ${result.errors.join("; ")}`);
}

function isIntegrityOk(rows) {
  return Array.isArray(rows) && rows.length === 1 && Object.values(rows[0] ?? {}).some((value) => String(value).toLowerCase() === "ok");
}
