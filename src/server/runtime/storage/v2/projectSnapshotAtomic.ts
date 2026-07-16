import type { StorageV2RepositorySet } from "./repositories.js";
import { json, recordOf, requiredString } from "./repositorySupport.js";
import { storageCanonicalHasher } from "./runStatePayloadValidator.js";
import { StorageOwnershipConflictError, StorageRevisionConflictError } from "./runStateErrors.js";
import type { StorageJobEvent, StorageProjectPayload } from "./types.js";

export type StorageProjectSnapshotReason = "project_updated" | "job_changed" | "resync_required";

export interface StorageProjectSnapshotCommitInput {
  project: StorageProjectPayload;
  expectedProjectRevision: number;
  eventId: string;
  snapshotHash: string;
  occurredAt: string;
  reason: StorageProjectSnapshotReason;
}

export interface StorageProjectSnapshotCommitResult {
  event: StorageJobEvent;
  projectRevision: number;
  projectionHash: string;
  exactReplay: boolean;
}

export function commitProjectSnapshot(repositories: StorageV2RepositorySet, input: StorageProjectSnapshotCommitInput): StorageProjectSnapshotCommitResult {
  const projectId = requiredString(recordOf(input.project).id, "project.id");
  const eventId = requiredString(input.eventId, "project snapshot event id");
  const occurredAt = requiredTimestamp(input.occurredAt);
  const reason = requiredReason(input.reason);
  const snapshotHash = requiredSha256(input.snapshotHash, "project snapshot hash");
  const projectionHash = hashProjection(input.project);
  const eventInput = {
    eventId,
    projectId,
    type: "project.snapshot.changed",
    createdAt: occurredAt,
    payload: {
      projectionHash,
      mutationHash: snapshotHash,
      projectRevision: input.expectedProjectRevision + 1,
      data: { snapshotVersion: input.expectedProjectRevision + 1, reason }
    }
  } as const;

  if (repositories.events.get(eventId)) {
    const event = repositories.events.append(eventInput);
    return { event, projectRevision: committedRevision(event), projectionHash, exactReplay: true };
  }

  const storedProject = repositories.projects.upsert(input.project);
  if (requiredString(recordOf(storedProject).id, "stored project.id") !== projectId) throw new StorageOwnershipConflictError();
  repositories.projectRevisions.assertCurrent(projectId, input.expectedProjectRevision);
  const event = repositories.events.append(eventInput);
  const projectRevision = committedRevision(event);
  if (projectRevision !== input.expectedProjectRevision + 1) {
    throw new StorageRevisionConflictError(input.expectedProjectRevision + 1, projectRevision);
  }
  return { event, projectRevision, projectionHash, exactReplay: false };
}

function requiredSha256(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) throw new Error(`A ${label} is required.`);
  return value;
}

function hashProjection(project: StorageProjectPayload): string {
  return storageCanonicalHasher.sha256Canonical(JSON.parse(json(project)));
}

function committedRevision(event: StorageJobEvent): number {
  const payload = recordOf(event.payload);
  if (!Number.isSafeInteger(payload.projectRevision) || Number(payload.projectRevision) < 1) {
    throw new Error(`Committed project snapshot event has an invalid revision: ${event.eventId}.`);
  }
  return Number(payload.projectRevision);
}

function requiredTimestamp(value: unknown): string {
  if (typeof value !== "string" || !value.length || !Number.isFinite(Date.parse(value))) {
    throw new Error("A project snapshot commit requires a valid occurredAt timestamp.");
  }
  return value;
}

function requiredReason(value: unknown): StorageProjectSnapshotReason {
  if (value !== "project_updated" && value !== "job_changed" && value !== "resync_required") {
    throw new Error("A project snapshot commit requires a supported reason.");
  }
  return value;
}
