import { describe, expect, it, vi } from "vitest";
import { startDurableLeaseRenewal } from "./durableLeaseRenewal.js";
import type { DurableRuntimeTimer } from "./durableRuntimeConfig.js";

describe("durable lease renewal", () => {
  it("never overlaps a slow renewal and schedules only after it settles", async () => {
    const timer = fakeTimer();
    let release!: () => void;
    const renew = vi.fn(() => new Promise<void>((resolve) => (release = resolve)));
    const loop = startDurableLeaseRenewal({ intervalMs: 10, timer, renew, onFailure: vi.fn() });

    timer.fire();
    await flushMicrotasks();
    expect(renew).toHaveBeenCalledOnce();
    expect(timer.pending()).toBe(0);
    release();
    await flushMicrotasks();
    expect(timer.pending()).toBe(1);
    await loop.stop();
  });

  it("observes rejection once and stops renewing", async () => {
    const timer = fakeTimer();
    const failure = new Error("storage unavailable");
    const onFailure = vi.fn();
    const loop = startDurableLeaseRenewal({ intervalMs: 10, timer, renew: () => Promise.reject(failure), onFailure });

    timer.fire();
    await flushMicrotasks();
    expect(onFailure).toHaveBeenCalledWith(failure);
    expect(timer.pending()).toBe(0);
    await loop.stop();
  });

  it("routes a synchronous renewal throw through the same failure boundary", async () => {
    const timer = fakeTimer();
    const failure = new Error("synchronous storage failure");
    const onFailure = vi.fn();
    const loop = startDurableLeaseRenewal({
      intervalMs: 10,
      timer,
      renew: () => {
        throw failure;
      },
      onFailure
    });

    timer.fire();
    await flushMicrotasks();
    expect(onFailure).toHaveBeenCalledWith(failure);
    expect(timer.pending()).toBe(0);
    await loop.stop();
  });

  it("keeps an observer rejection handled until stop reports it", async () => {
    const timer = fakeTimer();
    const observerFailure = new Error("observer failed");
    const loop = startDurableLeaseRenewal({
      intervalMs: 10,
      timer,
      renew: () => Promise.reject(new Error("lease failed")),
      onFailure: () => Promise.reject(observerFailure)
    });

    timer.fire();
    await flushMicrotasks();
    await expect(loop.stop()).rejects.toBe(observerFailure);
  });
});

function fakeTimer(): DurableRuntimeTimer & { fire(): void; pending(): number } {
  const callbacks = new Map<object, () => void>();
  return {
    setTimeout(callback) {
      const handle = {} as ReturnType<typeof setTimeout>;
      callbacks.set(handle, callback);
      return handle;
    },
    clearTimeout(handle) {
      callbacks.delete(handle);
    },
    fire() {
      const entry = callbacks.entries().next().value as [object, () => void] | undefined;
      if (!entry) throw new Error("No timer is pending.");
      callbacks.delete(entry[0]);
      entry[1]();
    },
    pending: () => callbacks.size
  };
}

async function flushMicrotasks(): Promise<void> {
  for (let index = 0; index < 5; index += 1) await Promise.resolve();
}
