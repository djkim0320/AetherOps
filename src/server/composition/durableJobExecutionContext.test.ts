import { describe, expect, it } from "vitest";
import type { DurableJobRecord } from "./durableJobTypes.js";
import { DurableJobExecutionContext } from "./durableJobExecutionContext.js";

describe("durable job execution context", () => {
  it("defers a terminal outcome while retaining the leased execution scope", async () => {
    const context = new DurableJobExecutionContext();
    const controller = new AbortController();
    await context.run({ job: job(), fence: { jobId: "job-1", attempt: 1, leaseOwner: "worker-1", leaseGeneration: 2 }, controller }, async () => {
      const projected = context.settle("job-1", { status: "completed", projectRevision: 4 });
      expect(projected.status).toBe("completed");
      expect(context.current("job-1")?.outcome).toEqual({ status: "completed", projectRevision: 4 });
    });
  });

  it("aborts and rejects every later write after lease loss", async () => {
    const context = new DurableJobExecutionContext();
    const controller = new AbortController();
    await context.run({ job: job(), fence: { jobId: "job-1", attempt: 1, leaseOwner: "worker-1", leaseGeneration: 2 }, controller }, async () => {
      context.markLeaseLost("job-1", new Error("fence mismatch"));
      expect(controller.signal.aborted).toBe(true);
      expect(() => context.require("job-1")).toThrow(/lease was lost/i);
    });
  });

  it("carries a bound canonical transition into fallback terminal outcomes", async () => {
    const context = new DurableJobExecutionContext();
    const controller = new AbortController();
    const transition = {
      owner: { projectId: "project-1", runId: "run-1", jobId: "job-1" },
      prepareRevision: async () => {
        throw new Error("not invoked by the execution-context projection");
      }
    };
    await context.run({ job: job(), fence: { jobId: "job-1", attempt: 1, leaseOwner: "worker-1", leaseGeneration: 2 }, controller }, async () => {
      context.bindCanonicalTransition("job-1", transition);
      context.settle("job-1", { status: "failed", projectRevision: 4, reason: "failed" });
      expect(context.current("job-1")?.outcome?.canonicalTransition).toBe(transition);
    });
  });
});

function job(): DurableJobRecord {
  return {
    id: "job-1",
    projectId: "project-1",
    kind: "chat_reply",
    status: "running",
    projectRevision: 3,
    idempotencyKey: "key-1",
    createdAt: "2026-07-14T00:00:00.000Z",
    updatedAt: "2026-07-14T00:00:00.000Z"
  };
}
