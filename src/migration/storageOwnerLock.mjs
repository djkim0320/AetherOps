import { randomUUID } from "node:crypto";
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const STORAGE_OWNER_LOCK = ".storage-owner.lock";

export function acquireStorageOwnerLock(migrationRoot, owner = "migration") {
  mkdirSync(migrationRoot, { recursive: true });
  const path = join(migrationRoot, STORAGE_OWNER_LOCK);
  const token = randomUUID();
  const record = { version: 1, pid: process.pid, token, owner, createdAt: new Date().toISOString() };
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const descriptor = openSync(path, "wx", 0o600);
      try {
        writeFileSync(descriptor, `${JSON.stringify(record)}\n`, "utf8");
        fsyncSync(descriptor);
      } finally {
        closeSync(descriptor);
      }
      return () => releaseOwnedLock(path, token);
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      const existing = readLock(path);
      if (existing && isProcessAlive(existing.pid)) {
        throw new Error(`Storage is owned by active ${existing.owner ?? "runtime"} process ${existing.pid}; stop it before migration.`, { cause: error });
      }
      const stalePath = `${path}.stale-${Date.now().toString(36)}-${existing?.pid ?? "unknown"}`;
      try {
        renameSync(path, stalePath);
      } catch (recoveryError) {
        throw new Error("Could not recover a stale storage owner lock.", { cause: recoveryError });
      }
    }
  }
  throw new Error("Could not acquire the storage owner lock.");
}

export function storageOwnerLockPath(migrationRoot) {
  return join(migrationRoot, STORAGE_OWNER_LOCK);
}

function releaseOwnedLock(path, token) {
  const current = readLock(path);
  if (current?.token === token) rmSync(path, { force: true });
}

function readLock(path) {
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
}

function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}
