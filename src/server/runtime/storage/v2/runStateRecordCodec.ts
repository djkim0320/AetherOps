import { isDeepStrictEqual } from "node:util";
import { StorageImmutableConflictError, StorageOwnershipConflictError } from "./runStateErrors.js";
import { parseStoredContextPack, parseStoredRunStateRevision, parseStoredTaskContract } from "./runStatePayloadValidator.js";
import type {
  StorageCommitRunStateRevisionInput,
  StorageContextPack,
  StorageRunOwnership,
  StorageRunStateRevision,
  StorageSaveContextPackInput,
  StorageTaskContract,
  StorageTaskContractInput
} from "./runStateTypes.js";
import type { Row } from "./repositorySupport.js";

export function rowToTaskContract(row: Row): StorageTaskContract {
  return {
    id: stringField(row.id, "task_contracts.id"),
    projectId: stringField(row.project_id, "task_contracts.project_id"),
    schemaVersion: numberField(row.schema_version, "task_contracts.schema_version"),
    contentHash: stringField(row.content_hash, "task_contracts.content_hash"),
    createdAt: stringField(row.created_at, "task_contracts.created_at"),
    data: decode(row.data)
  };
}

export function rowToContextPack(row: Row): StorageContextPack {
  return {
    id: stringField(row.id, "context_packs.id"),
    projectId: stringField(row.project_id, "context_packs.project_id"),
    runId: stringField(row.run_id, "context_packs.run_id"),
    jobId: stringField(row.job_id, "context_packs.job_id"),
    schemaVersion: numberField(row.schema_version, "context_packs.schema_version"),
    stateRevision: numberField(row.state_revision, "context_packs.state_revision"),
    taskContractId: stringField(row.task_contract_id, "context_packs.task_contract_id"),
    taskContractHash: stringField(row.task_contract_hash, "context_packs.task_contract_hash"),
    contentHash: stringField(row.content_hash, "context_packs.content_hash"),
    recordedAt: stringField(row.created_at, "context_packs.created_at"),
    data: decode(row.data)
  };
}

export function rowToRevision(row: Row): StorageRunStateRevision {
  const contextPackId = nullableString(row.context_pack_id);
  return {
    id: stringField(row.id, "run_state_revisions.id"),
    projectId: stringField(row.project_id, "run_state_revisions.project_id"),
    runId: stringField(row.run_id, "run_state_revisions.run_id"),
    jobId: stringField(row.job_id, "run_state_revisions.job_id"),
    schemaVersion: numberField(row.schema_version, "run_state_revisions.schema_version"),
    revision: numberField(row.revision, "run_state_revisions.revision"),
    previousRevision: nullableNumber(row.previous_revision),
    parentRevisionHash: nullableString(row.parent_revision_hash),
    stateHash: stringField(row.state_hash, "run_state_revisions.state_hash"),
    taskContractId: stringField(row.task_contract_id, "run_state_revisions.task_contract_id"),
    taskContractHash: stringField(row.task_contract_hash, "run_state_revisions.task_contract_hash"),
    ...(contextPackId ? { contextPackId } : {}),
    recordedAt: stringField(row.created_at, "run_state_revisions.created_at"),
    data: decode(row.data)
  };
}

export function validateTaskContract(input: StorageTaskContractInput): void {
  parseStoredTaskContract(input.data);
  assertCommon(input.id, input.projectId, input.schemaVersion, input.contentHash, input.createdAt);
  assertPayload(input.data, { id: input.id, projectId: input.projectId, schemaVersion: input.schemaVersion, contentHash: input.contentHash });
}

