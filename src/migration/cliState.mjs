import { existsSync, readFileSync, rmSync } from "node:fs";
import { join, normalize, resolve } from "node:path";
import { statfsSync } from "node:fs";
import { collectFileEntries, copyFileEntries } from "./files.mjs";
import { readSettingsSnapshot } from "./settings.mjs";
import { inspectSqliteFile } from "./sqlite.mjs";
import { normalizeForStableJson, sha256Hex, stableJsonHash } from "./hash.mjs";

export function discoverSourceState(dataRoot) {
  const root = normalize(resolve(dataRoot));
  const settingsPath = join(root, "settings.json");
  const settings = readSettingsSnapshot(settingsPath);
  const entries = collectFileEntries(root, { skipRelativePrefixes: ["migration"] });
  const databaseEntries = [];
  const fileEntries = [];
  const errors = [];

  for (const entry of entries) {
    if (entry.relativePath.toLowerCase().endsWith(".sqlite")) {
      try {
        const dbPath = join(root, entry.relativePath);
        const report = inspectSqliteFile(dbPath);
        databaseEntries.push({
          ...report,
          relativePath: entry.relativePath
        });
        if (!isIntegrityOk(report.integrityCheck)) errors.push(`SQLite integrity_check failed: ${entry.relativePath}`);
        if (report.foreignKeyViolations?.length) errors.push(`SQLite foreign_key_check failed: ${entry.relativePath}`);
      } catch (error) {
        errors.push(error instanceof Error ? error.message : String(error));
      }
      continue;
    }
    fileEntries.push(entry);
  }

  const artifactEntries = [
    ...fileEntries,
    ...databaseEntries.map((entry) => ({
      relativePath: entry.relativePath,
      size: entry.size,
      rawSha256: entry.rawSha256,
      semanticType: "sqlite",
      semanticSha256: entry.schemaFingerprint,
      semanticSummary: {
        schemaFingerprint: entry.schemaFingerprint,
        quickCheck: entry.quickCheck,
        integrityCheck: entry.integrityCheck,
        foreignKeyViolations: entry.foreignKeyViolations,
        tables: entry.tables,
        rowIdHash: entry.rowIdHash,
        canonicalJsonHash: entry.canonicalJsonHash,
        semanticReadbackHash: entry.semanticReadback?.hash
      }
    }))
  ];

  return {
    root,
    settings,
    files: fileEntries,
    databases: databaseEntries,
    artifacts: artifactEntries,
    sourceHash: stableJsonHash({
      settings,
      files: fileEntries,
      databases: databaseEntries
    }),
    totalBytes: artifactEntries.reduce((sum, entry) => sum + Number(entry.size ?? 0), 0),
    errors
  };
}

function isIntegrityOk(rows) {
  return Array.isArray(rows) && rows.length === 1 && Object.values(rows[0] ?? {}).some((value) => String(value).toLowerCase() === "ok");
}

export function buildBackupManifest(source, backupEntries, backupRoot) {
  const artifacts = normalizeForStableJson(backupEntries);
  return {
    kind: "backup",
    version: 2,
    sourceRoot: source.root,
    backupRoot,
    createdAt: new Date().toISOString(),
    sourceHash: source.sourceHash,
    settings: source.settings,
    files: source.files,
    databases: source.databases,
    artifacts,
    backupHash: stableJsonHash(artifacts)
  };
}

export function copySnapshotEntries(source, backupRoot, sourceRoot) {
  copyFileEntries(source.artifacts, sourceRoot, backupRoot);
  return source.artifacts.map((entry) => ({ ...entry }));
}

