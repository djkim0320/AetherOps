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

  it("replays every committed event across pages larger than 200", async () => {
    const all = Array.from({ length: 450 }, (_, index) => event(index + 1));
    const requestedAfter: number[] = [];
    const source: ProjectEventSource = {
      subscribe() {
        return () => undefined;
      },
      async eventsAfter(_projectId, lastEventId, limit = 200) {
        const after = Number(lastEventId ?? 0);
        requestedAfter.push(after);
        return all.filter((item) => item.id > after).slice(0, limit);
      }
    };
    const received: number[] = [];
    await replayThenSubscribe(source, "project-1", undefined, (value) => received.push(value.id));
    expect(received).toHaveLength(450);
    expect(received[0]).toBe(1);
    expect(received.at(-1)).toBe(450);
    expect(requestedAfter).toEqual([0, 200, 400]);
  });
});
