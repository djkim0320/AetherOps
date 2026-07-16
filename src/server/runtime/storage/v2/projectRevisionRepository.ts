import { DatabaseSync } from "node:sqlite";
import { isDeepStrictEqual } from "node:util";
import type { StorageJobEvent, StorageJobEventInput } from "./types.js";
import { json, requiredEvent, rowToEvent, runAtomically, type Row } from "./repositorySupport.js";
import { storageCanonicalHasher } from "./runStatePayloadValidator.js";
import { StorageRevisionConflictError } from "./runStateErrors.js";
import { ProjectMutationReservationConflictError } from "./projectMutationTypes.js";

interface NewMutationState {
  kind: "new";
  projectId: string;
  revision: number;
  events: StorageJobEvent[];
}

interface ReplayMutationState {
  kind: "replay";
  projectId: string;
  revision: number;
  receiptId: string;
}

type MutationState = NewMutationState | ReplayMutationState;

export interface StorageProjectRevisionHead {
  projectId: string;
  revision: number;
  lastReceiptId?: string;
  updatedAt: string;
}

export class ProjectRevisionRepository {
  readonly enabled: boolean;
  private scope: Map<string, MutationState> | undefined;

  constructor(private readonly db: DatabaseSync) {
    const hasProjects = tableExists(db, "projects_v2");
    const tables = ["project_revision_heads", "project_revision_receipts", "project_revision_event_links"];
    const installed = tables.filter((name) => tableExists(db, name));
    if (!hasProjects) {
      this.enabled = false;
      return;
    }
    if (installed.length !== tables.length) {
      throw new Error("Storage project revision schema is not ready for an operational database.");
    }
    this.enabled = true;
  }

  beginMutationScope(): void {
    if (!this.enabled) return;
    if (!this.db.isTransaction) throw new Error("A project revision mutation scope requires an active SQLite transaction.");
    if (this.scope) throw new Error("A project revision mutation scope is already active.");
    this.scope = new Map();
  }

  finalizeMutationScope(): void {
    if (!this.enabled) return;
    const scope = this.requiredScope();
    try {
      for (const state of scope.values()) if (state.kind === "new") this.finalizeNewMutation(state);
    } finally {
      this.scope = undefined;
    }
  }

  abortMutationScope(): void {
    this.scope = undefined;
  }

  current(projectId: string): StorageProjectRevisionHead | undefined {
    if (!this.enabled) throw new Error("Project revision storage is unavailable.");
    if (!this.db.prepare("select 1 from projects_v2 where id=?").get(projectId)) return undefined;
    const row = this.db.prepare("select project_id,revision,last_receipt_id,updated_at from project_revision_heads where project_id=?").get(projectId) as
      { project_id?: unknown; revision?: unknown; last_receipt_id?: unknown; updated_at?: unknown } | undefined;
    if (!row || !Number.isSafeInteger(row.revision) || Number(row.revision) < 0 || typeof row.updated_at !== "string") {
      throw new Error(`Project revision head is unavailable: ${projectId}.`);
    }
    const revision = Number(row.revision);
    if (revision === 0) {
      if (row.last_receipt_id !== null) throw new Error(`Project revision zero head has an unexpected receipt: ${projectId}.`);
      return { projectId, revision, updatedAt: row.updated_at };
    }
    if (typeof row.last_receipt_id !== "string") throw new Error(`Project revision receipt is unavailable: ${projectId}:${revision}.`);
    const receipt = this.db.prepare("select project_id,revision from project_revision_receipts where id=?").get(row.last_receipt_id) as
      { project_id?: unknown; revision?: unknown } | undefined;
    if (receipt?.project_id !== projectId || Number(receipt.revision) !== revision) {
      throw new Error(`Project revision receipt does not match its head: ${projectId}:${revision}.`);
    }
    return { projectId, revision, lastReceiptId: row.last_receipt_id, updatedAt: row.updated_at };
  }

