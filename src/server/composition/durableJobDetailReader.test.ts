import { describe, expect, it, vi } from "vitest";
import type { StorageWorkerClient } from "../runtime/storage/worker/typedRuntime.js";
import { STORAGE_TRACE_CATEGORIES, type StorageTraceCategory, type StorageTracePage } from "../runtime/storage/v2/traceTypes.js";
import { readDurableJobDetail } from "./durableJobDetailReader.js";
import type { DurableJobRecord } from "./durableJobTypes.js";

describe("readDurableJobDetail", () => {
  it("uses one exact summary and six bounded pages without per-attempt reads", async () => {
    const attempts = Array.from({ length: 200 }, (_, index) => attempt(index));
    const request = vi.fn(async (command: { name: string; category?: StorageTraceCategory; cursor?: string; limit?: number }) => {
      if (command.name === "trace.summaryJob") {
        return {
          jobId: "job-1",
          counts: { llmInvocations: 0, toolDecisions: 0, toolAttempts: 205, codexCliExecutions: 0, outputs: 0, networkAudits: 0 },
          total: 205
        };
      }
      if (command.name === "trace.pageJob" && command.category) {
        return {
          category: command.category,
          order: "newest_first",
          items: command.category === "toolAttempts" ? attempts : [],
          itemCursors: command.category === "toolAttempts" ? attempts.map((_, index) => `attempt-cursor-${index}`) : [],
          total: command.category === "toolAttempts" ? 205 : 0,
          truncated: command.category === "toolAttempts",
          ...(command.category === "toolAttempts" ? { nextCursor: "next_attempt_cursor" } : {})
        } satisfies StorageTracePage;
      }
      throw new Error(`Unexpected storage command: ${command.name}`);
    });

    const detail = await readDurableJobDetail({ request } as unknown as StorageWorkerClient, job(), {
      category: "toolAttempts",
      cursor: "current_attempt_cursor",
      limit: 200
    });

    expect(request).toHaveBeenCalledTimes(7);
    expect(request.mock.calls.map(([command]) => command.name)).toEqual(["trace.summaryJob", ...STORAGE_TRACE_CATEGORIES.map(() => "trace.pageJob")]);
    expect(request).toHaveBeenCalledWith({
      name: "trace.pageJob",
      jobId: "job-1",
      category: "toolAttempts",
      cursor: "current_attempt_cursor",
      limit: 200
    });
    for (const category of STORAGE_TRACE_CATEGORIES.filter((value) => value !== "toolAttempts")) {
      expect(request).toHaveBeenCalledWith({ name: "trace.pageJob", jobId: "job-1", category, limit: 20 });
    }
    expect(detail.trace.toolAttempts).toHaveLength(200);
    expect(detail.traceSummary.total).toBe(205);
    expect(detail.tracePages.toolAttempts).toEqual({
      order: "newest_first",
      total: 205,
      returned: 200,
      truncated: true,
      nextCursor: "next_attempt_cursor"
    });
    expect(detail.traceBudget).toEqual({ maxRecords: 300, maxSerializedBytes: 2_097_152, returned: 200, total: 205, truncated: true });
  });

  it("uses 20-record newest-first previews when no category is selected", async () => {
    const request = vi.fn(async (command: { name: string; category?: StorageTraceCategory }) => {
      if (command.name === "trace.summaryJob") {
        return {
          jobId: "job-1",
          counts: { llmInvocations: 0, toolDecisions: 0, toolAttempts: 0, codexCliExecutions: 0, outputs: 0, networkAudits: 0 },
          total: 0
        };
      }
      if (command.name === "trace.pageJob" && command.category) {
        return { category: command.category, order: "newest_first", items: [], itemCursors: [], total: 0, truncated: false } satisfies StorageTracePage;
      }
      throw new Error(`Unexpected storage command: ${command.name}`);
    });

    await readDurableJobDetail({ request } as unknown as StorageWorkerClient, job());

    expect(request).toHaveBeenCalledTimes(7);
    for (const category of STORAGE_TRACE_CATEGORIES) {
      expect(request).toHaveBeenCalledWith({ name: "trace.pageJob", jobId: "job-1", category, limit: 20 });
    }
  });

  it("fails closed without mutating the cursor when any trace page read fails", async () => {
    const requestOptions = Object.freeze({ category: "outputs" as const, cursor: "stable_cursor", limit: 20 });
    const request = vi.fn(async (command: { name: string; category?: StorageTraceCategory }) => {
      if (command.name === "trace.summaryJob") {
        return {
          jobId: "job-1",
          counts: { llmInvocations: 0, toolDecisions: 0, toolAttempts: 0, codexCliExecutions: 0, outputs: 1, networkAudits: 0 },
          total: 1
        };
      }
      if (command.name === "trace.pageJob" && command.category === "outputs") throw new Error("injected storage read failure");
      if (command.name === "trace.pageJob" && command.category) {
        return { category: command.category, order: "newest_first", items: [], itemCursors: [], total: 0, truncated: false } satisfies StorageTracePage;
      }
      throw new Error(`Unexpected storage command: ${command.name}`);
    });

    await expect(readDurableJobDetail({ request } as unknown as StorageWorkerClient, job(), requestOptions)).rejects.toThrow("injected storage read failure");
    expect(request).toHaveBeenCalledTimes(7);
    expect(requestOptions).toEqual({ category: "outputs", cursor: "stable_cursor", limit: 20 });
  });
});

function job(): DurableJobRecord {
  return {
    id: "job-1",
    projectId: "project-1",
    kind: "research_loop",
    status: "running",
    projectRevision: 1,
    idempotencyKey: "key-1",
    requestHash: "request-hash",
    createdAt: "2026-07-14T00:00:00.000Z",
    updatedAt: "2026-07-14T00:00:00.000Z"
  };
}

function attempt(index: number) {
  return {
    id: `attempt-${index}`,
    projectId: "project-1",
    jobId: "job-1",
    decisionId: `decision-${index}`,
    ordinal: index,
    status: "completed" as const,
    inputHash: `input-${index}`,
    dependsOnAttemptIds: [],
    queuedAt: "2026-07-14T00:00:00.000Z"
  };
}
