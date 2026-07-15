import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SseRuntimeDiagnostics } from "../../composition/sseRuntimeDiagnostics.js";
import { HttpError } from "../response.js";
import type { ProjectEventSource } from "./sseController.js";
import { replayThenSubscribe, serveProjectEvents, SseConnectionLimiter } from "./sseController.js";

type Event = Awaited<ReturnType<ProjectEventSource["eventsAfter"]>>[number];

function event(id: number): Event {
  return {
    id,
    projectId: "project-1",
    projectRevision: id,
    type: "run.status.changed",
    occurredAt: new Date(id).toISOString(),
    data: { jobId: "job-1", status: "running" }
  } as Event;
}

afterEach(() => vi.useRealTimers());

describe("SSE replay/live handoff", () => {
  it("buffers committed events appended while replay is being read", async () => {
    let listener: ((value: Event) => void) | undefined;
    const source = eventSource({
      onSubscribe: (next) => (listener = next),
      eventsAfter: async () => {
        listener?.(event(3));
        return [event(1), event(2)];
      }
    });
    const received: number[] = [];
    const unsubscribe = await replayThenSubscribe(source, "project-1", undefined, (value) => received.push(value.id));
    listener?.(event(4));
    await flushMicrotasks();
    expect(received).toEqual([1, 2, 3, 4]);
    unsubscribe();
  });

  it("deduplicates events visible in replay and live delivery and preserves monotonic IDs", async () => {
    let listener: ((value: Event) => void) | undefined;
    const source = eventSource({
      onSubscribe: (next) => (listener = next),
      eventsAfter: async (_projectId, lastEventId) => {
        if (Number(lastEventId ?? 0) > 0) return [];
        listener?.(event(2));
        return [event(1), event(2)];
      }
    });
    const received: number[] = [];
    await replayThenSubscribe(source, "project-1", undefined, (value) => received.push(value.id));
    listener?.(event(4));
    listener?.(event(3));
    listener?.(event(4));
    listener?.(event(100));
    await flushMicrotasks();
    expect(received).toEqual([1, 2, 4, 100]);
  });

  it("queries durable storage to fill a live sequence gap before emitting the live event", async () => {
    let listener: ((value: Event) => void) | undefined;
    const requestedAfter: number[] = [];
    const source = eventSource({
      onSubscribe: (next) => (listener = next),
      eventsAfter: async (_projectId, lastEventId) => {
        const after = Number(lastEventId ?? 0);
        requestedAfter.push(after);
        return after === 0 ? [event(1)] : [event(2), event(3)];
      }
    });
    const received: number[] = [];
    const unsubscribe = await replayThenSubscribe(source, "project-1", undefined, (value) => received.push(value.id));
    listener?.(event(3));
    await flushMicrotasks();
    expect(received).toEqual([1, 2, 3]);
    expect(requestedAfter).toEqual([0, 1]);
    unsubscribe();
  });

  it("applies the replay event budget to live gap catch-up", async () => {
    let listener: ((value: Event) => void) | undefined;
    let failure: Error | undefined;
    const source = eventSource({
      onSubscribe: (next) => (listener = next),
      eventsAfter: async (_projectId, lastEventId) => (Number(lastEventId ?? 0) === 0 ? [event(1)] : [event(2), event(3)])
    });
    const received: number[] = [];
    await replayThenSubscribe(source, "project-1", undefined, (value) => received.push(value.id), {
      maxReplayEvents: 1,
      onError: (error) => (failure = error)
    });
    listener?.(event(3));
    await flushMicrotasks();
    expect(failure?.message).toMatch(/replay/i);
    expect(received).toEqual([1, 2]);
  });

  it("passes an AbortSignal to live gap catch-up and aborts it on disconnect", async () => {
    let listener: ((value: Event) => void) | undefined;
    let catchUpSignal: AbortSignal | undefined;
    const catchUp = deferred<Event[]>();
    const controller = new AbortController();
    const source = eventSource({
      onSubscribe: (next) => (listener = next),
      eventsAfter: async (_projectId, lastEventId, _limit, signal) => {
        if (Number(lastEventId ?? 0) === 0) return [event(1)];
        catchUpSignal = signal;
        return catchUp.promise;
      }
    });
    const unsubscribe = await replayThenSubscribe(source, "project-1", undefined, () => undefined, { signal: controller.signal });
    listener?.(event(3));
    await flushMicrotasks();
    controller.abort(new Error("test disconnect"));
    expect(catchUpSignal?.aborted).toBe(true);
    catchUp.resolve([]);
    await flushMicrotasks();
    unsubscribe();
  });

  it("replays every committed event across pages larger than 200", async () => {
    const all = Array.from({ length: 450 }, (_, index) => event(index + 1));
    const requestedAfter: number[] = [];
    const source = eventSource({
      eventsAfter: async (_projectId, lastEventId, limit = 200) => {
        const after = Number(lastEventId ?? 0);
        requestedAfter.push(after);
        return all.filter((item) => item.id > after).slice(0, limit);
      }
    });
    const received: number[] = [];
    await replayThenSubscribe(source, "project-1", undefined, (value) => received.push(value.id));
    expect(received).toHaveLength(450);
    expect(received[0]).toBe(1);
    expect(received.at(-1)).toBe(450);
    expect(requestedAfter).toEqual([0, 200, 400]);
  });

  it("fails closed when the replay page makes no sequence progress", async () => {
    let calls = 0;
    const source = eventSource({
      eventsAfter: async () => {
        calls++;
        if (calls > 3) throw new Error("test query guard");
        return Array.from({ length: 200 }, () => event(1));
      }
    });
    await expect(replayThenSubscribe(source, "project-1", "1", () => undefined)).rejects.toThrow(/progress/i);
    expect(calls).toBeLessThanOrEqual(1);
  });

  it("bounds events buffered while replay is in progress", async () => {
    let listener: ((value: Event) => void) | undefined;
    const source = eventSource({
      onSubscribe: (next) => (listener = next),
      eventsAfter: async () => {
        listener?.(event(1));
        listener?.(event(2));
        listener?.(event(3));
        return [];
      }
    });
    await expect(
      replayThenSubscribe(source, "project-1", undefined, () => undefined, {
        maxBufferedEvents: 2,
        maxBufferedBytes: 1_000_000
      })
    ).rejects.toThrow(/buffer/i);
  });

  it("bounds bytes buffered while replay is in progress", async () => {
    let listener: ((value: Event) => void) | undefined;
    const source = eventSource({
      onSubscribe: (next) => (listener = next),
      eventsAfter: async () => {
        listener?.(event(1));
        return [];
      }
    });
    await expect(replayThenSubscribe(source, "project-1", undefined, () => undefined, { maxBufferedEvents: 10, maxBufferedBytes: 1 })).rejects.toThrow(
      /buffer/i
    );
  });

  it("bounds total replay events without partially emitting the next event", async () => {
    const source = eventSource({ eventsAfter: async () => [event(1), event(2), event(3)] });
    const received: number[] = [];
    await expect(
      replayThenSubscribe(source, "project-1", undefined, (value) => received.push(value.id), { maxReplayEvents: 2, maxReplayBytes: 1_000_000 })
    ).rejects.toThrow(/replay/i);
    expect(received).toEqual([1, 2]);
  });

  it("bounds replay bytes before emitting an oversized event", async () => {
    const source = eventSource({ eventsAfter: async () => [event(1)] });
    const received: number[] = [];
    await expect(replayThenSubscribe(source, "project-1", undefined, (value) => received.push(value.id), { maxReplayBytes: 1 })).rejects.toThrow(/replay/i);
    expect(received).toEqual([]);
  });

  it("uses an injected clock to enforce replay duration without sleeping", async () => {
    let clock = 0;
    const source = eventSource({
      eventsAfter: async () => {
        clock = 2;
        return [event(1)];
      }
    });
    await expect(replayThenSubscribe(source, "project-1", undefined, () => undefined, { maxReplayDurationMs: 1, now: () => clock })).rejects.toThrow(
      /duration/i
    );
  });

  it("rejects a replay whose emitter remains blocked past the duration budget", async () => {
    vi.useFakeTimers();
    const source = eventSource({ eventsAfter: async () => [event(1)] });
    const replay = replayThenSubscribe(source, "project-1", undefined, () => new Promise<void>(() => undefined), { maxReplayDurationMs: 1_000 });
    const observed = replay.catch((error: unknown) => error);

    await vi.advanceTimersByTimeAsync(1_000);

    await expect(observed).resolves.toMatchObject({ message: expect.stringMatching(/duration/i) });
  });

  it("records replay count, rows, and injected-clock duration without retaining labels", async () => {
    let clock = 100;
    const diagnostics = new SseRuntimeDiagnostics();
    const source = eventSource({ eventsAfter: async () => [event(1), event(2)] });

    const unsubscribe = await replayThenSubscribe(
      source,
      "project-1",
      undefined,
      () => {
        clock += 4;
      },
      { now: () => clock, observer: diagnostics }
    );

    expect(diagnostics.snapshot()).toMatchObject({ replayCount: 1, replayedEventCount: 2, replayTotalDurationMs: 8, replayMaxDurationMs: 8 });
    expect(JSON.stringify(diagnostics.snapshot())).not.toMatch(/project|job|url|payload/i);
    unsubscribe();
  });
});

