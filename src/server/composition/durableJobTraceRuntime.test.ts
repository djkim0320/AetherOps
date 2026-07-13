import { describe, expect, it, vi } from "vitest";
import type { StorageWorkerClient } from "../runtime/storage/worker/typedRuntime.js";
import type { StorageJobEvent } from "../runtime/storage/v2/types.js";
import { DurableJobTraceRuntime } from "./durableJobTraceRuntime.js";

describe("DurableJobTraceRuntime publish boundary", () => {
  it("keeps the committed event replayable when an in-memory subscriber throws", async () => {
    const stored = event();
    const request = vi.fn((command: { name: string }) => Promise.resolve(command.name === "event.after" ? [stored] : stored));
    const publishFailure = vi.fn();
    const runtime = new DurableJobTraceRuntime({ request } as unknown as StorageWorkerClient, publishFailure);
    const observed: number[] = [];
    runtime.subscribe(() => {
      throw new Error("subscriber secret should not escape");
    });
    runtime.subscribe((value) => observed.push(value.id));

    await expect(
      runtime.appendEvent({
        projectId: "project-1",
        projectRevision: 2,
        occurredAt: stored.createdAt,
        type: "run.status.changed",
        data: { jobId: "job-1", status: "running" }
      })
    ).resolves.toMatchObject({ id: 1 });
    expect(publishFailure).toHaveBeenCalledOnce();
    expect(observed).toEqual([1]);
    await expect(runtime.eventsAfter("project-1")).resolves.toEqual([expect.objectContaining({ id: 1 })]);
    expect(request).toHaveBeenLastCalledWith({ name: "event.after", projectId: "project-1", lastEventId: undefined, limit: 200 });
  });

  it("fences worker-generated events and rejects unleased trace writes", async () => {
    const stored = event();
    const request = vi.fn((command: { name: string }) => Promise.resolve(command.name === "fencedTransaction" ? [stored] : stored));
    const runtime = new DurableJobTraceRuntime({ request } as unknown as StorageWorkerClient, vi.fn(), () => ({
      jobId: "job-1",
      attempt: 2,
      leaseOwner: "worker-1",
      leaseGeneration: 3
    }));

    await runtime.appendEvent({
      projectId: "project-1",
      projectRevision: 2,
      occurredAt: stored.createdAt,
      type: "project.snapshot.changed",
      data: { snapshotVersion: 2, reason: "job_changed" }
    });

    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "fencedTransaction",
        fence: expect.objectContaining({ jobId: "job-1", leaseGeneration: 3 }),
        commands: [expect.objectContaining({ name: "event.append", event: expect.objectContaining({ jobId: "job-1" }) })]
      })
    );

    const unleased = new DurableJobTraceRuntime({ request } as unknown as StorageWorkerClient);
    await expect(
      unleased.recordToolDecision({
        id: "decision-1",
        projectId: "project-1",
        jobId: "job-1",
        toolName: "DataAnalysisTool",
        purpose: "Validate evidence.",
        expectedOutcome: "A deterministic validation result.",
        rawSelection: {},
        userPinned: false,
        policyStatus: "accepted",
        createdAt: stored.createdAt
      })
    ).rejects.toThrow(/active lease fence/);
  });

  it("redacts untrusted provider diagnostics before building a storage command", async () => {
    const request = vi.fn((command: { commands?: Array<Record<string, unknown>> }) =>
      Promise.resolve([command.commands?.[0]?.invocation ?? command.commands?.[0]?.decision])
    );
    const runtime = new DurableJobTraceRuntime({ request } as unknown as StorageWorkerClient, vi.fn(), () => ({
      jobId: "job-1",
      attempt: 1,
      leaseOwner: "worker-1",
      leaseGeneration: 1
    }));
    const secret = "Authorization: Bearer provider-token Cookie: session=private C:\\Users\\alice\\secret.txt provider response: raw prompt";

    await runtime.saveLlmInvocation({
      id: "llm-1",
      projectId: "project-1",
      jobId: "job-1",
      model: "gpt-5.6-sol",
      reasoningEffort: "high",
      promptVersion: "planner-v2",
      schemaVersion: "2",
      promptHash: "hash",
      repairCount: 0,
      status: "failed",
      error: secret,
      startedAt: "2026-07-14T00:00:00.000Z",
      data: { prompt: secret, nested: { providerResponse: secret } }
    });

    const serializedCommand = JSON.stringify(request.mock.calls[0]?.[0]);
    expect(serializedCommand).not.toMatch(/provider-token|session=private|alice|raw prompt/);
    expect(serializedCommand).toContain("[redacted]");
  });
});

function event(): StorageJobEvent {
  return {
    sequence: 1,
    eventId: "event-1",
    projectId: "project-1",
    jobId: "job-1",
    type: "run.status.changed",
    payload: { projectRevision: 2, data: { jobId: "job-1", status: "running" } },
    createdAt: "2026-07-14T00:00:00.000Z"
  };
}
