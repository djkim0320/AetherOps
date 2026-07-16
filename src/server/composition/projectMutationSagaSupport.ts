import { createHash } from "node:crypto";
import { z } from "zod";
import type { ProjectInput } from "../../contracts/api-v2/projects.js";
import { slugify } from "../../core/orchestration/orchestratorResultHelpers.js";
import { ResearchLoopStep, type ResearchProject } from "../../core/shared/types.js";
import type { LegacyProjectMutationCommand, LegacyProjectMutationMethod, LegacyProjectMutationRequest } from "../runtime/storage/legacyProjectMutationTypes.js";
import type { StorageProjectMutationJournal, StorageProjectMutationMethod } from "../runtime/storage/v2/projectMutationTypes.js";
import type { StorageProjectRevisionHead } from "../runtime/storage/v2/projectRevisionRepository.js";
import type { StorageJsonObject } from "../runtime/storage/v2/types.js";
import { durableJobRequestHash } from "./durableJobRequestHash.js";

export interface NewMutationIdentity {
  operationId: string;
  method: StorageProjectMutationMethod;
  requestId: string;
  requestHash: string;
  preparedAt: string;
}

export interface NewMutation extends NewMutationIdentity {
  projectId: string;
  expectedProjectRevision: number;
  legacyBeforeHash: string | null;
  legacyMethod: LegacyProjectMutationMethod;
  command: LegacyProjectMutationCommand;
}

export function newMutation(
  identity: NewMutationIdentity,
  projectId: string,
  expectedProjectRevision: number,
  legacyBeforeHash: string | null,
  legacyMethod: LegacyProjectMutationMethod,
  command: LegacyProjectMutationCommand
): NewMutation {
  return { ...identity, projectId, expectedProjectRevision, legacyBeforeHash, legacyMethod, command };
}

const CommandEnvelopeSchema = z
  .object({
    legacyMethod: z.enum(["project.create", "project.update", "session.create", "session.delete"]),
    expectedBeforeHash: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .nullable(),
    appliedAt: z.string().datetime(),
    command: z.record(z.string(), z.unknown())
  })
  .strict();

export function commandEnvelope(mutation: NewMutation): StorageJsonObject {
  return {
    legacyMethod: mutation.legacyMethod,
    expectedBeforeHash: mutation.legacyBeforeHash,
    appliedAt: mutation.preparedAt,
    command: mutation.command as unknown as StorageJsonObject
  };
}

export function legacyRequest(journal: StorageProjectMutationJournal): LegacyProjectMutationRequest {
  const envelope = CommandEnvelopeSchema.parse(JSON.parse(journal.commandJson));
  const beforeHash = envelope.expectedBeforeHash ?? durableJobRequestHash(null);
  if (beforeHash !== journal.legacyBeforeHash || envelope.appliedAt !== journal.preparedAt) {
    throw new Error("Persisted project mutation command does not match its journal identity.");
  }
  return {
    operationId: journal.operationId,
    method: envelope.legacyMethod,
    requestHash: journal.requestHash,
    projectId: journal.projectId,
    expectedBeforeHash: envelope.expectedBeforeHash,
    command: envelope.command as LegacyProjectMutationCommand,
    appliedAt: envelope.appliedAt
  };
}

export function finalizedResult(journal: StorageProjectMutationJournal): StorageJsonObject {
  if (!journal.publicResultJson || !journal.publicResultHash) throw new Error("Finalized project mutation result is unavailable.");
  const result = JSON.parse(journal.publicResultJson) as StorageJsonObject;
  if (durableJobRequestHash(result) !== journal.publicResultHash) throw new Error("Finalized project mutation result hash verification failed.");
  return result;
}

export function createProject(operationId: string, createdAt: string, input: ProjectInput, rootBase: string): ResearchProject {
  const id = stableEntityId("project", operationId);
  const shortId = id.replace(/[^a-zA-Z0-9]/g, "").slice(-12);
  return {
    ...input,
    id,
    createdAt,
    updatedAt: createdAt,
    currentStep: ResearchLoopStep.CreateResearchDb,
    status: "idle",
    projectRoot: `${rootBase.replace(/[\\/]+$/, "")}/${slugify(input.topic)}-${createdAt.slice(0, 10)}-${shortId}`,
    autonomyPolicy: { toolApproval: "suggested", allowAgent: true, allowExternalSearch: false, allowCodeExecution: false, maxLoopIterations: 3 }
  };
}

export function operationId(method: string, requestId: string): string {
  return `project-mutation:${durableJobRequestHash({ method, requestId })}`;
}

export function stableEntityId(prefix: string, operation: string): string {
  return `${prefix}-${createHash("sha256").update(`${operation}\0${prefix}`).digest("hex").slice(0, 32)}`;
}

export function timestampAfter(candidate: string, floor: string): string {
  const candidateMs = Date.parse(candidate);
  const floorMs = Date.parse(floor);
  if (!Number.isFinite(candidateMs) || !Number.isFinite(floorMs)) throw new Error("Project mutation timestamps are invalid.");
  const next = Math.max(candidateMs, floorMs + 1);
  if (!Number.isSafeInteger(next) || next > 8_640_000_000_000_000) throw new Error("Project mutation timestamp cannot advance monotonically.");
  return new Date(next).toISOString();
}

export function latestTimestamp(...values: string[]): string {
  const latest = values.reduce((result, value) => (Date.parse(value) > Date.parse(result) ? value : result));
  if (!Number.isFinite(Date.parse(latest))) throw new Error("Project mutation timestamp floor is invalid.");
  return latest;
}

export function validRevisionHead(value: StorageProjectRevisionHead | undefined): value is StorageProjectRevisionHead {
  return Boolean(value && Number.isSafeInteger(value.revision) && value.revision >= 0 && Number.isFinite(Date.parse(value.updatedAt)));
}