describe("SSE connection lifecycle", () => {
  it.each(["NaN", "Infinity", "1.5", "-1", "1e3", "9007199254740992", "+1", " 1 "])(
    "rejects invalid Last-Event-ID %j before subscribing or querying",
    async (lastEventId) => {
      let subscriptions = 0;
      let queries = 0;
      const source = eventSource({
        onSubscribe: () => subscriptions++,
        eventsAfter: async () => {
          queries++;
          return [];
        }
      });
      const request = new FakeRequest({ "last-event-id": lastEventId });
      const response = new FakeResponse();
      await expect(
        serveProjectEvents(request.asIncoming(), response.asServer(), projectUrl(), source, { limiter: new SseConnectionLimiter(2, 2) })
      ).rejects.toMatchObject({ status: 400 } satisfies Partial<HttpError>);
      expect({ subscriptions, queries, writes: response.writes.length }).toEqual({ subscriptions: 0, queries: 0, writes: 0 });
    }
  );

  it("unsubscribes immediately when the request closes during replay", async () => {
    const replay = deferred<Event[]>();
    let unsubscribed = 0;
    let queries = 0;
    const source = eventSource({
      onUnsubscribe: () => unsubscribed++,
      eventsAfter: async () => {
        queries++;
        return replay.promise;
      }
    });
    const request = new FakeRequest();
    const response = new FakeResponse();
    const close = await serveProjectEvents(request.asIncoming(), response.asServer(), projectUrl(), source, {
      limiter: new SseConnectionLimiter(2, 2)
    });
    request.emit("close");
    expect(queries).toBe(1);
    expect(unsubscribed).toBe(1);
    replay.resolve([]);
    await flushMicrotasks();
    close();
    expect(unsubscribed).toBe(1);
  });

  it("settles replay cancellation even when an in-flight query ignores the AbortSignal", async () => {
    const query = deferred<Event[]>();
    const controller = new AbortController();
    const source = eventSource({ eventsAfter: async () => query.promise });
    let rejected = false;
    const replay = replayThenSubscribe(source, "project-1", undefined, () => undefined, { signal: controller.signal }).catch((error: unknown) => {
      rejected = true;
      throw error;
    });
    await flushMicrotasks();

    controller.abort(new Error("test disconnect"));
    await flushMicrotasks();
    expect(rejected).toBe(true);

    query.resolve([]);
    await expect(replay).rejects.toThrow("test disconnect");
  });

  it("serializes writes and waits for drain before writing the next event", async () => {
    const source = eventSource({ eventsAfter: async () => [event(1), event(2)] });
    const request = new FakeRequest();
    const response = new FakeResponse([false, true]);
    const close = await serveProjectEvents(request.asIncoming(), response.asServer(), projectUrl(), source, {
      limiter: new SseConnectionLimiter(2, 2)
    });
    await flushMicrotasks();
    expect(response.writes).toHaveLength(1);
    response.emit("drain");
    await flushMicrotasks();
    expect(response.writes).toHaveLength(2);
    expect(response.writes[0]).toContain("id: 1");
    expect(response.writes[1]).toContain("id: 2");
    close();
  });

  it("closes a slow live connection when its event buffer budget is exhausted", async () => {
    let listener: ((value: Event) => void) | undefined;
    let unsubscribed = 0;
    const source = eventSource({
      onSubscribe: (next) => (listener = next),
      onUnsubscribe: () => unsubscribed++,
      eventsAfter: async () => []
    });
    const request = new FakeRequest();
    const response = new FakeResponse([false]);
    const diagnostics = new SseRuntimeDiagnostics();
    const close = await serveProjectEvents(request.asIncoming(), response.asServer(), projectUrl(), source, {
      limiter: new SseConnectionLimiter(2, 2),
      maxBufferedEvents: 1,
      maxBufferedBytes: 1_000_000,
      diagnostics
    });
    await flushMicrotasks();
    listener?.(event(1));
    await flushMicrotasks();
    listener?.(event(2));
    await flushMicrotasks();
    expect(response.writes).toHaveLength(1);
    expect(response.writableEnded).toBe(true);
    expect(unsubscribed).toBe(1);
    expect(diagnostics.snapshot()).toMatchObject({ activeConnectionCount: 0, bufferedEventCount: 0, bufferedBytes: 0, slowConsumerDisconnectCount: 1 });
    expect(diagnostics.snapshot().peakBufferedEventCount).toBeGreaterThan(0);
    close();
  });

  it("closes a connection when socket backpressure never emits drain", async () => {
    vi.useFakeTimers();
    let unsubscribed = 0;
    const source = eventSource({ eventsAfter: async () => [event(1)], onUnsubscribe: () => unsubscribed++ });
    const request = new FakeRequest();
    const response = new FakeResponse([false]);
    const diagnostics = new SseRuntimeDiagnostics();
    const close = await serveProjectEvents(request.asIncoming(), response.asServer(), projectUrl(), source, {
      limiter: new SseConnectionLimiter(2, 2),
      maxDrainDurationMs: 1_000,
      diagnostics
    });
    await flushMicrotasks();

    await vi.advanceTimersByTimeAsync(1_000);
    await flushMicrotasks();

    expect(response.writableEnded).toBe(true);
    expect(unsubscribed).toBe(1);
    expect(diagnostics.snapshot()).toMatchObject({ activeConnectionCount: 0, slowConsumerDisconnectCount: 1 });
    close();
  });

  it("routes heartbeats through the same backpressured writer queue", async () => {
    vi.useFakeTimers();
    const source = eventSource({ eventsAfter: async () => [] });
    const request = new FakeRequest();
    const response = new FakeResponse([false, true]);
    const close = await serveProjectEvents(request.asIncoming(), response.asServer(), projectUrl(), source, {
      limiter: new SseConnectionLimiter(2, 2),
      heartbeatMs: 1_000
    });
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(response.writes).toEqual([": heartbeat\n\n"]);
    response.emit("drain");
    await flushMicrotasks();
    expect(response.writes).toEqual([": heartbeat\n\n", ": heartbeat\n\n"]);
    close();
  });

  it("cleans up a heartbeat blocked on backpressure when the socket errors", async () => {
    vi.useFakeTimers();
    let unsubscribed = 0;
    const source = eventSource({ eventsAfter: async () => [], onUnsubscribe: () => unsubscribed++ });
    const request = new FakeRequest();
    const response = new FakeResponse([false]);
    const close = await serveProjectEvents(request.asIncoming(), response.asServer(), projectUrl(), source, {
      limiter: new SseConnectionLimiter(2, 2),
      heartbeatMs: 1_000
    });
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(1_000);
    response.emit("error", new Error("test socket error"));
    await flushMicrotasks();
    expect(response.writableEnded).toBe(true);
    expect(unsubscribed).toBe(1);
    close();
  });

  it("enforces global and per-project connection caps and releases slots once", async () => {
    const limiter = new SseConnectionLimiter(2, 1);
    const source = eventSource({ eventsAfter: async () => [] });
    const firstRequest = new FakeRequest();
    const firstResponse = new FakeResponse();
    const closeFirst = await serveProjectEvents(firstRequest.asIncoming(), firstResponse.asServer(), projectUrl(), source, { limiter });
    const rejectedResponse = new FakeResponse();
    await expect(serveProjectEvents(new FakeRequest().asIncoming(), rejectedResponse.asServer(), projectUrl(), source, { limiter })).rejects.toMatchObject({
      status: 429
    });
    expect(rejectedResponse.headers.get("retry-after")).toBe("1");
    closeFirst();
    closeFirst();
    const closeReplacement = await serveProjectEvents(new FakeRequest().asIncoming(), new FakeResponse().asServer(), projectUrl(), source, { limiter });
    closeReplacement();
  });

  it("enforces the global connection cap across projects", async () => {
    const limiter = new SseConnectionLimiter(2, 2);
    const source = eventSource({ eventsAfter: async () => [] });
    const closeFirst = await serveProjectEvents(new FakeRequest().asIncoming(), new FakeResponse().asServer(), projectUrl("project-1"), source, { limiter });
    const closeSecond = await serveProjectEvents(new FakeRequest().asIncoming(), new FakeResponse().asServer(), projectUrl("project-2"), source, { limiter });
    await expect(
      serveProjectEvents(new FakeRequest().asIncoming(), new FakeResponse().asServer(), projectUrl("project-3"), source, { limiter })
    ).rejects.toMatchObject({ status: 429 });
    closeFirst();
    closeSecond();
  });
});