export function buildTargetManifest(source, backupManifest, targetDbSummary, settingsArchive, targetFiles, stagingRoot, metadata) {
  return {
    kind: "target",
    version: 2,
    sourceRoot: source.root,
    backupRoot: metadata.backupRoot,
    targetRoot: metadata.targetRoot,
    stagingRoot,
    targetDbPath: metadata.targetDbPath,
    createdAt: new Date().toISOString(),
    attemptId: metadata.attemptId,
    sourceHash: source.sourceHash,
    backupHash: backupManifest.backupHash,
    settingsArchive,
    targetFiles,
    runtimePolicy: {
      mutableSqlite: [
        { relativePath: "storage.sqlite", role: "durable-job-storage", required: true },
        { relativePath: "legacy-research.sqlite", role: "legacy-research-storage", required: false },
        { relativePath: "main/main.sqlite", role: "main-memory-storage", required: false },
        { relativePath: "main/vector.sqlite", role: "vector-storage", required: false },
        { relativePath: "main/ontology.sqlite", role: "ontology-storage", required: false }
      ],
      mutableFilePrefixes: ["main/files/sources/", "main/files/artifacts/", "main/files/logs/"]
    },
    targetDbSummary,
    targetSchemaFingerprint: targetDbSummary.targetSchemaFingerprint,
    schemaFingerprint: targetDbSummary.schemaFingerprint,
    manifestHash: stableJsonHash({
      sourceHash: source.sourceHash,
      backupHash: backupManifest.backupHash,
      settingsArchive,
      targetFiles,
      runtimePolicyVersion: 1,
      targetDbSummary
    })
  };
}

export function buildSettingsArchive(settingsSnapshot) {
  if (!settingsSnapshot?.present) {
    return {
      present: false
    };
  }
  return {
    present: true,
    path: settingsSnapshot.path,
    rawSha256: settingsSnapshot.rawSha256,
    semanticSha256: settingsSnapshot.semanticSha256,
    updatedAt: settingsSnapshot.updatedAt,
    ciphertexts: settingsSnapshot.ciphertexts,
    settings: settingsSnapshot.settings,
    codexMigration: settingsSnapshot.codexMigration
  };
}

export function inspectTargetState(targetRoot) {
  const manifestPath = join(targetRoot, "manifest.json");
  const targetDbPath = join(targetRoot, "storage.sqlite");
  const manifest = readJsonIfExists(manifestPath);
  const db = inspectSqlitePath(targetDbPath);
  return {
    root: targetRoot,
    manifestPath,
    manifest,
    db,
    rawSha256: existsSync(manifestPath) ? sha256Hex(readFileSync(manifestPath)) : undefined,
    schemaFingerprint: db?.schemaFingerprint,
    present: Boolean(manifest && db?.present)
  };
}

export function compareTargetAgainstPointer(pointer, target) {
  if (!pointer || !target?.present || !target.manifest || !target.db?.present) return false;
  if (pointer.targetManifestSha256 && target.rawSha256 && pointer.targetManifestSha256 !== target.rawSha256) {
    return false;
  }
  if (
    target.manifest.targetDbSummary?.targetSchemaFingerprint &&
    target.db.schemaFingerprint &&
    target.manifest.targetDbSummary.targetSchemaFingerprint !== target.db.schemaFingerprint
  ) {
    return false;
  }
  return true;
}

export function readCurrentPointer(migrationRoot) {
  return readJsonIfExists(join(migrationRoot, "current.json"));
}

function readJsonIfExists(path) {
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
}

export function inspectSqlitePath(path) {
  if (!existsSync(path)) return { present: false };
  const report = inspectSqliteFile(path);
  return report;
}

export function estimateRequiredBytes(source) {
  const doubled = source.totalBytes * 2;
  const overhead = 64 * 1024 * 1024;
  return doubled + overhead;
}

export function getAvailableBytes(path) {
  const existing = resolveExistingAncestor(path);
  const stats = statfsSync(existing);
  return Number(stats.bavail) * Number(stats.bsize);
}

function resolveExistingAncestor(path) {
  let current = resolve(path);
  while (!existsSync(current)) {
    const next = normalize(join(current, ".."));
    if (next === current) break;
    current = next;
  }
  return current;
}

export function cleanupPath(path) {
  rmSync(path, { recursive: true, force: true });
}

export function buildWarnings(source, availableBytes, requiredBytes, current, activeTarget) {
  const warnings = [];
  if (availableBytes < requiredBytes) {
    warnings.push(`free space low: required ${requiredBytes}, available ${availableBytes}`);
  }
  if (source.errors.length) {
    warnings.push(...source.errors);
  }
  if (current && current.status === "applied" && activeTarget && !activeTarget.present) {
    warnings.push("current migration pointer exists but target state is missing");
  }
  return warnings;
}
