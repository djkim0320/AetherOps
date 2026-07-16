import type { StorageJobEvent, StorageJsonObject, StorageProjectPayload } from "./types.js";

export const STORAGE_PROJECT_MUTATION_METHODS = ["projects.create", "projects.update", "sessions.create", "sessions.delete"] as const;

export type StorageProjectMutationMethod = (typeof STORAGE_PROJECT_MUTATION_METHODS)[number];
export type StorageProjectMutationState = "prepared" | "legacy_applied" | "finalizing" | "finalized";

export interface StorageProjectMutationIdentity {
  method: StorageProjectMutationMethod;
  requestId: string;
}

export interface StorageProjectMutationPrepareInput extends StorageProjectMutationIdentity {
  requestHash: string;
  projectId: string;
  expectedProjectRevision: number;
  command: StorageJsonObject;
  legacyBeforeHash: string;
  preparedAt: string;
}

export interface StorageProjectMutationJournal extends StorageProjectMutationIdentity {
  operationId: string;
  requestHash: string;
  projectId: string;
  expectedProjectRevision: number;
  commandJson: string;
  commandHash: string;
  legacyBeforeHash: string;
  state: StorageProjectMutationState;
  legacyReceiptHash?: string;
  legacySnapshotHash?: string;
  legacyAppliedAt?: string;
  finalizeRequestHash?: string;
  eventId?: string;
  committedProjectRevision?: number;
  publicResultJson?: string;
  publicResultHash?: string;
  preparedAt: string;
  updatedAt: string;
  finalizedAt?: string;
}

export interface StorageProjectMutationPrepareResult {
  journal: StorageProjectMutationJournal;
  exactReplay: boolean;
}

export interface StorageProjectMutationMarkLegacyAppliedInput {
  operationId: string;
  legacyReceiptHash: string;
  snapshotHash: string;
  appliedAt: string;
}

export interface StorageProjectMutationMarkResult {
  journal: StorageProjectMutationJournal;
  exactReplay: boolean;
}

export interface StorageProjectMutationFinalizeInput {
  operationId: string;
  project: StorageProjectPayload;
  eventId: string;
  snapshotHash: string;
  occurredAt: string;
  publicResult: StorageJsonObject;
  publicResultHash: string;
}

export interface StorageProjectMutationFinalizeResult {
  journal: StorageProjectMutationJournal;
  event: StorageJobEvent;
  projectRevision: number;
  projectionHash: string;
  publicResult: StorageJsonObject;
  publicResultHash: string;
  exactReplay: boolean;
}

export interface StorageProjectMutationPendingPage {
  mutations: StorageProjectMutationJournal[];
  nextCursor?: string;
}

export const PROJECT_MUTATION_RESERVATION_CONFLICT_CODE = "PROJECT_MUTATION_RESERVED" as const;

export class ProjectMutationReservationConflictError extends Error {
  readonly code = PROJECT_MUTATION_RESERVATION_CONFLICT_CODE;

  constructor() {
    super("The project already has a prepared mutation awaiting durable finalization.");
    this.name = "ProjectMutationReservationConflictError";
  }
}
