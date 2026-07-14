import { existsSync, readFileSync, renameSync } from "node:fs";
import { isAbsolute, join, normalize, relative, resolve } from "node:path";
import { writeJsonFileAtomic } from "./atomic.mjs";
import { cleanupPath } from "./cliState.mjs";
import { sha256Hex } from "./hash.mjs";
import { verifyTargetManifest } from "./verification.mjs";

const JOURNAL_NAME = "forward-upgrade-operation.json";

export function writeForwardUpgradeJournal(context, operation) {
  validateOperation(context, operation);
  writeJsonFileAtomic(journalPath(context), operation, operation.attemptId);
}

export function finishForwardUpgradeJournal(context) {
  cleanupPath(journalPath(context));
}

export function recoverPendingForwardUpgrade(context) {
  const path = journalPath(context);
  const operation = readJson(path);
  if (!operation) return { recovered: false, status: "none" };
  validateOperation(context, operation);
  const targetDigest = manifestDigest(operation.targetRoot);
  const current = readJson(join(context.migrationRoot, "current.json"));

  if (targetDigest === operation.nextCurrent.targetManifestSha256) {
    const manifest = readJson(join(operation.targetRoot, "manifest.json"));
    const verification = manifest ? verifyTargetManifest(operation.targetRoot, manifest) : { ok: false, errors: ["Target manifest is missing."] };
    if (!verification.ok) throw new Error(`Pending forward upgrade target failed recovery verification: ${verification.errors.join("; ")}`);
    if (current?.targetManifestSha256 !== operation.nextCurrent.targetManifestSha256) {
      if (current && current.targetManifestSha256 !== operation.previousCurrent.targetManifestSha256) {
        throw new Error("Pending forward upgrade current pointer is not a recognized predecessor.");
      }
      writeJsonFileAtomic(join(context.migrationRoot, "current.json"), operation.nextCurrent, operation.attemptId);
    }
    cleanupPath(`${join(context.migrationRoot, "current.json")}.${operation.attemptId}.previous`);
    cleanupPath(operation.stagingRoot);
    finishForwardUpgradeJournal(context);
    return { recovered: true, status: "activated", attemptId: operation.attemptId };
  }

  if (targetDigest === operation.previousCurrent.targetManifestSha256) {
    if (current && current.targetManifestSha256 !== operation.previousCurrent.targetManifestSha256) {
      throw new Error("Pending forward upgrade pointer is newer than the restored target.");
    }
    if (!current) writeJsonFileAtomic(join(context.migrationRoot, "current.json"), operation.previousCurrent, operation.attemptId);
    cleanupPath(operation.stagingRoot);
    finishForwardUpgradeJournal(context);
    return { recovered: true, status: "abandoned", attemptId: operation.attemptId };
  }

  if (!existsSync(operation.targetRoot) && existsSync(operation.displacedRoot)) {
    if (current && current.targetManifestSha256 !== operation.previousCurrent.targetManifestSha256) {
      throw new Error("Pending forward upgrade cannot restore an old target beneath a newer pointer.");
    }
    renameSync(operation.displacedRoot, operation.targetRoot);
    if (!current) writeJsonFileAtomic(join(context.migrationRoot, "current.json"), operation.previousCurrent, operation.attemptId);
    cleanupPath(operation.stagingRoot);
    finishForwardUpgradeJournal(context);
    return { recovered: true, status: "restored", attemptId: operation.attemptId };
  }

  throw new Error("Pending forward upgrade cannot be recovered automatically; target state is unrecognized.");
}

export function forwardUpgradeJournalPath(context) {
  return journalPath(context);
}

function validateOperation(context, operation) {
  if (!operation || operation.version !== 1 || typeof operation.attemptId !== "string" || !/^forward-[a-z0-9]+-[a-z0-9]+$/.test(operation.attemptId)) {
    throw new Error("Pending forward upgrade journal is invalid.");
  }
  const migrationRoot = resolve(context.migrationRoot);
  const expectedTarget = resolve(migrationRoot, "v2");
  const expectedStaging = resolve(migrationRoot, "staging", operation.attemptId);
  const expectedDisplaced = resolve(migrationRoot, "replaced", operation.attemptId);
  if (
    !isStrictDescendant(migrationRoot, expectedTarget) ||
    !isStrictDescendant(migrationRoot, expectedStaging) ||
    !isStrictDescendant(migrationRoot, expectedDisplaced) ||
    resolve(operation.targetRoot) !== expectedTarget ||
    resolve(operation.stagingRoot) !== expectedStaging ||
    resolve(operation.displacedRoot) !== expectedDisplaced ||
    resolve(operation.previousCurrent?.targetRoot ?? "") !== expectedTarget ||
    resolve(operation.nextCurrent?.targetRoot ?? "") !== expectedTarget ||
    resolve(operation.previousCurrent?.targetDbPath ?? "") !== join(expectedTarget, "storage.sqlite") ||
    resolve(operation.nextCurrent?.targetDbPath ?? "") !== join(expectedTarget, "storage.sqlite") ||
    typeof operation.previousCurrent?.targetManifestSha256 !== "string" ||
    typeof operation.nextCurrent?.targetManifestSha256 !== "string"
  ) {
    throw new Error("Pending forward upgrade journal paths or pointers are invalid.");
  }
}

function isStrictDescendant(root, candidate) {
  const path = relative(root, candidate);
  return Boolean(path) && !path.startsWith("..") && !isAbsolute(path);
}

function journalPath(context) {
  return join(normalize(context.migrationRoot), JOURNAL_NAME);
}

function manifestDigest(root) {
  const path = join(root, "manifest.json");
  return existsSync(path) ? sha256Hex(readFileSync(path)) : undefined;
}

function readJson(path) {
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new Error(`Invalid migration recovery JSON: ${path}`);
  }
}
