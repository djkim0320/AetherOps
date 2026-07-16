import { IdempotencyConflictError } from "./jobErrors.js";
import { commitProjectSnapshot } from "./projectSnapshotAtomic.js";
import { PROJECT_MUTATION_RESERVATION_CONFLICT_CODE, ProjectMutationReservationConflictError } from "./projectMutationTypes.js";
import type {
  StorageProjectMutationFinalizeInput,
  StorageProjectMutationFinalizeResult,
  StorageProjectMutationJournal,
  StorageProjectMutationMarkLegacyAppliedInput,
  StorageProjectMutationMarkResult,
  StorageProjectMutationPrepareInput,
  StorageProjectMutationPrepareResult
} from "./projectMutationTypes.js";
import type { StorageV2RepositorySet } from "./repositories.js";
import { recordOf, requiredString } from "./repositorySupport.js";
import { StorageRevisionConflictError } from "./runStateErrors.js";
import { storageCanonicalHasher, storageCanonicalJson } from "./runStatePayloadValidator.js";
import type { StorageJsonObject } from "./types.js";

const MAX_COMMAND_BYTES = 32 * 1024;
const MAX_PUBLIC_RESULT_BYTES = 128 * 1024;
const PROHIBITED_KEY_FRAGMENT = /(?:authorization|cookie|password|passwd|secret|token|api_?key|oauth|credential|cipher|private_?key)/i;

export function prepareProjectMutation(repositories: StorageV2RepositorySet, input: StorageProjectMutationPrepareInput): StorageProjectMutationPrepareResult {
  const normalized = normalizePrepare(input);
  const existing = repositories.projectMutations.lookup(normalized, normalized.requestHash);
  if (existing) {
    if (!matchesPrepared(existing, normalized)) throw new IdempotencyConflictError();
    return { journal: existing, exactReplay: true };
  }
  const reservation = repositories.projectMutations.activeReservation(normalized.projectId);
  if (reservation) throw new ProjectMutationReservationConflictError();
  if (repositories.projectMutations.hasQueuedOrActiveJob(normalized.projectId)) throw new ProjectMutationReservationConflictError();
  assertExpectedBase(repositories, normalized);
  return {
    journal: repositories.projectMutations.insertPrepared({
      ...normalized,
      operationId: operationId(normalized.method, normalized.requestId),
      commandJson: normalized.commandJson,
      commandHash: normalized.commandHash
    }),
    exactReplay: false
  };
}

export function markProjectMutationLegacyApplied(
  repositories: StorageV2RepositorySet,
  input: StorageProjectMutationMarkLegacyAppliedInput
): StorageProjectMutationMarkResult {
  const operationId = boundedId(input.operationId, "operationId", 160);
  const receiptHash = sha256(input.legacyReceiptHash, "legacyReceiptHash");
  const snapshotHash = sha256(input.snapshotHash, "snapshotHash");
  const appliedAt = timestamp(input.appliedAt, "appliedAt");
  const existing = requiredJournal(repositories, operationId);
  if (existing.state !== "prepared") {
    if (
      (existing.state === "legacy_applied" || existing.state === "finalized") &&
      existing.legacyReceiptHash === receiptHash &&
      existing.legacySnapshotHash === snapshotHash &&
      existing.legacyAppliedAt === appliedAt
    )
      return { journal: existing, exactReplay: true };
    throw new IdempotencyConflictError();
  }
  return { journal: repositories.projectMutations.markLegacyApplied(operationId, receiptHash, snapshotHash, appliedAt), exactReplay: false };
}

export function finalizeProjectMutation(
  repositories: StorageV2RepositorySet,
  input: StorageProjectMutationFinalizeInput
): StorageProjectMutationFinalizeResult {
  const normalized = normalizeFinalize(input);
  const journal = requiredJournal(repositories, normalized.operationId);
  if (journal.projectId !== normalized.projectId || journal.legacySnapshotHash !== normalized.snapshotHash) throw new IdempotencyConflictError();
  const finalizeRequestHash = storageCanonicalHasher.sha256Canonical({
    operationId: normalized.operationId,
    project: normalized.project,
    eventId: normalized.eventId,
    snapshotHash: normalized.snapshotHash,
    occurredAt: normalized.occurredAt,
    publicResult: normalized.publicResult,
    publicResultHash: normalized.publicResultHash
  });
  if (journal.state === "finalized") return finalizedReplay(repositories, journal, normalized, finalizeRequestHash);
  if (journal.state !== "legacy_applied" || journal.finalizeRequestHash) throw new IdempotencyConflictError();
  repositories.projectMutations.beginFinalize(normalized.operationId, finalizeRequestHash, normalized.occurredAt);
  const committed = commitProjectSnapshot(repositories, {
    project: normalized.project,
    expectedProjectRevision: journal.expectedProjectRevision,
    eventId: normalized.eventId,
    snapshotHash: normalized.snapshotHash,
    occurredAt: normalized.occurredAt,
    reason: "project_updated"
  });
  const finalized = repositories.projectMutations.completeFinalize(
    normalized.operationId,
    committed.event.eventId,
    committed.projectRevision,
    normalized.publicResultJson,
    normalized.publicResultHash,
    normalized.occurredAt
  );
  return {
    journal: finalized,
    event: committed.event,
    projectRevision: committed.projectRevision,
    projectionHash: committed.projectionHash,
    publicResult: normalized.publicResult,
    publicResultHash: normalized.publicResultHash,
    exactReplay: false
  };
}