function eventSource(input: {
  eventsAfter: ProjectEventSource["eventsAfter"];
  onSubscribe?: (listener: (event: Event) => void) => void;
  onUnsubscribe?: () => void;
}): ProjectEventSource {
  return {
    eventsAfter: input.eventsAfter,
    subscribe(listener) {
      input.onSubscribe?.(listener);
      let active = true;
      return () => {
        if (!active) return;
        active = false;
        input.onUnsubscribe?.();
      };
    }
  };
}

class FakeRequest extends EventEmitter {
  constructor(readonly headers: IncomingMessage["headers"] = {}) {
    super();
  }
  asIncoming(): IncomingMessage {
    return this as unknown as IncomingMessage;
  }
}

class FakeResponse extends EventEmitter {
  readonly writes: string[] = [];
  readonly headers = new Map<string, string | number | readonly string[]>();
  headersSent = false;
  writableEnded = false;
  destroyed = false;

  constructor(private readonly writeResults: boolean[] = []) {
    super();
  }
  setHeader(name: string, value: string | number | readonly string[]): this {
    this.headers.set(name.toLowerCase(), value);
    return this;
  }
  writeHead(): this {
    this.headersSent = true;
    return this;
  }
  flushHeaders(): void {
    this.headersSent = true;
  }
  write(value: string): boolean {
    this.writes.push(String(value));
    return this.writeResults.shift() ?? true;
  }
  end(): this {
    this.writableEnded = true;
    return this;
  }
  destroy(): this {
    this.destroyed = true;
    return this;
  }
  asServer(): ServerResponse {
    return this as unknown as ServerResponse;
  }
}

function projectUrl(projectId = "project-1"): URL {
  return new URL(`http://127.0.0.1/api/v2/events?projectId=${projectId}`);
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => (resolve = next));
  return { promise, resolve };
}

async function flushMicrotasks(): Promise<void> {
  for (let turn = 0; turn < 50; turn++) await Promise.resolve();
}
