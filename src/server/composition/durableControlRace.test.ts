import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import type { StorageWorkerCommand } from "../runtime/storage/worker/typedProtocol.js";
import { createStorageWorkerClient, StorageWorkerClient } from "../runtime/storage/worker/typedRuntime.js";
import { migrateStorageV2Schema } from "../runtime/storage/v2/schema.js";
import type { StorageToolOutputLink } from "../runtime/storage/v2/traceTypes.js";
import type { StorageCheckpoint, StorageStepAttempt } from "../runtime/storage/v2/types.js";
import { DurableJobRuntime } from "./durableJobRuntime.js";

let root: string | undefined;
let runtime: DurableJobRuntime | undefined;

afterEach(async () => {
  await runtime?.close().catch(() => undefined);
  runtime = undefined;
  if (root) rmSync(root, { recursive: true, force: true });
  root = undefined;
});

describe("durable control completion races", () => {
  it.each([
    { control: "pause" as const, expectedStatus: "paused" as const },
    { control: "abort" as const, expectedStatus: "aborted" as const }
  ])("uses durable $control as the source of truth before atomically committing a completed step", async ({ control, expectedStatus }) => {
    const databasePath = createDatabase(`cross-runtime-${control}-completed-step`);
    const worker = createStorageWorkerClient({
      appDbPath: databasePath,
      vectorDbPath: databasePath,
      ontologyDbPath: databasePath,
      requireFts5: true
    });
    const transitionEntered = deferred<void>();
    const releaseTransition = deferred<void>();
    let gated = false;
    const storageClient = {
      async request<T>(command: StorageWorkerCommand): Promise<T> {
        if (!gated && command.name === "job.transitionTerminal" && command.input.status === "completed" && command.input.completedStep) {
          gated = true;
          transitionEntered.resolve();
          await releaseTransition.promise;
        }
        return worker.request<T>(command);
      },
      close: () => worker.close()
    } as unknown as StorageWorkerClient;
    runtime = new DurableJobRuntime(databasePath, { concurrency: 1, storageClient });
    const terminalCommitted = deferred<void>();
    runtime.subscribe((event) => {
      if (event.type === "run.status.changed" && event.data.status === expectedStatus) terminalCommitted.resolve();
    });
    runtime.registerHandler("research_loop", async (job) => {
      const occurredAt = new Date().toISOString();
      const decisionId = `decision-${control}`;
      const attemptId = `attempt-${control}`;
      const output: StorageToolOutputLink = {
        id: `output-${control}`,
        projectId: job.projectId,
        jobId: job.id,
        attemptId,
        outputKind: "artifact",
        outputId: `artifact-${control}`,
        promoted: false,
        createdAt: occurredAt
      };
      await runtime?.recordToolDecision({
        id: decisionId,
        projectId: job.projectId,
        jobId: job.id,
        toolName: "DeterministicProbeTool",
        purpose: "Exercise durable control ordering.",
        expectedOutcome: "An output that remains unpromoted when control wins.",
        rawSelection: {},
        userPinned: true,
        policyStatus: "accepted",
        createdAt: occurredAt
      });
      await runtime?.recordToolAttemptAndEvent({
        projectRevision: 2,
        toolName: "DeterministicProbeTool",
        attempt: {
          id: attemptId,
          projectId: job.projectId,
          jobId: job.id,
          decisionId,
          ordinal: 0,
          status: "completed",
          inputHash: "input-hash",
          outputHash: "output-hash",
          terminalCause: "completed",
          dependsOnAttemptIds: [],
          queuedAt: occurredAt,
          startedAt: occurredAt,
          completedAt: occurredAt
        }
      });
      await runtime?.recordToolOutput(output);
      await runtime?.finish(job.id, 2, [
        {
          link: { ...output, promoted: true, promotedAt: occurredAt },
          artifact: { name: `${control}-result.json`, kind: "engineering_result" }
        }
      ]);
    });
    await runtime.initialize();
    const other = new DurableJobRuntime(databasePath, 1);
    await other.initialize();
    try {
      const receipt = await runtime.enqueue({
        projectId: `project-cross-runtime-${control}`,
        kind: "research_loop",
        projectRevision: 2,
        currentStep: "EXECUTE_TOOLS",
        idempotencyKey: `cross-runtime-${control}`,
        payload: {}
      });
      await transitionEntered.promise;
      if (control === "pause") await other.requestPause(receipt.jobId, 2);
      else await other.requestAbort(receipt.jobId, 2);
      releaseTransition.resolve();
      await terminalCommitted.promise;

      const checkpoints = await storageClient.request<StorageCheckpoint[]>({ name: "checkpoint.listForJob", jobId: receipt.jobId });
      const stepAttempts = await storageClient.request<StorageStepAttempt[]>({ name: "checkpoint.listStepAttempts", jobId: receipt.jobId });
      const outputs = await storageClient.request<StorageToolOutputLink[]>({ name: "trace.output.listAttempt", attemptId: `attempt-${control}` });
      const events = await runtime.eventsAfter(`project-cross-runtime-${control}`);
      expect(await runtime.get(receipt.jobId)).toMatchObject({ status: expectedStatus });
      expect(checkpoints).toEqual([expect.objectContaining({ status: "quarantined", step: "EXECUTE_TOOLS" })]);
      expect(checkpoints).not.toEqual(expect.arrayContaining([expect.objectContaining({ status: "committed" })]));
      expect(stepAttempts).toEqual([expect.objectContaining({ status: "quarantined", checkpointId: checkpoints[0]?.id })]);
      expect(outputs).toEqual([expect.objectContaining({ outputId: `artifact-${control}`, promoted: false })]);
      expect(events.filter((event) => event.type === "artifact.created")).toHaveLength(0);
      expect(events.slice(-2)).toMatchObject([
        { type: "run.step.changed", data: { jobId: receipt.jobId, step: "EXECUTE_TOOLS", checkpointId: checkpoints[0]?.id } },
        { type: "run.status.changed", data: { jobId: receipt.jobId, status: expectedStatus } }
      ]);
    } finally {
      releaseTransition.resolve();
      await other.close();
    }
  });
});

function createDatabase(label: string): string {
  root = mkdtempSync(join(tmpdir(), `aetherops-durable-${label}-`));
  const databasePath = join(root, "storage.sqlite");
  const db = new DatabaseSync(databasePath);
  migrateStorageV2Schema(db);
  db.close();
  return databasePath;
}

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}
