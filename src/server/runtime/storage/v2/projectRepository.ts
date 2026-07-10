import { DatabaseSync } from "node:sqlite";
import type { Row } from "./repositorySupport.js";
import type { StorageProjectPayload } from "./types.js";
import { json, optionalString, parseJson, recordOf, requiredString, shortProjectId } from "./repositorySupport.js";

export class ProjectRepository {
  constructor(private readonly db: DatabaseSync) {}

  upsert(project: StorageProjectPayload): void {
    const data = recordOf(project);
    const id = requiredString(data.id, "project.id");
    const projectRoot = requiredString(data.projectRoot, "project.projectRoot");
    const topic = requiredString(data.topic, "project.topic");
    const status = requiredString(data.status, "project.status");
    const createdAt = requiredString(data.createdAt, "project.createdAt");
    const updatedAt = requiredString(data.updatedAt, "project.updatedAt");
    const currentStep = optionalString(data.currentStep);
    const shortId = optionalString(data.shortId) ?? shortProjectId(id);

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
      `
      )
      .run(id, shortId, projectRoot, topic, status, currentStep ?? null, createdAt, updatedAt, json(project));
  }

  get(projectId: string): StorageProjectPayload | undefined {
    const row = this.db.prepare("select data from projects_v2 where id = ?").get(projectId) as Row | undefined;
    return row ? parseJson<StorageProjectPayload>(row.data) : undefined;
  }

  list(): StorageProjectPayload[] {
    const rows = this.db.prepare("select data from projects_v2 order by updated_at desc").all() as Row[];
    return rows.map((row) => parseJson<StorageProjectPayload>(row.data));
  }
}
