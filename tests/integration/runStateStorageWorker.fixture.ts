import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createCanonicalRunFixture } from "../fixtures/canonicalRunState.js";
import { storageCanonicalHasher } from "../../src/server/runtime/storage/v2/runStatePayloadValidator.js";
import { migrateStorageV2Schema } from "../../src/server/runtime/storage/v2/schema.js";
import type { StorageContextPackInput, StorageRunStateRevisionInput, StorageTaskContractInput } from "../../src/server/runtime/storage/v2/runStateTypes.js";
import type {
  StorageCapabilityAudit,
  StorageCapabilitySet,
  StorageClaimStartResult,
  StorageJobInput,
  StorageJobToolPolicy,
  StorageLeaseFence
} from "../../src/server/runtime/storage/v2/types.js";
import type { StorageFencedWriteCommand } from "../../src/server/runtime/storage/worker/typedProtocol.js";
import { createStorageWorkerClient, type StorageWorkerClient } from "../../src/server/runtime/storage/worker/typedRuntime.js";

export const PROJECT_ID = "project-worker-state";
export const RUN_ID = "run-worker-state";
export const TASK_ID = "task-worker-state";
export const NOW = "2026-07-14T00:00:00.000Z";
export const canonical = createCanonicalRunFixture({ projectId: PROJECT_ID, runId: RUN_ID, taskId: TASK_ID, createdAt: NOW });

const roots: string[] = [];
const clients: StorageWorkerClient[] = [];

export async function cleanupRunStateStorageWorkerFixture(): Promise<void> {
  await Promise.all(clients.splice(0).map((client) => client.close().catch(() => undefined)));
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
}

export function createDatabasePath(label: string): string {
  const root = mkdtempSync(join(tmpdir(), `aetherops-run-state-${label}-`));
  roots.push(root);
  const path = join(root, "storage.sqlite");
  prepareDatabase(path);
  return path;
}

export function countRows(path: string, table: "context_packs" | "run_state_revisions" | "run_job_links" | "checkpoints" | "task_contracts" | "jobs"): number {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    return Number((db.prepare(`select count(*) count from ${table}`).get() as { count: number }).count);
  } finally {
    db.close();
  }
}

export function prepareDatabase(path: string): void {
  const db = new DatabaseSync(path);
  try {
    migrateStorageV2Schema(db);
    db.prepare(
      `insert into projects_v2 (id,short_id,project_root,topic,status,created_at,updated_at,data)
       values (?,?,?,?,?,?,?,?)`
    ).run(
      PROJECT_ID,
      "workerstate",
      "worker-state-root",
      "worker state",
      "active",
      NOW,
      NOW,
      JSON.stringify({
        id: PROJECT_ID,
        projectRoot: "worker-state-root",
        topic: "worker state",
        status: "active",
        createdAt: NOW,
        updatedAt: NOW
      })
    );
    db.prepare("insert into project_revision_heads (project_id,revision,last_receipt_id,updated_at) values (?,0,null,?)").run(PROJECT_ID, NOW);
  } finally {
    db.close();
  }
}

export function worker(path: string, options: { includeDataRoot?: boolean } = {}): StorageWorkerClient {
  const client = createStorageWorkerClient({
    appDbPath: path,
    vectorDbPath: path,
    ontologyDbPath: path,
    requireFts5: true,
    ...(options.includeDataRoot === false ? {} : { dataRoot: dirname(path) })
  });
  clients.push(client);
  return client;
}

export function removeClient(client: StorageWorkerClient): void {
  const index = clients.indexOf(client);
  if (index >= 0) clients.splice(index, 1);
}

export async function claim(client: StorageWorkerClient, jobId: string, leaseOwner: string, now: string): Promise<StorageClaimStartResult> {
  const result = await client.request<StorageClaimStartResult | undefined>({
    name: "job.claimAndStart",
    options: { projectId: PROJECT_ID, leaseOwner, now, leaseExpiresAt: new Date(Date.now() + 60_000).toISOString() }
  });
  if (!result || result.job.id !== jobId) throw new Error(`Expected durable claim for ${jobId}.`);
  return result;
}

export async function currentProjectRevision(client: StorageWorkerClient): Promise<number> {
  const head = await client.request<{ revision: number }>({ name: "project.revision.get", projectId: PROJECT_ID });
  return head.revision;
}

export function expireLease(path: string, jobId: string): void {
  const db = new DatabaseSync(path);
  try {
    db.prepare("update jobs set lease_expires_at=? where id=?").run(new Date(Date.now() - 60_000).toISOString(), jobId);
  } finally {
    db.close();
  }
}

export async function fencedWrite<T>(
  client: StorageWorkerClient,
  fence: StorageLeaseFence,
  command: Extract<StorageFencedWriteCommand, { name: "taskContract.save" | "runState.commit" | "contextPack.save" }>,
  now = "2026-07-14T00:02:00.000Z"
): Promise<T> {
  const [result] = await client.request<[T]>({ name: "fencedTransaction", fence, now, commands: [command] });
  return result;
}