export function validateRevision(input: StorageCommitRunStateRevisionInput): void {
  const revision = input.revision;
  parseStoredRunStateRevision(revision.data);
  assertRunCommon(revision, revision.schemaVersion, revision.stateHash, revision.recordedAt);
  if (!Number.isInteger(revision.revision) || revision.revision < 0) throw new Error("Run-state revision must be a non-negative integer.");
  if (input.expectedRevision !== null && (!Number.isInteger(input.expectedRevision) || input.expectedRevision < 0)) {
    throw new Error("Expected run-state revision must be null or a non-negative integer.");
  }
  if (revision.parentRevisionHash !== null) assertHash(revision.parentRevisionHash);
  assertHash(revision.taskContractHash);
  assertPayload(revision.data, {
    projectId: revision.projectId,
    runId: revision.runId,
    revision: revision.revision,
    schemaVersion: revision.schemaVersion,
    stateHash: revision.stateHash,
    taskContractId: revision.taskContractId,
    taskContractHash: revision.taskContractHash,
    parentRevisionHash: revision.parentRevisionHash
  });
}

export function validateContextPack(input: StorageSaveContextPackInput): void {
  const pack = input.contextPack;
  parseStoredContextPack(pack.data);
  assertRunCommon(pack, pack.schemaVersion, pack.contentHash, pack.recordedAt);
  assertHash(pack.taskContractHash);
  if (!Number.isInteger(pack.stateRevision) || pack.stateRevision < 0) throw new Error("Context-pack state revision must be non-negative.");
  assertPayload(pack.data, {
    id: pack.id,
    projectId: pack.projectId,
    runId: pack.runId,
    schemaVersion: pack.schemaVersion,
    stateRevision: pack.stateRevision,
    createdAt: pack.recordedAt,
    canonicalHash: pack.contentHash
  });
  const data = pack.data as Record<string, unknown>;
  assertPayload(data.task, { id: pack.taskContractId, contentHash: pack.taskContractHash });
  assertPayload(data.runState, { revision: pack.stateRevision });
}

export function assertScope(row: Row, owner: Pick<StorageRunOwnership, "projectId" | "runId">): void {
  if (row.project_id !== owner.projectId || row.run_id !== owner.runId) throw new StorageOwnershipConflictError();
}

export function exactOrConflict<T>(stored: T, input: T): T {
  if (!isDeepStrictEqual(stored, input)) throw new StorageImmutableConflictError();
  return stored;
}

export function encode(value: unknown): string {
  return JSON.stringify(value);
}

export function required<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error("Required storage record is missing.");
  return value;
}

export function stringField(value: unknown, label: string): string {
  if (typeof value !== "string" || !value) throw new Error(`Invalid ${label}.`);
  return value;
}

export function numberField(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`Invalid ${label}.`);
  return value;
}

function assertRunCommon(input: StorageRunOwnership & { id: string }, schemaVersion: number, hash: string, timestamp: string): void {
  assertCommon(input.id, input.projectId, schemaVersion, hash, timestamp);
  if (!input.runId || !input.jobId) throw new Error("Run-state ownership identifiers are required.");
}

function assertCommon(id: string, projectId: string, schemaVersion: number, hash: string, timestamp: string): void {
  if (!id || !projectId) throw new Error("Storage identifiers are required.");
  if (!Number.isInteger(schemaVersion) || schemaVersion < 1) throw new Error("Storage schema version must be positive.");
  assertHash(hash);
  if (!Number.isFinite(Date.parse(timestamp))) throw new Error("Storage timestamp must be ISO-8601 compatible.");
}

function assertPayload(data: unknown, expected: Readonly<Record<string, unknown>>): void {
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("Storage payload must be an object.");
  const record = data as Record<string, unknown>;
  for (const [key, value] of Object.entries(expected)) {
    if (!isDeepStrictEqual(record[key], value)) throw new StorageOwnershipConflictError();
  }
}

function assertHash(value: string): void {
  if (!/^[a-f0-9]{64}$/.test(value)) throw new Error("Storage hash must be a lowercase SHA-256 digest.");
}

function decode(value: unknown): unknown {
  if (typeof value !== "string") throw new Error("Stored JSON payload is invalid.");
  return JSON.parse(value) as unknown;
}

function nullableNumber(value: unknown): number | null {
  return value === null ? null : numberField(value, "nullable number");
}

function nullableString(value: unknown): string | null {
  return value === null ? null : stringField(value, "nullable string");
}