  assertCurrent(projectId: string, expectedRevision: number): StorageProjectRevisionHead {
    const head = this.current(projectId);
    const actualRevision = head?.revision ?? null;
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0 || actualRevision !== expectedRevision) {
      throw new StorageRevisionConflictError(Number.isSafeInteger(expectedRevision) ? expectedRevision : null, actualRevision);
    }
    return head as StorageProjectRevisionHead;
  }

  allocate(projectId: string): number {
    if (!this.enabled) throw new Error("Project revision storage is unavailable.");
    return this.revisionForNewEvent(projectId);
  }

  appendEvent(input: StorageJobEventInput, eventId: string, createdAt: string): StorageJobEvent {
    if (!this.enabled) throw new Error("Project revision storage is unavailable.");
    if (this.scope) return this.appendInScope(input, eventId, createdAt);
    return runAtomically(this.db, () => {
      this.beginMutationScope();
      try {
        const event = this.appendInScope(input, eventId, createdAt);
        this.finalizeMutationScope();
        return event;
      } catch (error) {
        this.abortMutationScope();
        throw error;
      }
    });
  }

  private appendInScope(input: StorageJobEventInput, eventId: string, createdAt: string): StorageJobEvent {
    const existingRow = this.db.prepare("select * from job_events where event_id=?").get(eventId) as Row | undefined;
    if (existingRow) return this.recordReplay(rowToEvent(existingRow), input);
    const revision = this.revisionForNewEvent(input.projectId);
    const payload = bindStorageRevision(input.type, input.payload, revision);
    this.db
      .prepare("insert into job_events (event_id,project_id,job_id,type,created_at,payload) values (?,?,?,?,?,?)")
      .run(eventId, input.projectId, input.jobId ?? null, input.type, createdAt, json(payload));
    const storedRow = this.db.prepare("select * from job_events where event_id=?").get(eventId) as Row | undefined;
    const stored = requiredEvent(storedRow ? rowToEvent(storedRow) : undefined, eventId);
    const state = this.requiredScope().get(input.projectId);
    if (!state || state.kind !== "new" || state.revision !== revision) throw new Error("Project revision mutation scope lost its allocated revision.");
    state.events.push(stored);
    return stored;
  }

  private revisionForNewEvent(projectId: string): number {
    this.assertNoPreparedProjectMutation(projectId);
    const scope = this.requiredScope();
    const existing = scope.get(projectId);
    if (existing?.kind === "replay") throw new Error("An exact replay transaction cannot append a new project event.");
    if (existing) return existing.revision;
    const head = this.db.prepare("select revision from project_revision_heads where project_id=?").get(projectId) as { revision?: unknown } | undefined;
    if (!head || !Number.isSafeInteger(head.revision) || Number(head.revision) < 0) {
      throw new Error(`Project revision head is unavailable: ${projectId}.`);
    }
    const revision = Number(head.revision) + 1;
    scope.set(projectId, { kind: "new", projectId, revision, events: [] });
    return revision;
  }

  private assertNoPreparedProjectMutation(projectId: string): void {
    if (!tableExists(this.db, "project_mutation_journal")) return;
    const reserved = this.db
      .prepare("select 1 from project_mutation_journal where project_id=? and state in ('prepared','legacy_applied') limit 1")
      .get(projectId);
    if (reserved) throw new ProjectMutationReservationConflictError();
  }

  private recordReplay(stored: StorageJobEvent, input: StorageJobEventInput): StorageJobEvent {
    if (
      stored.projectId !== input.projectId ||
      stored.jobId !== input.jobId ||
      stored.type !== input.type ||
      !isDeepStrictEqual(stripStorageRevision(stored.type, stored.payload), stripStorageRevision(input.type, input.payload))
    ) {
      throw new Error(`Durable event id conflict: ${stored.eventId}.`);
    }
    const link = this.db.prepare("select receipt_id,revision from project_revision_event_links where event_id=?").get(stored.eventId) as
      { receipt_id?: unknown; revision?: unknown } | undefined;
    const revision = projectRevision(stored.payload);
    if (!link || typeof link.receipt_id !== "string" || Number(link.revision) !== revision) {
      throw new Error(`Durable event revision receipt is unavailable: ${stored.eventId}.`);
    }
    const scope = this.requiredScope();
    const existing = scope.get(stored.projectId);
    if (existing?.kind === "new") throw new Error("A project mutation cannot mix new events with exact replays.");
    if (existing && (existing.revision !== revision || existing.receiptId !== link.receipt_id)) {
      throw new Error("An exact replay transaction spans more than one project mutation receipt.");
    }
    scope.set(stored.projectId, { kind: "replay", projectId: stored.projectId, revision, receiptId: link.receipt_id });
    return stored;
  }

  private finalizeNewMutation(state: NewMutationState): void {
    if (!state.events.length) throw new Error(`Project revision ${state.projectId}:${state.revision} has no committed events.`);
    const events = [...state.events].sort((left, right) => compareOrdinal(left.eventId, right.eventId));
    const mutation = {
      projectId: state.projectId,
      revision: state.revision,
      events: events.map((event) => ({ eventId: event.eventId, jobId: event.jobId ?? null, type: event.type, payload: event.payload }))
    };
    const mutationHash = storageCanonicalHasher.sha256Canonical(mutation);
    const receiptId = `project-revision-receipt:${mutationHash}`;
    const mutationId = `project-revision-mutation:${mutationHash}`;
    const anchor = events[0] as StorageJobEvent;
    const committedAt = events
      .map((event) => event.createdAt)
      .sort()
      .at(-1) as string;
    this.db
      .prepare(
        `insert into project_revision_receipts
        (id,schema_version,project_id,revision,mutation_id,mutation_hash,anchor_event_id,reason,committed_at)
        values (?,1,?,?,?,?,?,?,?)`
      )
      .run(
        receiptId,
        state.projectId,
        state.revision,
        mutationId,
        mutationHash,
        anchor.eventId,
        events.length === 1 ? anchor.type : "atomic_event_batch",
        committedAt
      );
    const link = this.db.prepare("insert into project_revision_event_links (event_id,receipt_id,project_id,revision,linked_at) values (?,?,?,?,?)");
    for (const event of events) link.run(event.eventId, receiptId, state.projectId, state.revision, event.createdAt);
    const updated = this.db
      .prepare("update project_revision_heads set revision=?,last_receipt_id=?,updated_at=? where project_id=? and revision=?")
      .run(state.revision, receiptId, committedAt, state.projectId, state.revision - 1);
    if (Number(updated.changes) !== 1) throw new Error(`Project revision head changed concurrently: ${state.projectId}.`);
  }

  private requiredScope(): Map<string, MutationState> {
    if (!this.scope) throw new Error("Project revision mutation scope is not active.");
    return this.scope;
  }
}

