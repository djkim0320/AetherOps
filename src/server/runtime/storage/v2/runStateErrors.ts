export const STORAGE_REVISION_CONFLICT_CODE = "REVISION_CONFLICT";
export const STORAGE_OWNERSHIP_CONFLICT_CODE = "OWNERSHIP_CONFLICT";
export const STORAGE_IMMUTABLE_CONFLICT_CODE = "IMMUTABLE_CONFLICT";

export type StorageRunStateErrorCode = typeof STORAGE_REVISION_CONFLICT_CODE | typeof STORAGE_OWNERSHIP_CONFLICT_CODE | typeof STORAGE_IMMUTABLE_CONFLICT_CODE;

export class StorageRevisionConflictError extends Error {
  readonly code = STORAGE_REVISION_CONFLICT_CODE;

  constructor(
    readonly expectedRevision: number | null,
    readonly actualRevision: number | null
  ) {
    super("The persisted run-state revision changed before this transaction committed.");
    this.name = "StorageRevisionConflictError";
  }
}

export class StorageOwnershipConflictError extends Error {
  readonly code = STORAGE_OWNERSHIP_CONFLICT_CODE;

  constructor() {
    super("The persisted project, run, and job ownership does not match.");
    this.name = "StorageOwnershipConflictError";
  }
}

export class StorageImmutableConflictError extends Error {
  readonly code = STORAGE_IMMUTABLE_CONFLICT_CODE;

  constructor() {
    super("An immutable storage identifier already contains different data.");
    this.name = "StorageImmutableConflictError";
  }
}
