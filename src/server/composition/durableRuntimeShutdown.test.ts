import { describe, expect, it } from "vitest";
import type { DurableRuntimeTimer } from "./durableRuntimeConfig.js";
import { waitForActiveRuns } from "./durableRuntimeShutdown.js";

describe("durable runtime shutdown", () => {
  it("waits for every active run to settle before reporting a clean drain", async () => {
    const timer = controlledTimer();
    const first = deferred<void>();
    const second = deferred<void>();
    const result = waitForActiveRuns([first.promise, second.promise], 500, timer);

    first.resolve();
    await flushMicrotasks();
    expect(timer.pending()).toBe(1);

    second.reject(new Error("handler failure during shutdown"));
    await expect(result).resolves.toBe(true);
    expect(timer.pending()).toBe(0);
    expect(timer.cleared()).toBe(1);
  });

  it("returns false when the deterministic timeout wins", async () => {
    const timer = controlledTimer();
    const active = deferred<void>();
    const result = waitForActiveRuns([active.promise], 250, timer);

    expect(timer.delays()).toEqual([250]);
    timer.fireNext();

    await expect(result).resolves.toBe(false);
    expect(timer.pending()).toBe(0);
    expect(timer.cleared()).toBe(1);
  });

  it("does not allocate a timer when there are no active runs", async () => {
    const timer = controlledTimer();

    await expect(waitForActiveRuns([], 250, timer)).resolves.toBe(true);
    expect(timer.pending()).toBe(0);
    expect(timer.delays()).toEqual([]);
    expect(timer.cleared()).toBe(0);
  });
});

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T | PromiseLike<T>): void;
  reject(reason: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((settle, fail) => {
    resolve = settle;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function controlledTimer(): DurableRuntimeTimer & {
  fireNext(): void;
  pending(): number;
  cleared(): number;
  delays(): number[];
} {
  const callbacks = new Map<object, () => void>();
  const observedDelays: number[] = [];
  let cleared = 0;
  return {
    setTimeout(callback, delayMs) {
      const handle = {} as ReturnType<typeof setTimeout>;
      observedDelays.push(delayMs);
      callbacks.set(handle, callback);
      return handle;
    },
    clearTimeout(handle) {
      callbacks.delete(handle);
      cleared += 1;
    },
    fireNext() {
      const entry = callbacks.entries().next().value as [object, () => void] | undefined;
      if (!entry) throw new Error("No timer is pending.");
      callbacks.delete(entry[0]);
      entry[1]();
    },
    pending: () => callbacks.size,
    cleared: () => cleared,
    delays: () => [...observedDelays]
  };
}

async function flushMicrotasks(): Promise<void> {
  for (let index = 0; index < 5; index += 1) await Promise.resolve();
}
