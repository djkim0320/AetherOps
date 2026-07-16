import { describe, expect, it, vi } from "vitest";
import type { StorageWorkerClient } from "../runtime/storage/worker/typedRuntime.js";
import type { StorageJobEvent, StorageJobEventInput } from "../runtime/storage/v2/types.js";
import type { StorageToolAttempt } from "../runtime/storage/v2/traceTypes.js";
import { DurableJobTraceRuntime } from "./durableJobTraceRuntime.js";

describe("DurableJobTraceRuntime publish boundary", () => {
  it("publishes each committed sequence at most once per batch", () => {
    const runtime = new DurableJobTraceRuntime({ request: vi.fn() } as unknown as StorageWorkerClient);
    const observed: number[] = [];
    const first = event();
    const second = { ...event(), sequence: 2, eventId: "event-2" };
    runtime.subscribe((value) => observed.push(value.id));

    runtime.publishStoredEvents([first, { ...first }, second]);

    expect(observed).toEqual([1, 2]);
  });

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
      runtime.appendEvent(
        {
          projectId: "project-1",
          projectRevision: 2,
          occurredAt: stored.createdAt,
          type: "run.status.changed",
          data: { jobId: "job-1", status: "running" }
        },
        `event:${"a".repeat(64)}`,
        "b".repeat(64)
      )
    ).resolves.toMatchObject({ id: 1 });
    expect(request).toHaveBeenNthCalledWith(1, {
      name: "event.append",
      event: expect.objectContaining({ eventId: `event:${"a".repeat(64)}`, payload: expect.objectContaining({ mutationHash: "b".repeat(64) }) })
    });
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

  it("uses attempt id and status as the stable event identity in the atomic trace write", async () => {
    const eventInputs: StorageJobEventInput[] = [];
    let sequence = 0;
    const request = vi.fn((command: unknown) => {
      const transaction = command as {
        commands: [{ attempt: StorageToolAttempt }, { event: StorageJobEventInput }];
      };
      const attempt = transaction.commands[0].attempt;
      const input = transaction.commands[1].event;
      eventInputs.push(input);
      sequence += 1;
      return Promise.resolve([
        attempt,
        {
          sequence,
          eventId: String(input.eventId),
          projectId: input.projectId,
          jobId: input.jobId,
          type: input.type,
          payload: input.payload,
          createdAt: String(input.createdAt)
        } satisfies StorageJobEvent
      ]);
    });
    const runtime = new DurableJobTraceRuntime({ request } as unknown as StorageWorkerClient, vi.fn(), () => ({
      jobId: "job-1",
      attempt: 1,
      leaseOwner: "worker-1",
      leaseGeneration: 1
    }));
    const queued: StorageToolAttempt = {
      id: "attempt-1",
      projectId: "project-1",
      jobId: "job-1",
      decisionId: "decision-1",
      ordinal: 0,
      status: "queued",
      inputHash: "c".repeat(64),
      dependsOnAttemptIds: [],
      queuedAt: "2026-07-16T00:00:00.000Z"
    };

    await runtime.recordToolAttemptAndEvent({ attempt: queued, projectRevision: 1, toolName: "WebFetchTool" });
    await runtime.recordToolAttemptAndEvent({ attempt: { ...queued }, projectRevision: 1, toolName: "WebFetchTool" });
    await runtime.recordToolAttemptAndEvent({
      attempt: { ...queued, status: "running", startedAt: "2026-07-16T00:00:01.000Z" },
      projectRevision: 2,
      toolName: "WebFetchTool"
    });

    expect(eventInputs[0]?.eventId).toBe(eventInputs[1]?.eventId);
    expect(eventInputs[2]?.eventId).not.toBe(eventInputs[0]?.eventId);
    expect(eventInputs.map((input) => input.eventId)).toEqual([
      expect.stringMatching(/^event:[a-f0-9]{64}$/),
      expect.stringMatching(/^event:[a-f0-9]{64}$/),
      expect.stringMatching(/^event:[a-f0-9]{64}$/)
    ]);
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
