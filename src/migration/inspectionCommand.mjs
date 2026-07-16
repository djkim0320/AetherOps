import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  buildWarnings,
  compareTargetAgainstPointer,
  discoverSourceState,
  estimateRequiredBytes,
  getAvailableBytes,
  inspectTargetState,
  readCurrentPointer
} from "./cliState.mjs";
import { inspectLegacyProjectMutationSchema } from "./legacyProjectMutationSchema.mjs";
import { inspectOperationalSchema } from "./operationalSchema.mjs";
import { inspectProjectMutationCrossDatabase } from "./projectMutationCrossDatabase.mjs";

export function inspectMigration(context) {
  const source = discoverSourceState(context.dataRoot);
  const current = readCurrentPointer(context.migrationRoot);
  const activeTarget = current?.targetRoot ? inspectTargetState(current.targetRoot) : undefined;
  const operationalSchema = current?.targetDbPath && existsSync(current.targetDbPath) ? inspectOperationalSchemaSafe(current.targetDbPath) : undefined;
  const legacyMutationSchema = current?.targetRoot ? inspectLegacyProjectMutationSchema(join(current.targetRoot, "legacy-research.sqlite")) : undefined;
  const projectMutationCrossDatabase = current?.targetRoot
    ? inspectProjectMutationCrossDatabase(current.targetDbPath, join(current.targetRoot, "legacy-research.sqlite"))
    : undefined;
  const requiredBytes = estimateRequiredBytes(source);
  const availableBytes = getAvailableBytes(context.dataRoot);
  const schemaConflicts = [
    ...(operationalSchema?.conflicts ?? []),
    ...(legacyMutationSchema?.conflicts ?? []),
    ...(projectMutationCrossDatabase?.conflicts ?? [])
  ];
  const verified = Boolean(
    current &&
    activeTarget &&
    current.status === "applied" &&
    compareTargetAgainstPointer(current, activeTarget) &&
    operationalSchema?.ready &&
    legacyMutationSchema?.ready &&
    projectMutationCrossDatabase?.ready
  );
  const ready = source.errors.length === 0 && availableBytes >= requiredBytes;
  const ok = source.errors.length === 0 && schemaConflicts.length === 0;
  return {
    ok,
    command: "check",
    dataRoot: context.dataRoot,
    migrationRoot: context.migrationRoot,
    status: verified ? "applied" : ready && !schemaConflicts.length ? "needs-apply" : "needs-attention",
    verified,
    source,
    current,
    activeTarget,
    operationalSchema,
    legacyMutationSchema,
    projectMutationCrossDatabase,
    freeSpaceBytes: availableBytes,
    requiredSpaceBytes: requiredBytes,
    exitCode: ok ? 0 : 1,
    warnings: [
      ...buildWarnings(source, availableBytes, requiredBytes, current, activeTarget),
      ...(operationalSchema && !operationalSchema.ready ? [...operationalSchema.errors, ...operationalSchema.conflicts] : []),
      ...(legacyMutationSchema && !legacyMutationSchema.ready ? [...legacyMutationSchema.errors, ...legacyMutationSchema.conflicts] : []),
      ...(projectMutationCrossDatabase && !projectMutationCrossDatabase.ready
        ? [...projectMutationCrossDatabase.errors, ...projectMutationCrossDatabase.conflicts]
        : [])
    ]
  };
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
