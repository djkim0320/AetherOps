import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { replaceDirectoryAtomically, restoreDisplacedDirectory, writeJsonFileAtomic } from "./atomic.mjs";
import {
  buildBackupManifest,
  buildSettingsArchive,
  buildTargetManifest,
  buildWarnings,
  cleanupPath,
  compareTargetAgainstPointer,
  copySnapshotEntries,
  discoverSourceState,
  estimateRequiredBytes,
  getAvailableBytes,
  inspectTargetState,
  readCurrentPointer
} from "./cliState.mjs";
import { collectFileEntries, writeJsonFile } from "./files.mjs";
import { sha256Hex } from "./hash.mjs";
import { acquireMigrationLock } from "./lock.mjs";
import { checkpointSqliteFile } from "./sqlite.mjs";
import { migrateV1AppDbToV2 } from "./v2.mjs";
import { verifyBackupManifest, verifyManifestDigest, verifyTargetManifest } from "./verification.mjs";
import { migrateCodexSettingsFile } from "./settings.mjs";
import { forwardUpgradeAppliedTarget } from "./forwardUpgrade.mjs";
import { forwardUpgradeJournalPath, recoverPendingForwardUpgrade } from "./forwardUpgradeRecovery.mjs";
import { inspectOperationalSchema } from "./operationalSchema.mjs";
import { acquireStorageOwnerLock } from "./storageOwnerLock.mjs";

export function inspectMigration(context) {
  const source = discoverSourceState(context.dataRoot);
  const current = readCurrentPointer(context.migrationRoot);
  const activeTarget = current?.targetRoot ? inspectTargetState(current.targetRoot) : undefined;
  const operationalSchema = current?.targetDbPath && existsSync(current.targetDbPath) ? inspectOperationalSchemaSafe(current.targetDbPath) : undefined;
  const requiredBytes = estimateRequiredBytes(source);
  const availableBytes = getAvailableBytes(context.dataRoot);
  const verified = Boolean(
    current && activeTarget && current.status === "applied" && compareTargetAgainstPointer(current, activeTarget) && operationalSchema?.ready
  );
  const ready = source.errors.length === 0 && availableBytes >= requiredBytes;
  return {
    ok: source.errors.length === 0,
    command: "check",
    dataRoot: context.dataRoot,
    migrationRoot: context.migrationRoot,
    status: verified ? "applied" : ready ? "needs-apply" : "needs-attention",
    verified,
    source,
    current,
    activeTarget,
    operationalSchema,
    freeSpaceBytes: availableBytes,
    requiredSpaceBytes: requiredBytes,
    exitCode: source.errors.length === 0 ? 0 : 1,
    warnings: [
      ...buildWarnings(source, availableBytes, requiredBytes, current, activeTarget),
      ...(operationalSchema && !operationalSchema.ready ? [...operationalSchema.errors, ...operationalSchema.conflicts] : [])
    ]
  };
}

export function applyMigration(context) {
  const release = acquireMigrationLock(context.migrationRoot, "apply");
  try {
    let releaseStorage;
    try {
      releaseStorage = acquireStorageOwnerLock(context.migrationRoot, "migration-apply");
    } catch (error) {
      return failure("apply", context, `Storage ownership could not be acquired: ${error instanceof Error ? error.message : String(error)}`, "not-ready");
    }
    try {
      return applyWhileLocked(context);
    } finally {
      releaseStorage();
    }
  } finally {
    release();
  }
}