function finalizedReplay(
  repositories: StorageV2RepositorySet,
  journal: StorageProjectMutationJournal,
  input: NormalizedFinalize,
  finalizeRequestHash: string
): StorageProjectMutationFinalizeResult {
  if (
    journal.finalizeRequestHash !== finalizeRequestHash ||
    journal.publicResultHash !== input.publicResultHash ||
    journal.publicResultJson !== input.publicResultJson ||
    !journal.eventId ||
    !journal.committedProjectRevision
  )
    throw new IdempotencyConflictError();
  const event = repositories.events.get(journal.eventId);
  if (!event) throw new Error("Finalized project mutation event is unavailable.");
  return {
    journal,
    event,
    projectRevision: journal.committedProjectRevision,
    projectionHash: storageCanonicalHasher.sha256Canonical(input.project),
    publicResult: input.publicResult,
    publicResultHash: input.publicResultHash,
    exactReplay: true
  };
}

interface NormalizedPrepare extends StorageProjectMutationPrepareInput {
  commandJson: string;
  commandHash: string;
}

function normalizePrepare(input: StorageProjectMutationPrepareInput): NormalizedPrepare {
  const method = input.method;
  if (!(["projects.create", "projects.update", "sessions.create", "sessions.delete"] as const).includes(method)) {
    throw new Error("A supported project mutation method is required.");
  }
  const requestId = boundedId(input.requestId, "requestId", 128);
  const requestHash = sha256(input.requestHash, "requestHash");
  const projectId = boundedId(input.projectId, "projectId", 256);
  if (!Number.isSafeInteger(input.expectedProjectRevision) || input.expectedProjectRevision < 0) {
    throw new Error("A non-negative expected project revision is required.");
  }
  const command = boundedSanitizedObject(input.command, MAX_COMMAND_BYTES, "command");
  const commandJson = storageCanonicalJson(command);
  return {
    ...input,
    method,
    requestId,
    requestHash,
    projectId,
    command,
    commandJson,
    commandHash: storageCanonicalHasher.sha256Text(commandJson),
    legacyBeforeHash: sha256(input.legacyBeforeHash, "legacyBeforeHash"),
    preparedAt: timestamp(input.preparedAt, "preparedAt")
  };
}

interface NormalizedFinalize extends StorageProjectMutationFinalizeInput {
  projectId: string;
  publicResult: StorageJsonObject;
  publicResultJson: string;
}

function normalizeFinalize(input: StorageProjectMutationFinalizeInput): NormalizedFinalize {
  const operationId = boundedId(input.operationId, "operationId", 160);
  const projectId = boundedId(requiredString(recordOf(input.project).id, "project.id"), "projectId", 256);
  const eventId = boundedId(input.eventId, "eventId", 256);
  const snapshotHash = sha256(input.snapshotHash, "snapshotHash");
  const occurredAt = timestamp(input.occurredAt, "occurredAt");
  const publicResult = boundedSanitizedObject(input.publicResult, MAX_PUBLIC_RESULT_BYTES, "publicResult");
  const publicResultJson = storageCanonicalJson(publicResult);
  const publicResultHash = sha256(input.publicResultHash, "publicResultHash");
  if (storageCanonicalHasher.sha256Text(publicResultJson) !== publicResultHash) throw new Error("The public result hash does not match its canonical JSON.");
  return { ...input, operationId, projectId, eventId, snapshotHash, occurredAt, publicResult, publicResultJson, publicResultHash };
}