export function saveTaskContract(client: StorageWorkerClient, fence: StorageLeaseFence, contract = taskContract()): Promise<unknown> {
  return fencedWrite(client, fence, {
    name: "taskContract.save",
    owner: { projectId: PROJECT_ID, jobId: fence.jobId },
    contract
  });
}

export function taskContract(): StorageTaskContractInput {
  return canonical.taskContract();
}

export function stateRevision(revision: 0 | 1, jobId: string, contextPackId?: string): StorageRunStateRevisionInput {
  return canonical.revision(revision, jobId, contextPackId);
}

export function contextPack(jobId: string): StorageContextPackInput {
  return canonical.contextPack(jobId, 0);
}

interface JobInputOptions {
  request?: Record<string, unknown>;
  requestedCapabilities?: StorageCapabilitySet;
  effectiveCapabilities?: StorageCapabilitySet;
  toolPolicy?: StorageJobToolPolicy;
}

export function jobInput(id: string, resumesJobId?: string, resumeCheckpointId?: string, options: JobInputOptions = {}): StorageJobInput {
  return {
    id,
    projectId: PROJECT_ID,
    operation: "research_loop",
    expectedProjectRevision: 0,
    createdAt: NOW,
    queuedAt: NOW,
    payload: {
      projectRevision: 1,
      currentStep: "PLAN_RESEARCH",
      ...(options.request ? { request: options.request } : {}),
      ...(resumesJobId ? { resumesJobId, ...(resumeCheckpointId ? { resumeCheckpointId } : {}) } : {})
    },
    ...(options.requestedCapabilities ? { requestedCapabilities: options.requestedCapabilities } : {}),
    ...(options.effectiveCapabilities ? { effectiveCapabilities: options.effectiveCapabilities } : {}),
    ...(options.toolPolicy ? { toolPolicy: options.toolPolicy } : {})
  };
}

export function enqueueJob(client: StorageWorkerClient, job: StorageJobInput): Promise<unknown> {
  return client.request<{ revision: number }>({ name: "project.revision.get", projectId: job.projectId }).then((head) => {
    const capabilityAudits = jobCapabilityAudits(job);
    return client.request({ name: "job.enqueue", job: { ...job, expectedProjectRevision: head.revision }, ...(capabilityAudits ? { capabilityAudits } : {}) });
  });
}

function jobCapabilityAudits(job: StorageJobInput): StorageCapabilityAudit[] | undefined {
  if (!job.requestedCapabilities || !job.effectiveCapabilities) return undefined;
  return (["agent", "engineering", "search"] as const).map((capability) => {
    const operationAllowed = job.requestedCapabilities![capability];
    const allowed = job.effectiveCapabilities![capability];
    return {
      id: `capability-${job.id}-${capability}`,
      projectId: job.projectId,
      jobId: job.id,
      operation: capability,
      capability,
      appAllowed: true,
      projectAllowed: true,
      operationAllowed,
      allowed,
      data: { jobKind: "research_loop", ...(allowed ? {} : { blockedBy: "job" as const }) },
      auditedAt: job.queuedAt
    };
  });
}

export function canonicalInitializationAnchor() {
  const body = {
    schemaVersion: 1 as const,
    projectId: PROJECT_ID,
    taskSource: {
      project: {
        id: PROJECT_ID,
        goal: "Resume one immutable canonical research task.",
        scope: "Local deterministic storage-worker verification.",
        budget: "Bounded integration-test resources."
      }
    },
    immutablePolicy: bootstrapPolicy(),
    taskLimits: {
      maxDurationMs: 60_000,
      maxInputTokens: 10_000,
      maxOutputTokens: 2_000,
      maxToolCalls: 4,
      maxRetries: 1,
      maxEstimatedCostMicrousd: 100_000,
      maxToolOutputBytes: 1_000_000,
      maxConcurrency: 4
    }
  };
  return { ...body, contentHash: storageCanonicalHasher.sha256Canonical(body) };
}

export function bootstrapPolicy(): {
  requestedCapabilities: StorageCapabilitySet;
  effectiveCapabilities: StorageCapabilitySet;
  toolPolicy: StorageJobToolPolicy;
} {
  return {
    requestedCapabilities: { agent: true, engineering: false, search: false },
    effectiveCapabilities: { agent: true, engineering: false, search: false },
    toolPolicy: { allowCodexCli: false, sourceAccess: { mode: "offline" } }
  };
}

export function interruptWithCheckpoint(path: string, jobId: string, checkpointId: string): void {
  const db = new DatabaseSync(path);
  try {
    db.prepare("update jobs set status='interrupted',completed_at=?,updated_at=? where id=?").run(NOW, NOW, jobId);
    db.prepare(
      `insert into checkpoints
       (id,project_id,job_id,step,checkpoint_key,status,created_at,committed_at,data)
       values (?,?,?,?,?,'committed',?,?,?)`
    ).run(checkpointId, PROJECT_ID, jobId, "PLAN_RESEARCH", "resume", NOW, NOW, "{}");
  } finally {
    db.close();
  }
}

export function interruptJob(path: string, jobId: string): void {
  const db = new DatabaseSync(path);
  try {
    db.prepare("update jobs set status='interrupted',completed_at=?,updated_at=? where id=?").run(NOW, NOW, jobId);
  } finally {
    db.close();
  }
}
