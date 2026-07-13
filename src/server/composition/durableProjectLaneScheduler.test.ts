import { describe, expect, it, vi } from "vitest";
import { DurableProjectLaneScheduler } from "./durableProjectLaneScheduler.js";

describe("durable project lane scheduler", () => {
  it("guards a project for its full drain and gives each project one job per turn", async () => {
    const drains: string[] = [];
    const pending = new Map<string, Array<Deferred<boolean>>>();
    const scheduler = new DurableProjectLaneScheduler({
      concurrency: 1,
      canRun: () => true,
      drain: (projectId) => {
        drains.push(projectId);
        const next = deferred<boolean>();
        const projectPending = pending.get(projectId) ?? [];
        projectPending.push(next);
        pending.set(projectId, projectPending);
        return next.promise;
      },
      onFailure: vi.fn(),
      onActiveChanged: vi.fn()
    });

    scheduler.schedule("project-a");
    scheduler.schedule("project-a");
    scheduler.schedule("project-b");
    await flushMicrotasks();

    expect(drains).toEqual(["project-a"]);
    expect([...scheduler.activePromises()]).toHaveLength(1);

    pending.get("project-a")?.[0]?.resolve(true);
    await flushMicrotasks();
    expect(drains).toEqual(["project-a", "project-b"]);

    pending.get("project-b")?.[0]?.resolve(false);
    await flushMicrotasks();
    expect(drains).toEqual(["project-a", "project-b", "project-a"]);

    pending.get("project-a")?.[1]?.resolve(false);
    await flushMicrotasks();
    expect([...scheduler.activePromises()]).toHaveLength(0);
  });

  it("runs different projects up to the bounded concurrency limit", async () => {
    const pending = new Map<string, Deferred<boolean>>();
    let active = 0;
    let maximumActive = 0;
    const started: string[] = [];
    const scheduler = new DurableProjectLaneScheduler({
      concurrency: 2,
      canRun: () => true,
      drain: (projectId) => {
        started.push(projectId);
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        const next = deferred<boolean>();
        pending.set(projectId, next);
        return next.promise.finally(() => {
          active -= 1;
        });
      },
      onFailure: vi.fn(),
      onActiveChanged: vi.fn()
    });

    scheduler.schedule("project-a");
    scheduler.schedule("project-b");
    scheduler.schedule("project-c");
    await flushMicrotasks();

    expect(started).toEqual(["project-a", "project-b"]);
    expect(maximumActive).toBe(2);

    pending.get("project-a")?.resolve(false);
    await flushMicrotasks();
    expect(started).toEqual(["project-a", "project-b", "project-c"]);
    expect(maximumActive).toBe(2);

    pending.get("project-b")?.resolve(false);
    pending.get("project-c")?.resolve(false);
    await flushMicrotasks();
    expect([...scheduler.activePromises()]).toHaveLength(0);
  });

  it("cleans up a rejected drain before starting the next project", async () => {
    const failure = new Error("storage unavailable");
    const onFailure = vi.fn();
    const started: string[] = [];
    const scheduler = new DurableProjectLaneScheduler({
      concurrency: 1,
      canRun: () => true,
      drain: (projectId) => {
        started.push(projectId);
        return projectId === "project-a" ? Promise.reject(failure) : Promise.resolve(false);
      },
      onFailure,
      onActiveChanged: vi.fn()
    });

    scheduler.schedule("project-a");
    scheduler.schedule("project-b");
    await flushMicrotasks();

    expect(onFailure).toHaveBeenCalledExactlyOnceWith(failure, "project-a");
    expect(started).toEqual(["project-a", "project-b"]);
    expect([...scheduler.activePromises()]).toHaveLength(0);
  });

  it("cleans up when drain throws before returning a promise", async () => {
    const failure = new Error("synchronous storage failure");
    const onFailure = vi.fn();
    const started: string[] = [];
    const scheduler = new DurableProjectLaneScheduler({
      concurrency: 1,
      canRun: () => true,
      drain: (projectId) => {
        started.push(projectId);
        if (projectId === "project-a") throw failure;
        return Promise.resolve(false);
      },
      onFailure,
      onActiveChanged: vi.fn()
    });

    scheduler.schedule("project-a");
    scheduler.schedule("project-b");
    await flushMicrotasks();

    expect(onFailure).toHaveBeenCalledExactlyOnceWith(failure, "project-a");
    expect(started).toEqual(["project-a", "project-b"]);
    expect([...scheduler.activePromises()]).toHaveLength(0);
  });
});

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

async function flushMicrotasks(): Promise<void> {
  for (let index = 0; index < 8; index += 1) await Promise.resolve();
}
