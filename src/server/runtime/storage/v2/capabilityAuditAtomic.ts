import { StorageImmutableConflictError, StorageOwnershipConflictError } from "./runStateErrors.js";
import type { StorageV2RepositorySet } from "./repositories.js";
import type { StorageCapabilityAudit, StorageProjectPayload } from "./types.js";

const CAPABILITIES = ["agent", "engineering", "search"] as const;

export function recordCapabilityAuditSet(
  repositories: StorageV2RepositorySet,
  audits: StorageCapabilityAudit[],
  project?: StorageProjectPayload
): StorageCapabilityAudit[] {
  assertAuditSet(audits, project);
  if (project) repositories.projects.upsert(project);
  return audits.map((audit) => repositories.capabilities.record(audit));
}

function assertAuditSet(audits: StorageCapabilityAudit[], project?: StorageProjectPayload): void {
  if (audits.length !== CAPABILITIES.length || new Set(audits.map((audit) => audit.id)).size !== audits.length) {
    throw new StorageImmutableConflictError();
  }
  const projectIds = new Set(audits.map((audit) => audit.projectId));
  const jobIds = new Set(audits.map((audit) => audit.jobId ?? null));
  const capabilities = new Set(audits.map((audit) => audit.capability));
  if (projectIds.size !== 1 || jobIds.size !== 1 || CAPABILITIES.some((capability) => !capabilities.has(capability))) {
    throw new StorageOwnershipConflictError();
  }
  const projectId = audits[0]?.projectId;
  if (project && (!projectId || typeof project !== "object" || project === null || !("id" in project) || project.id !== projectId)) {
    throw new StorageOwnershipConflictError();
  }
  if (audits.some((audit) => audit.operation !== audit.capability)) throw new StorageImmutableConflictError();
}
