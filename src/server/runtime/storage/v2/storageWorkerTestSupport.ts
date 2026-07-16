import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { StorageWorkerRuntime } from "../worker/typedRuntime.js";
import { fencedAttemptCommands } from "./traceTestFixtures.js";
import type { StorageClaimStartResult, StorageJob, StorageLeaseFence } from "./types.js";

export function upsertStorageTestProject(runtime: StorageWorkerRuntime | undefined, root: string | undefined, projectId: string, timestamp: string): void {
  if (!runtime || !root) throw new Error("Storage test runtime is not initialized.");
  const projectRoot = join(root, projectId);
  mkdirSync(projectRoot, { recursive: true });
  runtime.handle({
    name: "project.upsert",
    project: {
      id: projectId,
      projectRoot,
      topic: projectId,
      status: "active",
      createdAt: timestamp,
      updatedAt: timestamp
    }
  });
}

export function stableStorageTestId(prefix: string, ...parts: string[]): string {
  return `${prefix}-${createHash("sha256").update(parts.join("\u0000")).digest("hex")}`;
}

export function storageTestProjectHead(runtime: StorageWorkerRuntime | undefined, projectId: string): { revision: number; lastReceiptId?: string } {
  const head = runtime?.handle({ name: "project.revision.get", projectId }) as { revision: number; lastReceiptId?: string };
  return { revision: head.revision, ...(head.lastReceiptId ? { lastReceiptId: head.lastReceiptId } : {}) };
}

export function storageTestProjectRevision(runtime: StorageWorkerRuntime | undefined, projectId: string): number {
  return storageTestProjectHead(runtime, projectId).revision;
}

export function enqueueStorageTestResearchJob(
  runtime: StorageWorkerRuntime | undefined,
  root: string | undefined,
  input: { id: string; projectId: string; priority?: number; queuedAt?: string; projectRevision?: number }
): StorageJob {
  if (!runtime) throw new Error("Storage test runtime is not initialized.");
  const now = input.queuedAt ?? "2026-07-14T00:00:00.000Z";
  upsertStorageTestProject(runtime, root, input.projectId, "2026-07-14T00:00:00.000Z");
  const result = runtime.handle({
    name: "job.enqueue",
    job: {
      id: input.id,
      projectId: input.projectId,
      priority: input.priority,
      operation: "research_loop",
      expectedProjectRevision: storageTestProjectRevision(runtime, input.projectId),
      idempotencyKey: input.id,
      createdAt: now,
      queuedAt: now,
      payload: { currentStep: "EXECUTE_TOOLS", projectRevision: input.projectRevision ?? 1 }
    }
  }) as { job: StorageJob };
  return result.job;
}

export function storageTestClaimOptions(projectId: string) {
  return {
    projectId,
    leaseOwner: "worker-a",
    leaseExpiresAt: "2026-07-14T00:01:00.000Z",
    now: "2026-07-14T00:00:01.000Z"
  };
}

export function claimStorageTestJob(
  runtime: StorageWorkerRuntime | undefined,
  projectId: string,
  now = "2026-07-14T00:00:01.000Z",
  leaseExpiresAt = "2026-07-14T00:01:00.000Z"
): StorageClaimStartResult {
  const value = runtime?.handle({ name: "job.claimAndStart", options: { projectId, leaseOwner: "worker-a", leaseExpiresAt, now } });
  if (!value) throw new Error(`Expected a claim for ${projectId}.`);
  return value as StorageClaimStartResult;
}

export function storageTestFenceOf(job: StorageJob): StorageLeaseFence {
  if (!job.leaseOwner) throw new Error("Claimed job is missing its lease owner.");
  return { jobId: job.id, attempt: job.attempt, leaseOwner: job.leaseOwner, leaseGeneration: job.leaseGeneration };
}

export function storageTestToolAttempt(job: StorageJob, id: string, status: "running" | "completed") {
  return {
    id,
    projectId: job.projectId,
    jobId: job.id,
    decisionId: `decision-${id}`,
    ordinal: 0,
    status,
    inputHash: "a".repeat(64),
    outputHash: status === "completed" ? "b".repeat(64) : undefined,
    terminalCause: status === "completed" ? "completed" : undefined,
    dependsOnAttemptIds: [],
    queuedAt: "2026-07-14T00:00:01.000Z",
    startedAt: "2026-07-14T00:00:02.000Z",
    completedAt: status === "completed" ? "2026-07-14T00:00:03.000Z" : undefined
  };
}

export function storageTestPromotedArtifactLink(job: StorageJob, attemptId: string, outputId: string) {
  return {
    id: `link-${outputId}`,
    projectId: job.projectId,
    jobId: job.id,
    attemptId,
    outputKind: "artifact" as const,
    outputId,
    promoted: true,
    createdAt: "2026-07-14T00:00:05.000Z",
    promotedAt: "2026-07-14T00:00:06.000Z"
  };
}

export function saveStorageTestFencedToolAttempt(
  runtime: StorageWorkerRuntime | undefined,
  job: StorageJob,
  attempt: ReturnType<typeof storageTestToolAttempt>
): void {
  runtime?.handle({ name: "fencedTransaction", fence: storageTestFenceOf(job), commands: fencedAttemptCommands(job, attempt) });
}

export function captureStorageTestError(action: () => unknown): Error {
  try {
    action();
  } catch (error) {
    if (error instanceof Error) return error;
  }
  throw new Error("Expected an Error to be thrown.");
}
