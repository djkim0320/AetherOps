import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { StorageWorkerRuntime } from "../worker/typedRuntime.js";
import { migrateStorageV2Schema } from "./schema.js";
import { TerminalCasStore, type StorageTerminalCasObject } from "./terminalCasStore.js";
import type { StorageClaimStartResult, StorageLeaseFence } from "./types.js";

const projectId = "project-engineering-origin-fault";
const jobId = "job-engineering-origin-fault";
const attemptId = "attempt-engineering-origin-fault";
const decisionId = "decision-engineering-origin-fault";
const descriptorVersion = "engineering-program-v1";
const verifiedAt = "2026-07-14T00:00:02.000Z";
let root: string | undefined;
let runtime: StorageWorkerRuntime | undefined;

afterEach(() => {
  runtime?.close();
  runtime = undefined;
  if (root) rmSync(root, { recursive: true, force: true });
  root = undefined;
});

describe("engineering promotion atomicity", () => {
  it("rolls back job, checkpoint, output link, promotion, and events when the tool receipt is forged", () => {
    const path = createRuntime();
    const projectRoot = join(root as string, projectId);
    mkdirSync(projectRoot);
    runtime?.handle({
      name: "project.upsert",
      project: {
        id: projectId,
        projectRoot,
        topic: projectId,
        status: "active",
        createdAt: "2026-07-14T00:00:00.000Z",
        updatedAt: "2026-07-14T00:00:00.000Z"
      }
    });
    runtime?.handle({ name: "job.enqueue", job: jobInput() });
    const claimed = runtime?.handle({ name: "job.claimAndStart", options: claimOptions() }) as StorageClaimStartResult;
    recordCompletedEngineeringAttempt(claimed.fence);
    const artifact = new TerminalCasStore(root).materializeBytes(Buffer.from("forged-origin-artifact", "utf8"));

    expect(() => runtime?.handle({ name: "job.transitionTerminal", input: forgedTransition(claimed.fence, artifact) })).toThrow(/tool origin/i);

    const readback = new DatabaseSync(path, { readOnly: true });
    try {
      expect(readback.prepare("select status from jobs where id=?").get(jobId)).toEqual({ status: "running" });
      for (const [table, predicate] of [
        ["checkpoints", "job_id"],
        ["tool_output_links", "job_id"],
        ["engineering_result_promotions", "job_id"]
      ]) {
        expect(readback.prepare(`select count(*) count from ${table} where ${predicate}=?`).get(jobId)).toEqual({ count: 0 });
      }
      expect(readback.prepare("select count(*) count from job_events where job_id=?").get(jobId)).toEqual({ count: 2 });
      expect(readback.prepare("select status from step_attempts where job_id=?").all(jobId)).toEqual([{ status: "running" }]);
    } finally {
      readback.close();
    }
  });
});

function createRuntime(): string {
  root = mkdtempSync(join(tmpdir(), "aetherops-engineering-atomicity-"));
  const path = join(root, "storage.sqlite");
  const db = new DatabaseSync(path);
  migrateStorageV2Schema(db);
  db.close();
  runtime = new StorageWorkerRuntime(
    { appDbPath: path, vectorDbPath: path, ontologyDbPath: path, dataRoot: root },
    { leaseClock: () => Date.parse("2026-07-14T00:00:01.000Z") }
  );
  return path;
}

function recordCompletedEngineeringAttempt(fence: StorageLeaseFence): void {
  const idempotencyKey = "engineering-origin-idempotency";
  const attempt = {
    id: attemptId,
    projectId,
    jobId,
    decisionId,
    ordinal: 1,
    inputHash: "a".repeat(64),
    traceVersion: 1 as const,
    traceAvailability: "vnext" as const,
    descriptorVersion,
    descriptorSideEffects: [] as const,
    idempotencyKey,
    dependsOnAttemptIds: [] as string[],
    queuedAt: "2026-07-14T00:00:01.000Z"
  };
  runtime?.handle({
    name: "fencedTransaction",
    fence,
    now: verifiedAt,
    commands: [
      {
        name: "trace.decision.record",
        decision: {
          id: decisionId,
          projectId,
          jobId,
          toolName: "EngineeringProgramTool",
          purpose: "Verify atomic engineering origin enforcement.",
          expectedOutcome: "A forged receipt is rejected without durable promotion state.",
          rawSelection: {},
          userPinned: true,
          policyStatus: "accepted",
          createdAt: "2026-07-14T00:00:01.000Z"
        }
      },
      { name: "trace.attempt.save", attempt: { ...attempt, status: "queued" } },
      { name: "trace.attempt.save", attempt: { ...attempt, status: "running", startedAt: "2026-07-14T00:00:01.000Z" } },
      {
        name: "trace.attempt.save",
        attempt: {
          ...attempt,
          status: "completed",
          outputHash: "b".repeat(64),
          terminalCause: "completed",
          startedAt: "2026-07-14T00:00:01.000Z",
          completedAt: verifiedAt
        }
      }
    ]
  });
}

function forgedTransition(fence: StorageLeaseFence, artifact: StorageTerminalCasObject) {
  const promotedAt = "2026-07-14T00:00:03.000Z";
  const outputLinkId = "output-engineering-origin-fault";
  const outputId = "artifact-engineering-origin-fault";
  const forgedReceiptHash = "f".repeat(64);
  return {
    fence,
    status: "completed" as const,
    projectRevision: 2,
    occurredAt: promotedAt,
    completedStep: { step: "EXECUTE_TOOLS", checkpointData: { phase: "completed" }, outputHash: "b".repeat(64) },
    promotions: [
      {
        link: { id: outputLinkId, projectId, jobId, attemptId, outputKind: "artifact" as const, outputId, promoted: true, createdAt: verifiedAt, promotedAt },
        artifact: { name: "result.json", kind: "engineering_result" },
        engineering: {
          id: "promotion-engineering-origin-fault",
          schemaVersion: 1 as const,
          projectId,
          jobId,
          attemptId,
          outputLinkId,
          outputId,
          resultKind: "engineering_report" as const,
          baselineId: "baseline-engineering-origin-fault",
          baselineRevision: 1,
          baselineContentHash: "1".repeat(64),
          baselineDependencyHash: "2".repeat(64),
          dependencyAspects: ["solver"] as const,
          artifact: {
            casLocator: artifact.casLocator,
            sha256: artifact.casHash,
            byteLength: artifact.byteLength,
            mediaType: "application/json"
          },
          tool: { name: "EngineeringProgramTool", version: descriptorVersion, executionMedia: "test@1", receiptHash: forgedReceiptHash },
          modelCardId: "model-card:test:1",
          simulationRunReceiptId: "tool-run:test",
          convergence: "not_applicable" as const,
          domainAssessment: "not_assessed" as const,
          postcondition: "passed" as const,
          postconditionReceiptHash: forgedReceiptHash,
          sensitivity: "project" as const,
          promotedAt,
          receiptHash: "4".repeat(64)
        }
      }
    ]
  };
}

function jobInput() {
  return {
    id: jobId,
    projectId,
    operation: "engineering_run",
    expectedProjectRevision: 0,
    idempotencyKey: jobId,
    createdAt: "2026-07-14T00:00:00.000Z",
    queuedAt: "2026-07-14T00:00:00.000Z",
    payload: { projectRevision: 1, currentStep: "EXECUTE_TOOLS" }
  };
}

function claimOptions() {
  return {
    projectId,
    leaseOwner: "worker-engineering-origin",
    leaseExpiresAt: "2026-07-14T00:01:00.000Z",
    now: "2026-07-14T00:00:01.000Z"
  };
}