function applyWhileLocked(context) {
  try {
    recoverPendingForwardUpgrade(context);
  } catch (error) {
    return failure(
      "apply",
      context,
      `Pending v2 forward upgrade recovery failed: ${error instanceof Error ? error.message : String(error)}`,
      "repair-required"
    );
  }
  const initial = discoverSourceState(context.dataRoot);
  if (initial.errors.length) return failure("apply", context, initial.errors.join("; "));
  for (const database of initial.databases) checkpointSqliteFile(join(context.dataRoot, database.relativePath));
  const source = discoverSourceState(context.dataRoot);
  if (source.errors.length) return failure("apply", context, source.errors.join("; "));
  const requiredBytes = estimateRequiredBytes(source);
  const availableBytes = getAvailableBytes(context.dataRoot);
  if (availableBytes < requiredBytes)
    return failure("apply", context, `Insufficient free space. Required ${requiredBytes} bytes, available ${availableBytes} bytes.`);

  const current = readCurrentPointer(context.migrationRoot);
  if (current?.status === "applied") {
    const verification = verifyAppliedTarget(current, { allowDatabaseChanges: true });
    if (verification.ok) {
      let schemaUpgrade;
      try {
        schemaUpgrade = forwardUpgradeAppliedTarget(context, current, verification.baselineChanges);
      } catch (error) {
        return failure(
          "apply",
          context,
          `Existing v2 target forward upgrade failed and was not activated: ${error instanceof Error ? error.message : String(error)}`,
          "repair-required"
        );
      }
      const schemaCurrent = schemaUpgrade.current;
      const settingsMigration = migrateCodexSettingsFile(join(context.dataRoot, "settings.json"), join(context.migrationRoot, "codex-settings-journal.json"));
      const nextCurrent = settingsMigration.changed ? { ...schemaCurrent, settingsMigration } : schemaCurrent;
      if (settingsMigration.changed)
        writeJsonFileAtomic(join(context.migrationRoot, "current.json"), nextCurrent, schemaUpgrade.forwardUpgrade?.attemptId ?? current.attemptId);
      const applied = schemaUpgrade.changed || settingsMigration.changed;
      return {
        ok: true,
        command: "apply",
        dataRoot: context.dataRoot,
        migrationRoot: context.migrationRoot,
        status: schemaUpgrade.changed
          ? settingsMigration.changed
            ? "schema-and-settings-upgraded"
            : "schema-upgraded"
          : settingsMigration.changed
            ? "settings-upgraded"
            : "already-applied",
        applied,
        exitCode: 0,
        current: nextCurrent,
        source,
        settingsMigration,
        schemaUpgrade,
        activeTarget: inspectTargetState(schemaCurrent.targetRoot)
      };
    }
    return failure("apply", context, `Existing v2 target failed verification and was not replaced: ${verification.errors.join("; ")}`, "repair-required");
  }

  const attemptId = `attempt-${Date.now().toString(36)}-${process.pid.toString(36)}`;
  const backupRoot = join(context.migrationRoot, "backups", attemptId, "source");
  const backupManifestPath = join(context.migrationRoot, "backups", attemptId, "manifest.json");
  const stagingRoot = join(context.migrationRoot, "staging", attemptId);
  const targetRoot = join(context.migrationRoot, "v2");
  cleanupPath(stagingRoot);
  cleanupPath(backupRoot);
  mkdirSync(backupRoot, { recursive: true });
  mkdirSync(stagingRoot, { recursive: true });

  const backupEntries = copySnapshotEntries(source, backupRoot, context.dataRoot);
  const backupManifest = buildBackupManifest(source, backupEntries, backupRoot);
  const backupWrite = writeJsonFile(backupManifestPath, backupManifest);
  writeFileSync(`${backupManifestPath}.sha256`, `${backupWrite.sha256}\n`, "utf8");
  assertVerified(verifyBackupManifest(backupManifest), "Backup verification failed");

  const targetDbPath = join(stagingRoot, "storage.sqlite");
  const targetDbSummary = migrateV1AppDbToV2(join(context.dataRoot, "aetherops.sqlite"), targetDbPath);
  const legacySource = join(context.dataRoot, "aetherops.sqlite");
  if (existsSync(legacySource)) copyFileSync(legacySource, join(stagingRoot, "legacy-research.sqlite"));
  const settingsArchive = buildSettingsArchive(source.settings);
  writeJsonFile(join(stagingRoot, "settings.archive.json"), settingsArchive);
  const targetFiles = collectFileEntries(stagingRoot);
  const targetManifest = buildTargetManifest(source, backupManifest, targetDbSummary, settingsArchive, targetFiles, stagingRoot, {
    targetRoot,
    targetDbPath: join(targetRoot, "storage.sqlite"),
    backupRoot,
    attemptId
  });
  const manifestPath = join(stagingRoot, "manifest.json");
  const manifestWrite = writeJsonFile(manifestPath, targetManifest);
  writeFileSync(`${manifestPath}.sha256`, `${manifestWrite.sha256}\n`, "utf8");
  assertVerified(verifyManifestDigest(manifestPath, `${manifestPath}.sha256`, manifestWrite.sha256, sha256Hex), "Target manifest digest failed");
  assertVerified(verifyTargetManifest(stagingRoot, targetManifest), "Staged target verification failed");

  const replacement = replaceDirectoryAtomically(stagingRoot, targetRoot, attemptId);
  const currentPointer = buildCurrentPointer(context, attemptId, source, backupManifestPath, backupWrite.sha256, targetRoot, manifestWrite.sha256);
  const postInstall = verifyAppliedTarget(currentPointer);
  if (!postInstall.ok) {
    const failedRoot = join(context.migrationRoot, "failed", attemptId);
    mkdirSync(join(context.migrationRoot, "failed"), { recursive: true });
    restoreDisplacedDirectory(targetRoot, replacement.displacedRoot, failedRoot);
    throw new Error(`Installed target verification failed: ${postInstall.errors.join("; ")}`);
  }
  const settingsMigration = migrateCodexSettingsFile(join(context.dataRoot, "settings.json"), join(context.migrationRoot, "codex-settings-journal.json"));
  const installedPointer = settingsMigration.changed ? { ...currentPointer, settingsMigration } : currentPointer;
  writeJsonFileAtomic(join(context.migrationRoot, "current.json"), installedPointer, attemptId);
  return {
    ok: true,
    command: "apply",
    dataRoot: context.dataRoot,
    migrationRoot: context.migrationRoot,
    status: "applied",
    applied: true,
    exitCode: 0,
    source,
    backupManifest,
    targetManifest,
    current: installedPointer,
    settingsMigration,
    activeTarget: inspectTargetState(targetRoot)
  };
}

