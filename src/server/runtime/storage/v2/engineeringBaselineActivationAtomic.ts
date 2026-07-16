import { recordCapabilityAuditSet } from "./capabilityAuditAtomic.js";
import { isDeepStrictEqual } from "node:util";
import type { StorageActivateEngineeringBaselineTransactionResult } from "./engineeringBaselineTypes.js";
import { jobAtomicId } from "./jobAtomicIds.js";
import type { StorageV2RepositorySet } from "./repositories.js";
import { StorageImmutableConflictError, StorageOwnershipConflictError } from "./runStateErrors.js";
import type { StorageCapabilityAudit, StorageJobEventInput } from "./types.js";

interface EngineeringBaselineActivationCommand {
  input: Parameters<StorageV2RepositorySet["engineering"]["activate"]>[0];
  expectedProjectRevision: number;
  capabilityAudits: StorageCapabilityAudit[];
  event: StorageJobEventInput;
}

const CAPABILITIES = ["agent", "engineering", "search"] as const;

interface ProjectEngineeringPolicy {
  allowAgent?: boolean;
  allowCodeExecution: boolean;
  allowExternalSearch: boolean;
}

export function activateEngineeringBaselineAtomically(
  repositories: StorageV2RepositorySet,
  command: EngineeringBaselineActivationCommand
): StorageActivateEngineeringBaselineTransactionResult {
  const projectId = command.input.baseline.projectId;
  assertActivationEventInput(command);
  const committedEvent = repositories.events.get(command.event.eventId as string);
  const activation = repositories.engineering.activate(command.input);
  if (activation.exactReplay) {
    if (!committedEvent) throw new StorageImmutableConflictError();
    const event = repositories.events.append(command.event);
    const eventRevision = requiredEventRevision(event);
    const head = repositories.projectRevisions.current(projectId);
    if (command.expectedProjectRevision === eventRevision - 1) {
      assertOriginalRequestBaselineReplay(command, activation.baseline.revision);
      assertStoredAuthorizationReplay(repositories, projectId, command.expectedProjectRevision, command.capabilityAudits);
    } else if (head && command.expectedProjectRevision === head.revision) {
      assertCurrentEngineeringAuthorization(repositories, projectId, command.expectedProjectRevision, command.capabilityAudits);
    } else {
      repositories.projectRevisions.assertCurrent(projectId, command.expectedProjectRevision);
      throw new StorageImmutableConflictError();
    }
    return {
      activation,
      event,
      publishEvent: head?.revision === eventRevision && command.expectedProjectRevision === eventRevision - 1
    };
  }
  if (committedEvent) throw new StorageImmutableConflictError();
  repositories.projectRevisions.assertCurrent(projectId, command.expectedProjectRevision);
  assertCurrentEngineeringAuthorization(repositories, projectId, command.expectedProjectRevision, command.capabilityAudits);
  recordCapabilityAuditSet(repositories, command.capabilityAudits);
  return { activation, event: repositories.events.append(command.event), publishEvent: true };
}

function assertOriginalRequestBaselineReplay(command: EngineeringBaselineActivationCommand, storedBaselineRevision: number): void {
  if (command.input.expectedRevision !== storedBaselineRevision - 1 || command.input.baseline.revision !== storedBaselineRevision) {
    throw new StorageImmutableConflictError();
  }
}

function assertStoredAuthorizationReplay(
  repositories: StorageV2RepositorySet,
  projectId: string,
  expectedProjectRevision: number,
  audits: StorageCapabilityAudit[]
): void {
  if (audits.length !== CAPABILITIES.length || new Set(audits.map((audit) => audit.id)).size !== audits.length) {
    throw new StorageImmutableConflictError();
  }
  const byCapability = new Map(audits.map((audit) => [audit.capability, audit]));
  for (const capability of CAPABILITIES) {
    const audit = byCapability.get(capability);
    const stored = audit ? repositories.capabilities.get(audit.id) : undefined;
    if (
      !audit ||
      audit.projectId !== projectId ||
      audit.data?.projectRevision !== expectedProjectRevision ||
      !stored ||
      !isDeepStrictEqual(comparableAudit(stored), comparableAudit(audit))
    ) {
      throw new StorageImmutableConflictError();
    }
  }
  if (!byCapability.get("agent")?.allowed || !byCapability.get("engineering")?.allowed) throw new StorageImmutableConflictError();
}

function comparableAudit(audit: StorageCapabilityAudit): Record<string, unknown> {
  return {
    id: audit.id,
    projectId: audit.projectId,
    jobId: audit.jobId ?? null,
    operation: audit.operation,
    capability: audit.capability,
    appAllowed: audit.appAllowed,
    projectAllowed: audit.projectAllowed,
    operationAllowed: audit.operationAllowed,
    allowed: audit.allowed,
    reason: audit.reason ?? null,
    data: audit.data ?? null,
    auditedAt: audit.auditedAt
  };
}

