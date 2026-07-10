import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export function acquireMigrationLock(migrationRoot, command) {
  const lockPath = join(migrationRoot, ".migration.lock");
  mkdirSync(dirname(lockPath), { recursive: true });
  try {
    mkdirSync(lockPath, { recursive: false });
  } catch (error) {
    const owner = readLockOwner(lockPath);
    if (owner?.pid && !isProcessAlive(owner.pid)) {
      const stalePath = join(migrationRoot, `.migration.lock.stale-${Date.now().toString(36)}-${owner.pid}`);
      try {
        renameLock(lockPath, stalePath);
        mkdirSync(lockPath, { recursive: false });
      } catch (recoveryError) {
        throw new Error(`Could not recover stale migration lock owned by PID ${owner.pid}.`, { cause: recoveryError });
      }
      return createRelease(lockPath, command);
    }
    const detail = owner ? ` Owner: ${JSON.stringify(owner)}.` : "";
    throw new Error(`Migration is already locked.${detail}`, { cause: error });
  }
  return createRelease(lockPath, command);
}

function createRelease(lockPath, command) {
  const owner = {
    command,
    pid: process.pid,
    acquiredAt: new Date().toISOString()
  };
  try {
    writeFileSync(join(lockPath, "owner.json"), `${JSON.stringify(owner, null, 2)}\n`, "utf8");
  } catch (error) {
    rmSync(lockPath, { recursive: true, force: true });
    throw error;
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    rmSync(lockPath, { recursive: true, force: true });
  };
}

function renameLock(source, destination) {
  renameSync(source, destination);
}

function isProcessAlive(pid) {
  try {
    process.kill(Number(pid), 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function readLockOwner(lockPath) {
  try {
    return JSON.parse(readFileSync(join(lockPath, "owner.json"), "utf8"));
  } catch {
    return undefined;
  }
}
