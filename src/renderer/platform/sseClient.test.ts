/* @vitest-environment jsdom */

import { waitFor } from "@testing-library/react";
import { connectProjectEventStream, type ProjectEventStreamState } from "./sseClient.js";

const timestamp = "2026-07-10T00:00:00.000Z";

describe("project SSE gap detection", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("accepts gaps in globally allocated event IDs when the project revision is continuous", async () => {
    const states: ProjectEventStreamState[] = [];
    const events = [event(1, 2), event(10, 3)];
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response(events)));

    const disconnect = connectProjectEventStream({
      url: "/api/v2/events?projectId=project-1",
      initialRevision: 1,
      onEvent: vi.fn(),
      onStateChange: (state) => states.push(state)
    });

    await waitFor(() => expect(states.some((state) => state.lastEventId === 10 && state.status === "open")).toBe(true));
    expect(states.some((state) => state.status === "gap")).toBe(false);
    disconnect();
  });

  it("requests a snapshot refresh when the project revision skips", async () => {
    const states: ProjectEventStreamState[] = [];
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response([event(20, 4)])));

    const disconnect = connectProjectEventStream({
      url: "/api/v2/events?projectId=project-1",
      initialRevision: 1,
      onEvent: vi.fn(),
      onStateChange: (state) => states.push(state)
    });

    await waitFor(() => expect(states.some((state) => state.status === "gap")).toBe(true));
    disconnect();
  });
});

function event(id: number, projectRevision: number) {
  return {
    id,
    projectId: "project-1",
    projectRevision,
    occurredAt: timestamp,
    type: "project.snapshot.changed",
    data: { snapshotVersion: projectRevision, reason: "job_changed" }
  };
}

function response(events: unknown[]): Response {
  const body = `${events.map((entry) => `id: ${String((entry as { id: number }).id)}\ndata: ${JSON.stringify(entry)}\n\n`).join("")}`;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(body));
      controller.close();
    }
  });
  return new Response(stream, { status: 200, headers: { "Content-Type": "text/event-stream" } });
}