export function verifyMigration(context) {
  const source = discoverSourceState(context.dataRoot);
  const current = readCurrentPointer(context.migrationRoot);
  if (!current || current.status !== "applied") return failure("verify", context, "Migration has not been applied.", "not-applied");
  if (existsSync(forwardUpgradeJournalPath(context))) {
    return failure("verify", context, "A pending forward upgrade requires migrate:apply recovery.", "repair-required");
  }
  const verification = verifyAppliedTarget(current, { allowDatabaseChanges: true });
  if (!verification.ok) return { ...failure("verify", context, verification.errors.join("; "), "mismatch"), source, current, verification };
  const operationalSchema = inspectOperationalSchemaSafe(current.targetDbPath);
  if (!operationalSchema.ready) {
    const errors = [...operationalSchema.errors, ...operationalSchema.conflicts];
    return { ...failure("verify", context, errors.join("; "), "mismatch"), source, current, verification, operationalSchema };
  }
  return {
    ok: true,
    command: "verify",
    dataRoot: context.dataRoot,
    migrationRoot: context.migrationRoot,
    status: verification.baselineChanges.length ? "verified-with-v2-changes" : "verified",
    exitCode: 0,
    source,
    current,
    target: inspectTargetState(current.targetRoot),
    verification,
    operationalSchema
  };
}

