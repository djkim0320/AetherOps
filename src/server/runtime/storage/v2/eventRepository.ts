import { DatabaseSync } from "node:sqlite";
import { isDeepStrictEqual } from "node:util";
import type { StorageJobEvent, StorageJobEventInput } from "./types.js";
import { createStorageId, json, normalizeLimit, nowIso, parseLastEventId, requiredEvent, rowToEvent, type Row } from "./repositorySupport.js";
import { ProjectRevisionRepository } from "./projectRevisionRepository.js";

export class EventRepository {
  constructor(
    private readonly db: DatabaseSync,
    private readonly projectRevisions = new ProjectRevisionRepository(db)
  ) {}
  append(input: StorageJobEventInput): StorageJobEvent {
    const eventId = input.eventId ?? createStorageId("event");
    const createdAt = input.createdAt ?? nowIso();
    if (this.projectRevisions.enabled) return this.projectRevisions.appendEvent(input, eventId, createdAt);
    this.db
      .prepare("insert into job_events (event_id, project_id, job_id, type, created_at, payload) values (?, ?, ?, ?, ?, ?) on conflict(event_id) do nothing")
      .run(eventId, input.projectId, input.jobId ?? null, input.type, createdAt, json(input.payload ?? null));
    const row = this.db.prepare("select * from job_events where event_id = ?").get(eventId) as Row | undefined;
    const stored = requiredEvent(row ? rowToEvent(row) : undefined, eventId);
    if (
      stored.projectId !== input.projectId ||
      stored.jobId !== input.jobId ||
      stored.type !== input.type ||
      !isDeepStrictEqual(stored.payload, input.payload ?? null)
    ) {
      throw new Error(`Durable event id conflict: ${eventId}.`);
    }
    return stored;
  }

  get(eventId: string): StorageJobEvent | undefined {
    const row = this.db.prepare("select * from job_events where event_id=?").get(eventId) as Row | undefined;
    return row ? rowToEvent(row) : undefined;
  }
  after(projectId: string, lastEventId?: string | number, limit = 100): StorageJobEvent[] {
    return (
      this.db
        .prepare("select * from job_events where project_id = ? and sequence > ? order by sequence limit ?")
        .all(projectId, parseLastEventId(lastEventId), normalizeLimit(limit)) as Row[]
    ).map(rowToEvent);
  }
}
