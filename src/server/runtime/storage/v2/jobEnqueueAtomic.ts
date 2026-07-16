import { createHash } from "node:crypto";
import type { StorageV2RepositorySet } from "./repositories.js";
import type { StorageEnqueueJobResult } from "./jobAtomicTypes.js";
import type { StorageCapabilityAudit, StorageJob, StorageJobInput, StorageProjectPayload } from "./types.js";
import { StorageImmutableConflictError, StorageOwnershipConflictError } from "./runStateErrors.js";

export function enqueueJob(
  repositories: StorageV2RepositorySet,
  input: StorageJobInput,
  project?: StorageProjectPayload,
  capabilityAudits: StorageCapabilityAudit[] = []
): StorageEnqueueJobResult {
  const replay = lookupEnqueueReceipt(repositories, input.projectId, input.idempotencyKey, input.requestHash);
  if (replay) return replay;
  assertEnqueueAudits(input, capabilityAudits);
  if (project) {
    if (!isProjectOwner(project, input.projectId)) throw new StorageOwnershipConflictError();
    repositories.projects.upsert(project);
  }
  repositories.projectRevisions.assertCurrent(input.projectId, requiredExpectedProjectRevision(input));
  const job = repositories.jobs.enqueue(input);
  const eventId = stableId("event", job.id, "queued");
  if (job.id !== input.id) return replayReceipt(repositories, job);
  const persistedAudits = capabilityAudits.map((audit) => repositories.capabilities.record(audit));
  const event = repositories.events.append({
    eventId,
    projectId: job.projectId,
    jobId: job.id,
    type: "run.status.changed",
    createdAt: job.queuedAt,
    payload: { projectRevision: requiredProjectRevision(job), data: { jobId: job.id, status: "queued" } }
  });
  return { job, event, capabilityAudits: persistedAudits };
}

export function lookupEnqueueReceipt(
  repositories: StorageV2RepositorySet,
  projectId: string,
  idempotencyKey: string | undefined,
  requestHash: string | undefined
): StorageEnqueueJobResult | undefined {
  const existing = idempotencyKey ? repositories.jobs.getByIdempotencyRequest(projectId, idempotencyKey, requestHash) : undefined;
  return existing ? replayReceipt(repositories, existing) : undefined;
}

function replayReceipt(repositories: StorageV2RepositorySet, job: StorageJob): StorageEnqueueJobResult {
  const event = repositories.events.get(stableId("event", job.id, "queued"));
  const persistedAuditCount = repositories.capabilities.countJob(job.id);
  const persistedAudits = repositories.capabilities.listJob(job.id, 1_000);
  if (persistedAuditCount !== persistedAudits.length) throw new StorageImmutableConflictError();
  return { job, ...(event ? { event } : {}), capabilityAudits: persistedAudits };
}

function isProjectOwner(project: StorageProjectPayload, projectId: string): boolean {
  return typeof project === "object" && project !== null && "id" in project && project.id === projectId;
}

function assertEnqueueAudits(input: StorageJobInput, audits: StorageCapabilityAudit[]): void {
  const hasRequested = input.requestedCapabilities !== undefined;
  const hasEffective = input.effectiveCapabilities !== undefined;
  if (hasRequested !== hasEffective) throw new StorageImmutableConflictError();
  if (!hasRequested && audits.length) throw new StorageImmutableConflictError();
  if (hasRequested && audits.length !== 3) throw new StorageImmutableConflictError();
  if (audits.length > 16 || new Set(audits.map((audit) => audit.id)).size !== audits.length) throw new StorageImmutableConflictError();
  const decisions = new Set<string>();
  for (const audit of audits) {
    if (audit.projectId !== input.projectId || audit.jobId !== input.id || !audit.id || !audit.capability) throw new StorageOwnershipConflictError();
    const capability = audit.capability as keyof NonNullable<StorageJobInput["effectiveCapabilities"]>;
    if (
      !["agent", "engineering", "search"].includes(capability) ||
      audit.operation !== capability ||
      audit.operationAllowed !== input.requestedCapabilities?.[capability] ||
      audit.allowed !== input.effectiveCapabilities?.[capability] ||
      audit.allowed !== (audit.appAllowed && audit.projectAllowed && audit.operationAllowed)
    ) {
      throw new StorageImmutableConflictError();
    }
    const key = `${audit.operation}\u0000${audit.capability}`;
    if (decisions.has(key)) throw new StorageImmutableConflictError();
    decisions.add(key);
  }
}

function requiredProjectRevision(job: Pick<StorageJob, "id" | "payload">): number {
  const payload = job.payload && typeof job.payload === "object" && !Array.isArray(job.payload) ? (job.payload as Record<string, unknown>) : undefined;
  const revision = payload?.projectRevision;
  if (!Number.isInteger(revision) || Number(revision) < 0) throw new Error(`Durable job is missing a valid project revision: ${job.id}`);
  return Number(revision);
}

function requiredExpectedProjectRevision(input: StorageJobInput): number {
  const revision = input.expectedProjectRevision;
  if (!Number.isSafeInteger(revision) || Number(revision) < 0) throw new Error(`Durable enqueue is missing its expected project revision: ${input.id}.`);
  return Number(revision);
}

function stableId(prefix: string, ...parts: string[]): string {
  return `${prefix}-${createHash("sha256").update(parts.join("\u0000")).digest("hex")}`;
}