function bindStorageRevision(type: string, value: unknown, revision: number): Record<string, unknown> {
  const payload = plainRecord(value ?? {});
  const snapshotChange =
    payload.snapshotChange === null || payload.snapshotChange === undefined ? payload.snapshotChange : bindSnapshotVersion(payload.snapshotChange, revision);
  const bound = {
    ...payload,
    projectRevision: revision,
    ...(payload.snapshotChange !== undefined ? { snapshotChange } : {})
  };
  if (type !== "project.snapshot.changed") return bound;
  const data = plainRecord(payload.data);
  return { ...bound, data: { ...data, snapshotVersion: revision } };
}

function stripStorageRevision(type: string, value: unknown): Record<string, unknown> {
  const payload = plainRecord(value ?? {});
  const rest = { ...payload };
  delete rest.projectRevision;
  const withoutSnapshotChange =
    rest.snapshotChange && typeof rest.snapshotChange === "object" && !Array.isArray(rest.snapshotChange)
      ? { ...rest, snapshotChange: stripSnapshotVersion(rest.snapshotChange) }
      : rest;
  if (type !== "project.snapshot.changed") return withoutSnapshotChange;
  const data = plainRecord(withoutSnapshotChange.data);
  const dataRest = { ...data };
  delete dataRest.snapshotVersion;
  return { ...withoutSnapshotChange, data: dataRest };
}

function bindSnapshotVersion(value: unknown, revision: number): Record<string, unknown> {
  return { ...plainRecord(value), snapshotVersion: revision };
}

function stripSnapshotVersion(value: unknown): Record<string, unknown> {
  const rest = { ...plainRecord(value) };
  delete rest.snapshotVersion;
  return rest;
}

function projectRevision(value: unknown): number {
  const revision = plainRecord(value).projectRevision;
  if (!Number.isSafeInteger(revision) || Number(revision) < 1) throw new Error("Durable event has an invalid storage-owned project revision.");
  return Number(revision);
}

function plainRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("A durable project event payload must be a JSON object.");
  return value as Record<string, unknown>;
}

function tableExists(db: DatabaseSync, name: string): boolean {
  return Boolean(db.prepare("select 1 from sqlite_master where type='table' and name=?").get(name));
}

function compareOrdinal(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
