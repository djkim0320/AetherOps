import { randomUUID } from "node:crypto";
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

const STORAGE_OWNER_LOCK = ".storage-owner.lock";

interface StorageOwnerRecord {
  version: 1;
  pid: number;
  token: string;
  owner: string;
  createdAt: string;
}

export function acquireStorageRuntimeOwnerLock(appDbPath: string): () => void {
  const migrationRoot = migrationRootForDatabase(appDbPath);
  if (!migrationRoot) return () => undefined;
  mkdirSync(migrationRoot, { recursive: true });
  const path = join(migrationRoot, STORAGE_OWNER_LOCK);
  const token = randomUUID();
  const record: StorageOwnerRecord = {
    version: 1,
    pid: process.pid,
    token,
    owner: "storage-worker-runtime",
    createdAt: new Date().toISOString()
  };
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
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const existing = readLock(path);
      if (existing && isProcessAlive(existing.pid)) {
        throw new Error(`Storage is owned by active ${existing.owner} process ${existing.pid}.`, { cause: error });
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

function migrationRootForDatabase(path: string): string | undefined {
  if (path === ":memory:") return undefined;
  const targetRoot = dirname(resolve(path));
  const migrationRoot = dirname(targetRoot);
  return basename(targetRoot).toLowerCase() === "v2" && basename(migrationRoot).toLowerCase() === "migration" ? migrationRoot : undefined;
}

function releaseOwnedLock(path: string, token: string): void {
  const current = readLock(path);
  if (current?.token === token) rmSync(path, { force: true });
}

function readLock(path: string): StorageOwnerRecord | undefined {
  if (!existsSync(path)) return undefined;
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as Partial<StorageOwnerRecord>;
    if (value.version !== 1 || !Number.isInteger(value.pid) || typeof value.token !== "string" || typeof value.owner !== "string") return undefined;
    return value as StorageOwnerRecord;
  } catch {
    return undefined;
  }
}

function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}
