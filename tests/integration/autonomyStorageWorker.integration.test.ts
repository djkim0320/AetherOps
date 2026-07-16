import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

import { migrateStorageV2Schema } from "../../src/server/runtime/storage/v2/schema.js";
import { IDEMPOTENCY_CONFLICT_PUBLIC_MESSAGE, IdempotencyConflictError } from "../../src/server/runtime/storage/v2/jobErrors.js";
import { createStorageWorkerClient, type StorageWorkerClient } from "../../src/server/runtime/storage/worker/typedRuntime.js";

const clients: StorageWorkerClient[] = [];
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("autonomy offline storage worker", () => {
  it("uses a real worker thread and atomically commits a job with its event", async () => {
    const root = mkdtempSync(join(tmpdir(), "aetherops-autonomy-worker-"));
    roots.push(root);
    const databasePath = join(root, "storage.sqlite");
    const database = new DatabaseSync(databasePath);
    try {
      migrateStorageV2Schema(database, { requireFts5: true });
    } finally {
      database.close();
    }
    const client = createStorageWorkerClient({
      appDbPath: databasePath,
      vectorDbPath: databasePath,
      ontologyDbPath: databasePath,
      requireFts5: true
    });
    clients.push(client);

    await expect(client.request({ name: "ping" })).resolves.toEqual({ ok: true });
    const now = "2026-07-11T00:00:00.000Z";
    const job = {
      id: "job-offline",
      projectId: "project-offline",
      operation: "research",
      expectedProjectRevision: 0,
      idempotencyKey: "offline-idempotency",
      requestHash: "sha256:offline",
      requestedCapabilities: { agent: true, engineering: true, search: false },
      effectiveCapabilities: { agent: true, engineering: true, search: false },
      toolPolicy: { allowCodexCli: false, sourceAccess: { mode: "offline" as const } },
      createdAt: now,
      payload: { projectRevision: 1, currentStep: "EXECUTE_TOOLS" }
    };
    const project = {
      id: "project-offline",
      goal: "Verify atomic project ownership.",
      topic: "Offline storage",
      scope: "Local fixture only",
      budget: "One bounded run",
      autonomyPolicy: { toolApproval: "suggested" as const, allowAgent: true, allowExternalSearch: false, allowCodeExecution: false },
      createdAt: now,
      updatedAt: now,
      currentStep: "EXECUTE_TOOLS" as const,
      status: "idle" as const,
      projectRoot: join(root, "projects", "project-offline")
    };
    const enqueued = await client.request<{ job: { id: string }; event: { jobId: string; type: string } }>({
      name: "job.enqueue",
      job,
      project,
      capabilityAudits: capabilityAudits(job, now)
    });
    expect(enqueued).toMatchObject({ job: { id: "job-offline" }, event: { jobId: "job-offline", type: "run.status.changed" } });

    await expect(client.request({ name: "job.get", jobId: "job-offline" })).resolves.toMatchObject({
      id: "job-offline",
      status: "queued",
      toolPolicy: { allowCodexCli: false, sourceAccess: { mode: "offline" } }
    });
    await expect(client.request({ name: "project.get", projectId: "project-offline" })).resolves.toEqual(project);
    await expect(client.request({ name: "event.after", projectId: "project-offline", lastEventId: 0 })).resolves.toEqual([
      expect.objectContaining({ jobId: "job-offline", type: "run.status.changed" })
    ]);

    const conflict = await client
      .request({ name: "job.enqueue", job: { ...job, id: "job-conflict", requestHash: "sha256:different" } })
      .catch((error: unknown) => error);
    expect(conflict).toBeInstanceOf(IdempotencyConflictError);
    expect(conflict).toMatchObject({ code: "IDEMPOTENCY_CONFLICT", message: IDEMPOTENCY_CONFLICT_PUBLIC_MESSAGE });
    expect((conflict as Error).message).not.toMatch(/project-offline|offline-idempotency|sha256/);
  });
});

function capabilityAudits(
  job: {
    id: string;
    projectId: string;
    requestedCapabilities: { agent: boolean; engineering: boolean; search: boolean };
    effectiveCapabilities: { agent: boolean; engineering: boolean; search: boolean };
  },
  auditedAt: string
) {
  return (["agent", "engineering", "search"] as const).map((capability) => ({
    id: `capability-${job.id}-${capability}`,
    projectId: job.projectId,
    jobId: job.id,
    operation: capability,
    capability,
    appAllowed: true,
    projectAllowed: true,
    operationAllowed: job.requestedCapabilities[capability],
    allowed: job.effectiveCapabilities[capability],
    data: {
      jobKind: "research_loop" as const,
      ...(job.effectiveCapabilities[capability] ? {} : { blockedBy: "job" as const })
    },
    auditedAt
  }));
}
