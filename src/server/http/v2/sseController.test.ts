import { describe, expect, it } from "vitest";
import type { ProjectEventSource } from "./sseController.js";
import { replayThenSubscribe } from "./sseController.js";

type Event = Awaited<ReturnType<ProjectEventSource["eventsAfter"]>>[number];

function event(id: number): Event {
  return { id, projectId: "project-1", type: "run.status.changed", occurredAt: new Date(id).toISOString(), payload: {} } as Event;
}

describe("SSE replay/live handoff", () => {
  it("buffers committed events appended while replay is being read", async () => {
    let listener: ((value: Event) => void) | undefined;
    const source: ProjectEventSource = {
      subscribe(next) {
        listener = next;
        return () => {
          listener = undefined;
        };
      },
      async eventsAfter() {
        listener?.(event(3));
        return [event(1), event(2)];
      }
    };
    const received: number[] = [];
    const unsubscribe = await replayThenSubscribe(source, "project-1", undefined, (value) => received.push(value.id));
    listener?.(event(4));
    expect(received).toEqual([1, 2, 3, 4]);
    unsubscribe();
  });

  it("deduplicates an event visible in both replay and the live buffer", async () => {
    let listener: ((value: Event) => void) | undefined;
    const source: ProjectEventSource = {
      subscribe(next) {
        listener = next;
        return () => {
          listener = undefined;
        };
      },
      async eventsAfter() {
        listener?.(event(2));
        return [event(1), event(2)];
      }
    };
    const received: number[] = [];
    await replayThenSubscribe(source, "project-1", undefined, (value) => received.push(value.id));
    expect(received).toEqual([1, 2]);
  });
});