function assertActivationEventInput(command: EngineeringBaselineActivationCommand): void {
  const { baseline } = command.input;
  const expectedEventId = jobAtomicId("event", baseline.projectId, baseline.contentHash, "baseline-activated");
  const payload = plainRecord(command.event.payload);
  const data = plainRecord(payload.data);
  if (
    command.event.eventId !== expectedEventId ||
    command.event.projectId !== baseline.projectId ||
    command.event.type !== "project.snapshot.changed" ||
    command.event.jobId !== undefined ||
    command.event.createdAt !== baseline.createdAt ||
    !exactKeys(payload, ["data", "projectRevision"]) ||
    payload.projectRevision !== command.expectedProjectRevision ||
    !exactKeys(data, ["reason", "snapshotVersion"]) ||
    data.snapshotVersion !== command.expectedProjectRevision ||
    data.reason !== "project_updated"
  ) {
    throw new StorageImmutableConflictError();
  }
}

function plainRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new StorageImmutableConflictError();
  return value as Record<string, unknown>;
}

function requiredEventRevision(event: { payload: unknown }): number {
  const payload = plainRecord(event.payload);
  const data = plainRecord(payload.data);
  const revision = payload.projectRevision;
  if (
    !exactKeys(payload, ["data", "projectRevision"]) ||
    !Number.isSafeInteger(revision) ||
    Number(revision) < 1 ||
    !exactKeys(data, ["reason", "snapshotVersion"]) ||
    data.snapshotVersion !== revision ||
    data.reason !== "project_updated"
  ) {
    throw new StorageImmutableConflictError();
  }
  return Number(revision);
}

function exactKeys(value: Record<string, unknown>, expected: string[]): boolean {
  const actual = Object.keys(value).sort();
  const orderedExpected = [...expected].sort();
  return actual.length === orderedExpected.length && actual.every((key, index) => key === orderedExpected[index]);
}

function assertCurrentEngineeringAuthorization(
  repositories: StorageV2RepositorySet,
  projectId: string,
  expectedProjectRevision: number,
  audits: StorageCapabilityAudit[]
): void {
  if (audits.length !== CAPABILITIES.length || new Set(audits.map((audit) => audit.id)).size !== audits.length) {
    throw new StorageImmutableConflictError();
  }
  const project = repositories.projects.get(projectId);
  if (!project) throw new StorageOwnershipConflictError();
  const policy = readPolicy(project);
  const projectAllowed = {
    agent: policy.allowAgent === undefined ? true : policy.allowAgent,
    engineering: policy.allowCodeExecution,
    search: policy.allowExternalSearch
  };
  const operationAllowed = { agent: true, engineering: true, search: false };
  const byCapability = new Map(audits.map((audit) => [audit.capability, audit]));
  for (const capability of CAPABILITIES) {
    const audit = byCapability.get(capability);
    if (
      !audit ||
      audit.projectId !== projectId ||
      audit.jobId !== undefined ||
      audit.operation !== capability ||
      audit.projectAllowed !== projectAllowed[capability] ||
      audit.operationAllowed !== operationAllowed[capability] ||
      audit.data?.jobKind !== "engineering_run" ||
      audit.data.projectRevision !== expectedProjectRevision ||
      audit.allowed !== (audit.appAllowed && audit.projectAllowed && audit.operationAllowed)
    ) {
      throw new StorageImmutableConflictError();
    }
  }
  if (!byCapability.get("agent")?.allowed || !byCapability.get("engineering")?.allowed) {
    throw new StorageImmutableConflictError();
  }
}

function readPolicy(project: object): ProjectEngineeringPolicy {
  const policy = "autonomyPolicy" in project ? project.autonomyPolicy : undefined;
  if (!policy || typeof policy !== "object" || Array.isArray(policy)) throw new StorageImmutableConflictError();
  const value = policy as Record<string, unknown>;
  if (
    (value.allowAgent !== undefined && typeof value.allowAgent !== "boolean") ||
    typeof value.allowCodeExecution !== "boolean" ||
    typeof value.allowExternalSearch !== "boolean"
  ) {
    throw new StorageImmutableConflictError();
  }
  return {
    ...(value.allowAgent === undefined ? {} : { allowAgent: value.allowAgent }),
    allowCodeExecution: value.allowCodeExecution,
    allowExternalSearch: value.allowExternalSearch
  } as ProjectEngineeringPolicy;
}
