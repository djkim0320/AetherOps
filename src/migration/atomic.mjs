import { existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { writeJsonFile } from "./files.mjs";

export function replaceDirectoryAtomically(stagingRoot, targetRoot, attemptId) {
  const displacedRoot = join(dirname(targetRoot), "replaced", attemptId);
  let displaced = false;
  if (existsSync(targetRoot)) {
    mkdirSync(dirname(displacedRoot), { recursive: true });
    renameSync(targetRoot, displacedRoot);
    displaced = true;
  }
  try {
    renameSync(stagingRoot, targetRoot);
  } catch (error) {
    if (displaced && !existsSync(targetRoot)) {
      renameSync(displacedRoot, targetRoot);
    }
    throw error;
  }
  return { displacedRoot: displaced ? displacedRoot : undefined };
}

export function restoreDisplacedDirectory(targetRoot, displacedRoot, failedRoot) {
  if (existsSync(targetRoot)) renameSync(targetRoot, failedRoot);
  if (displacedRoot && existsSync(displacedRoot)) renameSync(displacedRoot, targetRoot);
}

export function writeJsonFileAtomic(path, value, attemptId) {
  const temporaryPath = `${path}.${attemptId}.tmp`;
  const previousPath = `${path}.${attemptId}.previous`;
  const result = writeJsonFile(temporaryPath, value);
  let displaced = false;
  try {
    if (existsSync(path)) {
      renameSync(path, previousPath);
      displaced = true;
    }
    renameSync(temporaryPath, path);
  } catch (error) {
    rmSync(temporaryPath, { force: true });
    if (displaced && !existsSync(path)) renameSync(previousPath, path);
    throw error;
  }
  if (displaced) rmSync(previousPath, { force: true });
  return { ...result, path };
}
