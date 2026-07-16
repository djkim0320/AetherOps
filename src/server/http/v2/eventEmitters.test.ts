import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";
import type { ResearchSnapshot } from "../../../core/shared/types.js";
import { DurableJobRuntime } from "../../composition/durableJobRuntime.js";
import { migrateStorageV2Schema } from "../../runtime/storage/v2/schema.js";
import type { StorageWorkerCommand } from "../../runtime/storage/worker/typedProtocol.js";
import { StorageWorkerRuntime } from "../../runtime/storage/worker/typedRuntime.js";
import type { StorageWorkerClient } from "../../runtime/storage/worker/typedRuntime.js";
import {
  emitArtifactCreated,
  emitChatMessageAppended,
  emitProjectSnapshotChanged,
  emitRunStatusChanged,
  emitRunStepChanged,
  emitToolRunChanged
} from "./eventEmitters.js";

describe("durable SSE emitter identity", () => {
  it("reuses snapshot and chat identities only for the same canonical mutation", async () => {
    const appendEvent = vi.fn().mockResolvedValue(undefined);
    const commitProjectSnapshot = snapshotCommitMock();
    const events = { appendEvent, commitProjectSnapshot, getProjectRevision: vi.fn().mockResolvedValue(0) } as unknown as DurableJobRuntime;
    const secretBody = "private research body must not appear in an event id";
    const snapshot = snapshotWith("2026-07-16T00:00:00.000Z", secretBody);

    await emitProjectSnapshotChanged(events, snapshot, "project_updated");
    await emitProjectSnapshotChanged(events, structuredClone(snapshot), "project_updated");
    await emitProjectSnapshotChanged(events, snapshotWith("2026-07-16T00:00:01.000Z", secretBody), "project_updated");

    const [snapshotFirst, snapshotReplay, snapshotChanged] = snapshotEventIds(commitProjectSnapshot);
    expect(snapshotReplay).toBe(snapshotFirst);
    expect(snapshotChanged).not.toBe(snapshotFirst);
    expect(snapshotFirst).toMatch(/^event:[a-f0-9]{64}$/);
    expect(snapshotFirst).not.toContain(secretBody);

    commitProjectSnapshot.mockClear();
    await emitProjectSnapshotChanged(events, snapshot, "project_updated", "caller-mutation-1");
    await emitProjectSnapshotChanged(events, snapshotWith("2026-07-16T00:00:02.000Z", secretBody), "project_updated", "caller-mutation-1");
    const [callerFirst, callerDiverged] = snapshotEventIds(commitProjectSnapshot);
    expect(callerDiverged).toBe(callerFirst);
    expect(commitProjectSnapshot.mock.calls[1]?.[0].project).not.toEqual(commitProjectSnapshot.mock.calls[0]?.[0].project);

    appendEvent.mockClear();
    const occurredAt = "2026-07-16T00:01:00.000Z";
    await emitChatMessageAppended(events, "project-1", 2, "session-1", secretBody, "client-mutation-1", occurredAt);
    await emitChatMessageAppended(events, "project-1", 2, "session-1", secretBody, "client-mutation-1", occurredAt);
    await emitChatMessageAppended(events, "project-1", 2, "session-1", secretBody, "client-mutation-2", occurredAt);

    const [chatFirst, chatReplay, chatChanged] = internalEventIds(appendEvent);
    expect(chatReplay).toBe(chatFirst);
    expect(chatChanged).not.toBe(chatFirst);
    expect(chatFirst).toMatch(/^event:[a-f0-9]{64}$/);
    expect(chatFirst).not.toMatch(/client-mutation|private research/);
    const firstMessage = appendedData(appendEvent, 0).message as Record<string, unknown>;
    const replayMessage = appendedData(appendEvent, 1).message as Record<string, unknown>;
    expect(replayMessage).toEqual(firstMessage);
    expect(firstMessage.id).toMatch(/^message_[a-f0-9]{64}$/);
    expect(firstMessage.createdAt).toBe(occurredAt);
  });

  it("keys run, tool-attempt, and artifact mutations by their stable domain identities", async () => {
    const appendEvent = vi.fn().mockResolvedValue(undefined);
    const events = { appendEvent } as unknown as DurableJobRuntime;

    await emitRunStatusChanged(events, "project-1", 3, "job-1", "running", "queued");
    await emitRunStatusChanged(events, "project-1", 3, "job-1", "running", "queued");
    await emitRunStatusChanged(events, "project-1", 4, "job-1", "completed", "running");
    expectIdentityReplayThenMutation(appendEvent);

    appendEvent.mockClear();
    await emitRunStepChanged(events, "project-1", 3, "job-1", "EXECUTE_TOOLS", "checkpoint-1");
    await emitRunStepChanged(events, "project-1", 3, "job-1", "EXECUTE_TOOLS", "checkpoint-1");
    await emitRunStepChanged(events, "project-1", 4, "job-1", "EXECUTE_TOOLS", "checkpoint-2");
    expectIdentityReplayThenMutation(appendEvent);

    appendEvent.mockClear();
    await emitToolRunChanged(events, "project-1", 3, "job-1", "decision-1", "attempt-1", 0, "WebFetchTool", "running");
    await emitToolRunChanged(events, "project-1", 3, "job-1", "decision-1", "attempt-1", 0, "WebFetchTool", "running");
    await emitToolRunChanged(events, "project-1", 4, "job-1", "decision-1", "attempt-1", 0, "WebFetchTool", "completed");
    expectIdentityReplayThenMutation(appendEvent);

    appendEvent.mockClear();
    await emitArtifactCreated(events, "project-1", 3, "job-1", "artifact-1", "Report", "research_report");
    await emitArtifactCreated(events, "project-1", 3, "job-1", "artifact-1", "Report", "research_report");
    await emitArtifactCreated(events, "project-1", 4, "job-1", "artifact-2", "Report", "research_report");
    expectIdentityReplayThenMutation(appendEvent);
  });

  it("rejects a divergent snapshot replay that reuses one caller mutation id", async () => {
    const root = mkdtempSync(join(tmpdir(), "aetherops-sse-identity-"));
    const path = join(root, "storage.sqlite");
    const db = new DatabaseSync(path);
    migrateStorageV2Schema(db);
    db.close();
    const projectRoot = join(root, "project-1");
    mkdirSync(projectRoot);
    const worker = new StorageWorkerRuntime({ appDbPath: path, vectorDbPath: path, ontologyDbPath: path, requireFts5: false });
    const client = {
      request: <T>(command: StorageWorkerCommand): Promise<T> => Promise.resolve(worker.handle(command) as T),
      close: async () => undefined
    } as unknown as StorageWorkerClient;
    const events = new DurableJobRuntime(path, { concurrency: 1, storageClient: client, dataRoot: root });
    try {
      await events.initialize();
      const first = snapshotWith("2026-07-16T00:00:00.000Z", "first snapshot", projectRoot);
      await emitProjectSnapshotChanged(events, first, "project_updated", "caller-mutation-1", 0);
      await expect(emitProjectSnapshotChanged(events, structuredClone(first), "project_updated", "caller-mutation-1", 0)).resolves.toMatchObject({
        projectRevision: 1
      });
      await expect(
        emitProjectSnapshotChanged(
          events,
          snapshotWith("2026-07-16T00:00:01.000Z", "divergent snapshot", projectRoot),
          "project_updated",
          "caller-mutation-1",
          0
        )
      ).rejects.toThrow();
      await expect(events.eventsAfter("project-1")).resolves.toHaveLength(1);
    } finally {
      await events.close();
      worker.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});

function snapshotWith(updatedAt: string, goal: string, projectRoot = ".tmp/projects/project-1"): ResearchSnapshot {
  return {
    project: {
      id: "project-1",
      goal,
      topic: "Stable SSE identity",
      scope: "Local fixture only",
      budget: "One bounded operation",
      status: "idle",
      currentStep: "PLAN_RESEARCH",
      projectRoot,
      createdAt: "2026-07-16T00:00:00.000Z",
      updatedAt,
      autonomyPolicy: { toolApproval: "suggested", allowAgent: true, allowExternalSearch: false, allowCodeExecution: false, maxLoopIterations: 1 }
    },
    iterations: [],
    sessions: [],
    researchInputs: [],
    specifications: [],
    toolRuns: [],
    evidence: [],
    artifacts: []
  } as unknown as ResearchSnapshot;
}

function internalEventIds(appendEvent: ReturnType<typeof vi.fn>): string[] {
  return appendEvent.mock.calls.map((call) => String(call[1]));
}

function snapshotEventIds(commitProjectSnapshot: ReturnType<typeof vi.fn>): string[] {
  return commitProjectSnapshot.mock.calls.map((call) => String(call[0]?.eventId));
}

function appendedData(appendEvent: ReturnType<typeof vi.fn>, index: number): Record<string, unknown> {
  return (appendEvent.mock.calls[index]?.[0] as { data: Record<string, unknown> }).data;
}

function expectIdentityReplayThenMutation(appendEvent: ReturnType<typeof vi.fn>): void {
  const [first, replay, changed] = internalEventIds(appendEvent);
  expect(replay).toBe(first);
  expect(changed).not.toBe(first);
  expect(first).toMatch(/^event:[a-f0-9]{64}$/);
}

function snapshotCommitMock() {
  return vi.fn(async (input: { project: { id: string }; expectedProjectRevision: number; occurredAt: string; reason: "project_updated" }) => {
    const projectRevision = input.expectedProjectRevision + 1;
    return {
      event: {
        id: projectRevision,
        projectId: input.project.id,
        projectRevision,
        occurredAt: input.occurredAt,
        type: "project.snapshot.changed" as const,
        data: { snapshotVersion: projectRevision, reason: input.reason }
      },
      projectRevision,
      projectionHash: "a".repeat(64),
      exactReplay: false
    };
  });
}
