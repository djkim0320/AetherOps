import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { DurableJobRuntime } from "./durableJobRuntime.js";
import type { DurableRuntimeTimer } from "./durableRuntimeConfig.js";
import type { DurableJobRecord, EnqueueDurableJob } from "./durableJobTypes.js";

export class DurableJobRuntimeTestSupport {
  constructor(
    private readonly runtimeProvider: () => DurableJobRuntime | undefined,
    private readonly rootProvider: () => string | undefined
  ) {}

  async enqueueCurrent(input: Omit<EnqueueDurableJob, "projectRevision">) {
    const runtime = this.runtime();
    return runtime.enqueue({ ...input, projectRevision: await this.ensureProject(input.projectId) });
  }

  async finishCurrent(job: DurableJobRecord): Promise<void> {
    await this.runtime().finish(job.id, await this.currentRevision(job.projectId));
  }

  async ensureProject(projectId: string): Promise<number> {
    const runtime = this.runtime();
    const current = await runtime.getProjectRevision(projectId);
    if (current !== undefined) return current;
    const root = this.root();
    const projectRoot = join(root, projectId);
    mkdirSync(projectRoot, { recursive: true });
    const timestamp = "2026-07-14T00:00:00.000Z";
    await runtime.syncProject({ id: projectId, projectRoot, topic: projectId, status: "active", createdAt: timestamp, updatedAt: timestamp });
    return this.currentRevision(projectId);
  }

  async currentRevision(projectId: string): Promise<number> {
    const revision = await this.runtime().getProjectRevision(projectId);
    if (revision === undefined) throw new Error(`Durable test project revision is unavailable: ${projectId}.`);
    return revision;
  }

  seedProjectProjection(db: DatabaseSync, projectId: string, timestamp: string): void {
    const project = {
      id: projectId,
      projectRoot: join(this.root(), projectId),
      topic: projectId,
      status: "active",
      createdAt: timestamp,
      updatedAt: timestamp
    };
    db.prepare("insert into projects_v2(id,short_id,project_root,topic,status,created_at,updated_at,data) values(?,?,?,?,?,?,?,?)").run(
      project.id,
      project.id,
      project.projectRoot,
      project.topic,
      project.status,
      project.createdAt,
      project.updatedAt,
      JSON.stringify(project)
    );
    db.prepare("insert into project_revision_heads(project_id,revision,last_receipt_id,updated_at) values(?,0,null,?)").run(projectId, timestamp);
  }

  private runtime(): DurableJobRuntime {
    const runtime = this.runtimeProvider();
    if (!runtime) throw new Error("Durable test runtime is unavailable.");
    return runtime;
  }

  private root(): string {
    const root = this.rootProvider();
    if (!root) throw new Error("Durable test root is unavailable.");
    return root;
  }
}

export function timeout(ms: number): Promise<never> {
  return new Promise((_, reject) => setTimeout(() => reject(new Error("Durable job handler timed out.")), ms));
}

export async function waitForCheckpoint(databasePath: string): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const db = new DatabaseSync(databasePath, { readOnly: true });
    const row = db.prepare("select count(*) as count from checkpoints where job_id=?").get("job-recovered") as { count: number };
    db.close();
    if (row.count === 1) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("Completed checkpoint was not committed.");
}

export async function waitUntil(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("Durable runtime condition timed out.");
}

export async function waitUntilAsync(predicate: () => Promise<boolean>): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("Durable async runtime condition timed out.");
}

export function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

export async function flushTurns(count: number): Promise<void> {
  for (let index = 0; index < count; index += 1) await new Promise<void>((resolve) => setImmediate(resolve));
}

export function manualTimer(): DurableRuntimeTimer & { fireDelay(delayMs: number): void; hasDelay(delayMs: number): boolean } {
  const scheduled = new Map<object, { callback: () => void; delayMs: number }>();
  return {
    setTimeout(callback, delayMs) {
      const handle = {} as ReturnType<typeof setTimeout>;
      scheduled.set(handle, { callback, delayMs });
      return handle;
    },
    clearTimeout(handle) {
      scheduled.delete(handle);
    },
    fireDelay(delayMs) {
      const entry = [...scheduled.entries()].find(([, value]) => value.delayMs === delayMs);
      if (!entry) throw new Error(`No ${delayMs}ms timer is pending.`);
      scheduled.delete(entry[0]);
      entry[1].callback();
    },
    hasDelay(delayMs) {
      return [...scheduled.values()].some((entry) => entry.delayMs === delayMs);
    }
  };
}
