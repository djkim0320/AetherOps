import { DatabaseSync } from "node:sqlite";
import type { StorageJobEvent, StorageJobEventInput } from "./types.js";
import { createStorageId, json, normalizeLimit, nowIso, parseLastEventId, requiredEvent, rowToEvent, type Row } from "./repositorySupport.js";

export class EventRepository {
  constructor(private readonly db: DatabaseSync) {}
  append(input: StorageJobEventInput): StorageJobEvent {
    const eventId = input.eventId ?? createStorageId("event");
    this.db
      .prepare("insert into job_events (event_id, project_id, job_id, type, created_at, payload) values (?, ?, ?, ?, ?, ?)")
      .run(eventId, input.projectId, input.jobId ?? null, input.type, input.createdAt ?? nowIso(), json(input.payload ?? null));
    const row = this.db.prepare("select * from job_events where event_id = ?").get(eventId) as Row | undefined;
    return requiredEvent(row ? rowToEvent(row) : undefined, eventId);
  }
  after(projectId: string, lastEventId?: string | number, limit = 100): StorageJobEvent[] {
    return (
      this.db
        .prepare("select * from job_events where project_id = ? and sequence > ? order by sequence limit ?")
        .all(projectId, parseLastEventId(lastEventId), normalizeLimit(limit)) as Row[]
    ).map(rowToEvent);
  }
}