export function rollbackMigration(context, options = {}) {
  const release = acquireMigrationLock(context.migrationRoot, "rollback");
  try {
    let releaseStorage;
    try {
      releaseStorage = acquireStorageOwnerLock(context.migrationRoot, "migration-rollback");
    } catch (error) {
      return failure("rollback", context, `Storage ownership could not be acquired: ${error instanceof Error ? error.message : String(error)}`, "not-ready");
    }
    try {
      try {
        recoverPendingForwardUpgrade(context);
      } catch (error) {
        return failure(
          "rollback",
          context,
          `Pending v2 forward upgrade recovery failed: ${error instanceof Error ? error.message : String(error)}`,
          "repair-required"
        );
      }
      const current = readCurrentPointer(context.migrationRoot);
      if (!current) return { ok: true, command: "rollback", dataRoot: context.dataRoot, migrationRoot: context.migrationRoot, status: "no-op", exitCode: 0 };
      const verification = verifyAppliedTarget(current);
      if ((!verification.ok || current.rollbackRequiresV2DataLossApproval) && !options.allowV2DataLoss) {
        return failure(
          "rollback",
          context,
          `V2 data differs from the migration baseline; rollback requires --allow-v2-data-loss. ${verification.errors.join("; ")}`,
          "approval-required"
        );
      }
      const settingsPath = join(context.dataRoot, "settings.json");
      if (current.settingsMigration?.changed && existsSync(settingsPath)) {
        const currentSettingsSha = sha256Hex(readFileSync(settingsPath));
        if (currentSettingsSha !== current.settingsMigration.afterSha256 && !options.allowV2DataLoss) {
          return failure("rollback", context, "Codex settings changed after migration; rollback requires --allow-v2-data-loss.", "approval-required");
        }
      }
      const archiveRoot = join(context.migrationRoot, "rollback-archives", `${current.attemptId}-${Date.now().toString(36)}`);
      mkdirSync(join(context.migrationRoot, "rollback-archives"), { recursive: true });
      if (existsSync(current.targetRoot)) renameSync(current.targetRoot, archiveRoot);
      if (current.settingsMigration?.changed) {
        const backupManifest = readJson(current.backupManifestPath);
        const originalSettingsPath = backupManifest?.backupRoot ? join(backupManifest.backupRoot, "settings.json") : undefined;
        if (originalSettingsPath && existsSync(originalSettingsPath)) copyFileSync(originalSettingsPath, settingsPath);
      }
      cleanupPath(join(context.migrationRoot, "current.json"));
      cleanupPath(join(context.migrationRoot, "staging"));
      return {
        ok: true,
        command: "rollback",
        dataRoot: context.dataRoot,
        migrationRoot: context.migrationRoot,
        status: "rolled-back",
        exitCode: 0,
        previous: current,
        archivedTargetRoot: existsSync(archiveRoot) ? archiveRoot : undefined
      };
    } finally {
      releaseStorage();
    }
  } finally {
    release();
  }
}

function verifyAppliedTarget(current, options = {}) {
  const target = inspectTargetState(current.targetRoot);
  const errors = [];
  if (!compareTargetAgainstPointer(current, target)) errors.push("Target does not match current pointer.");
  const manifest = target.manifest;
  if (!manifest) return { ok: false, errors: [...errors, "Target manifest is missing."] };
  errors.push(...verifyManifestDigest(target.manifestPath, `${target.manifestPath}.sha256`, current.targetManifestSha256, sha256Hex).errors);
  const backupManifest = readJson(current.backupManifestPath);
  if (!backupManifest) {
    errors.push("Backup manifest is missing or invalid.");
  } else {
    errors.push(...verifyManifestDigest(current.backupManifestPath, `${current.backupManifestPath}.sha256`, current.backupManifestSha256, sha256Hex).errors);
    errors.push(...verifyBackupManifest(backupManifest).errors);
  }
  const targetVerification = verifyTargetManifest(current.targetRoot, manifest, options);
  errors.push(...targetVerification.errors);
  return { ok: errors.length === 0, errors, baselineChanges: targetVerification.baselineChanges ?? [] };
}

function buildCurrentPointer(context, attemptId, source, backupManifestPath, backupSha, targetRoot, manifestSha) {
  return {
    status: "applied",
    dataRoot: context.dataRoot,
    migrationRoot: context.migrationRoot,
    attemptId,
    sourceHash: source.sourceHash,
    backupManifestPath,
    backupManifestSha256: backupSha,
    targetManifestPath: join(targetRoot, "manifest.json"),
    targetManifestSha256: manifestSha,
    targetRoot,
    targetDbPath: join(targetRoot, "storage.sqlite"),
    appliedAt: new Date().toISOString()
  };
}

function assertVerified(result, prefix) {
  if (!result.ok) throw new Error(`${prefix}: ${result.errors.join("; ")}`);
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
}

function failure(command, context, error, status = "failed") {
  return { ok: false, command, dataRoot: context.dataRoot, migrationRoot: context.migrationRoot, status, exitCode: 1, error };
}

function inspectOperationalSchemaSafe(path) {
  try {
    return inspectOperationalSchema(path);
  } catch (error) {
    return {
      ready: false,
      currentVersion: 0,
      installedVersions: [],
      expectedVersions: [],
      errors: [error instanceof Error ? error.message : String(error)],
      conflicts: []
    };
  }
}
