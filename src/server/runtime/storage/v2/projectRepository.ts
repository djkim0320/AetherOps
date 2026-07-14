import { DatabaseSync } from "node:sqlite";
import { existsSync, lstatSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { Row } from "./repositorySupport.js";
import type { StorageProjectPayload } from "./types.js";
import { StorageImmutableConflictError } from "./runStateErrors.js";
import { json, optionalString, parseJson, recordOf, requiredString, shortProjectId } from "./repositorySupport.js";

export class ProjectRepository {
  constructor(private readonly db: DatabaseSync) {}

  assertOwnershipIntegrity(maximumProjects = 4_096): void {
    const rows = this.db.prepare("select id,project_root,data from projects_v2 order by id limit ?").all(maximumProjects + 1) as Array<{
      id?: unknown;
      project_root?: unknown;
      data?: unknown;
    }>;
    if (rows.length > maximumProjects) throw new StorageImmutableConflictError();
    const roots: Array<{ id: string; root: string }> = [];
    for (const row of rows) {
      if (typeof row.id !== "string" || typeof row.project_root !== "string" || typeof row.data !== "string") throw new StorageImmutableConflictError();
      const root = canonicalProjectRoot(row.project_root);
      const payload = recordOf(parseJson<unknown>(row.data));
      const payloadId = requiredString(payload.id, "project.id");
      const payloadRoot = requiredString(payload.projectRoot, "project.projectRoot");
      if (payloadId !== row.id || payloadRoot !== row.project_root || canonicalProjectRoot(payloadRoot) !== root) throw new StorageImmutableConflictError();
      if (roots.some((value) => value.id !== row.id && projectRootsOverlap(value.root, root))) throw new StorageImmutableConflictError();
      roots.push({ id: row.id, root });
    }
  }

  upsert(project: StorageProjectPayload): StorageProjectPayload {
    const data = recordOf(project);
    const id = requiredString(data.id, "project.id");
    const projectRoot = requiredString(data.projectRoot, "project.projectRoot");
    const topic = requiredString(data.topic, "project.topic");
    const status = requiredString(data.status, "project.status");
    const createdAt = requiredString(data.createdAt, "project.createdAt");
    const updatedAt = requiredString(data.updatedAt, "project.updatedAt");
    const currentStep = optionalString(data.currentStep);
    const shortId = optionalString(data.shortId) ?? shortProjectId(id);
    const serializedProject = json(project);
    assertBoundedProject(serializedProject, projectRoot);
    this.assertRootOwnership(id, projectRoot);
    this.assertMonotonicProjection(id, updatedAt, serializedProject);

    this.db
      .prepare(
        `
        insert into projects_v2 (id, short_id, project_root, topic, status, current_step, created_at, updated_at, data)
        values (?, ?, ?, ?, ?, ?, ?, ?, ?)
        on conflict(id) do update set
          short_id = excluded.short_id,
          project_root = excluded.project_root,
          topic = excluded.topic,
          status = excluded.status,
          current_step = excluded.current_step,
          updated_at = excluded.updated_at,
          data = excluded.data
        where excluded.updated_at > projects_v2.updated_at
          or (excluded.updated_at = projects_v2.updated_at and excluded.data = projects_v2.data)
      `
      )
      .run(id, shortId, projectRoot, topic, status, currentStep ?? null, createdAt, updatedAt, serializedProject);
    const stored = this.get(id);
    if (!stored || json(stored) !== serializedProject) throw new StorageImmutableConflictError();
    return stored;
  }

  get(projectId: string): StorageProjectPayload | undefined {
    const row = this.db.prepare("select data from projects_v2 where id = ?").get(projectId) as Row | undefined;
    return row ? parseJson<StorageProjectPayload>(row.data) : undefined;
  }

  list(): StorageProjectPayload[] {
    const rows = this.db.prepare("select data from projects_v2 order by updated_at desc").all() as Row[];
    return rows.map((row) => parseJson<StorageProjectPayload>(row.data));
  }

  private assertRootOwnership(projectId: string, projectRoot: string): void {
    const canonicalRoot = canonicalProjectRoot(projectRoot);
    const rows = this.db.prepare("select id,project_root from projects_v2 order by id").all() as Array<{ id?: unknown; project_root?: unknown }>;
    for (const row of rows) {
      if (typeof row.id !== "string" || typeof row.project_root !== "string") throw new StorageImmutableConflictError();
      const storedRoot = canonicalProjectRoot(row.project_root);
      if (row.id === projectId && storedRoot !== canonicalRoot) throw new StorageImmutableConflictError();
      if (row.id !== projectId && projectRootsOverlap(storedRoot, canonicalRoot)) throw new StorageImmutableConflictError();
    }
  }

  private assertMonotonicProjection(projectId: string, updatedAt: string, serializedProject: string): void {
    const incomingTime = Date.parse(updatedAt);
    if (!Number.isFinite(incomingTime)) throw new StorageImmutableConflictError();
    const row = this.db.prepare("select updated_at,data from projects_v2 where id=?").get(projectId) as { updated_at?: unknown; data?: unknown } | undefined;
    if (!row) return;
    if (typeof row.updated_at !== "string" || typeof row.data !== "string") throw new StorageImmutableConflictError();
    const storedTime = Date.parse(row.updated_at);
    if (!Number.isFinite(storedTime) || incomingTime < storedTime || (incomingTime === storedTime && row.data !== serializedProject)) {
      throw new StorageImmutableConflictError();
    }
  }
}

function canonicalProjectRoot(value: string): string {
  const path = resolve(value);
  if (!existsSync(path)) return process.platform === "win32" ? path.toLocaleLowerCase("en-US") : path;
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new StorageImmutableConflictError();
  const real = realpathSync.native(path);
  return process.platform === "win32" ? real.toLocaleLowerCase("en-US") : real;
}

function projectRootsOverlap(left: string, right: string): boolean {
  return isSameOrDescendant(relative(left, right)) || isSameOrDescendant(relative(right, left));
}

function isSameOrDescendant(value: string): boolean {
  return value === "" || (!isAbsolute(value) && value !== ".." && !value.startsWith(`..${sep}`));
}

function assertBoundedProject(serializedProject: string, projectRoot: string): void {
  if (projectRoot.length > 4_096 || projectRoot.includes("\0") || Buffer.byteLength(serializedProject, "utf8") > 1024 * 1024) {
    throw new StorageImmutableConflictError();
  }
}