function assertExpectedBase(repositories: StorageV2RepositorySet, input: NormalizedPrepare): void {
  const head = repositories.projectRevisions.current(input.projectId);
  if (input.method === "projects.create") {
    if (input.expectedProjectRevision !== 0 || head) throw new StorageRevisionConflictError(input.expectedProjectRevision, head?.revision ?? null);
    return;
  }
  repositories.projectRevisions.assertCurrent(input.projectId, input.expectedProjectRevision);
}

function matchesPrepared(stored: StorageProjectMutationJournal, input: NormalizedPrepare): boolean {
  return (
    stored.projectId === input.projectId &&
    stored.expectedProjectRevision === input.expectedProjectRevision &&
    stored.commandHash === input.commandHash &&
    stored.commandJson === input.commandJson &&
    stored.legacyBeforeHash === input.legacyBeforeHash
  );
}

function operationId(method: string, requestId: string): string {
  return `project-mutation:${storageCanonicalHasher.sha256Canonical({ method, requestId })}`;
}

function requiredJournal(repositories: StorageV2RepositorySet, operationId: string): StorageProjectMutationJournal {
  const value = repositories.projectMutations.get(operationId);
  if (!value) throw new Error("Project mutation journal entry was not found.");
  return value;
}

function boundedSanitizedObject(value: unknown, maximumBytes: number, label: string): StorageJsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`A ${label} object is required.`);
  inspectSanitizedValue(value, 0);
  const canonicalJson = storageCanonicalJson(value);
  if (Buffer.byteLength(canonicalJson, "utf8") > maximumBytes) throw new Error(`The ${label} exceeds its durable size limit.`);
  const cloned = JSON.parse(canonicalJson) as StorageJsonObject;
  return cloned;
}

function inspectSanitizedValue(value: unknown, depth: number): void {
  if (depth > 12) throw new Error("Project mutation JSON nesting is too deep.");
  if (value === null || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Project mutation JSON contains a non-finite number.");
    return;
  }
  if (typeof value === "string") {
    if (value.length > 16_384 || value.includes("\0")) throw new Error("Project mutation JSON contains an invalid string.");
    return;
  }
  if (Array.isArray(value)) {
    if (value.length > 1_024) throw new Error("Project mutation JSON contains an oversized array.");
    assertDenseDataArray(value);
    for (const entry of value) inspectSanitizedValue(entry, depth + 1);
    return;
  }
  if (!value || typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new Error("Project mutation JSON must contain only plain JSON values.");
  }
  if (Object.getOwnPropertySymbols(value).length) throw new Error("Project mutation JSON must contain only string-keyed JSON values.");
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Object.keys(descriptors);
  if (keys.length > 512) throw new Error("Project mutation JSON contains too many fields.");
  for (const key of keys) {
    const descriptor = descriptors[key];
    if (!descriptor?.enumerable || !("value" in descriptor)) throw new Error("Project mutation JSON must contain only plain data properties.");
    if (!key || key.length > 128 || prohibitedKey(key)) throw new Error("Project mutation JSON contains a prohibited field.");
    inspectSanitizedValue(descriptor.value, depth + 1);
  }
}

function assertDenseDataArray(value: unknown[]): void {
  if (Object.getOwnPropertySymbols(value).length) throw new Error("Project mutation JSON arrays must contain only indexed JSON values.");
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Object.keys(descriptors).filter((key) => key !== "length");
  if (keys.length !== value.length) throw new Error("Project mutation JSON arrays must be dense and contain no custom fields.");
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (!descriptor?.enumerable || !("value" in descriptor)) {
      throw new Error("Project mutation JSON arrays must contain only plain data entries.");
    }
  }
}

function prohibitedKey(key: string): boolean {
  const normalized = key.replace(/([a-z0-9])([A-Z])/g, "$1_$2").replace(/[^a-zA-Z0-9]+/g, "_");
  return PROHIBITED_KEY_FRAGMENT.test(normalized);
}

function sha256(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) throw new Error(`A ${label} SHA-256 is required.`);
  return value;
}

function boundedId(value: unknown, label: string, maximum: number): string {
  if (typeof value !== "string" || !value.length || value.length > maximum || [...value].some(isControlCharacter)) {
    throw new Error(`A valid ${label} is required.`);
  }
  return value;
}

function isControlCharacter(value: string): boolean {
  const code = value.charCodeAt(0);
  return code < 32 || code === 127;
}

function timestamp(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.length || !Number.isFinite(Date.parse(value))) throw new Error(`A valid ${label} timestamp is required.`);
  return value;
}

export { PROJECT_MUTATION_RESERVATION_CONFLICT_CODE };
