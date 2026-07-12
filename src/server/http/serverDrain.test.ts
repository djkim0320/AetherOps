import { EventEmitter } from "node:events";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { describe, expect, it, vi } from "vitest";
import { closeResourcesInOrder, ServerDrainController } from "./serverDrain.js";

describe("ServerDrainController", () => {
  it("returns one shutdown promise and drains an active request before resources", async () => {
    const controller = new ServerDrainController(1_000);
    const server = fakeServer();
    const request = new EventEmitter() as IncomingMessage;
    const response = new EventEmitter() as ServerResponse;
    const lease = controller.begin(request, response);
    const closeResources = vi.fn(async () => undefined);

    const first = controller.shutdown(server.value, closeResources);
    const second = controller.shutdown(server.value, closeResources);
    expect(first).toBe(second);
    expect(controller.state).toBe("DRAINING");
    expect(controller.begin(request, response)).toBeUndefined();
    expect(closeResources).not.toHaveBeenCalled();

    lease?.release();
    await first;

    expect(closeResources).toHaveBeenCalledOnce();
    expect(controller.state).toBe("CLOSED");
  });

  it("forces remaining requests closed after the grace deadline", async () => {
    const controller = new ServerDrainController(5);
    const server = fakeServer();
    const request = Object.assign(new EventEmitter(), { destroy: vi.fn() }) as unknown as IncomingMessage;
    const response = Object.assign(new EventEmitter(), { destroy: vi.fn() }) as unknown as ServerResponse;
    controller.begin(request, response);

    await controller.shutdown(server.value, async () => undefined);

    expect(request.destroy).toHaveBeenCalledOnce();
    expect(response.destroy).toHaveBeenCalledOnce();
    expect(server.closeAllConnections).toHaveBeenCalledOnce();
  });

  it("attempts every resource close and reports all failures", async () => {
    const order: string[] = [];

    const result = closeResourcesInOrder([
      { name: "jobs", close: () => (order.push("jobs"), Promise.reject(new Error("jobs failed"))) },
      { name: "codex", close: () => order.push("codex") },
      { name: "storage", close: () => (order.push("storage"), Promise.reject(new Error("storage failed"))) }
    ]);

    await expect(result).rejects.toThrow("jobs, storage");
    expect(order).toEqual(["jobs", "codex", "storage"]);
  });
});

function fakeServer(): { value: Server; closeAllConnections: ReturnType<typeof vi.fn> } {
  const closeAllConnections = vi.fn();
  return {
    value: {
      close: (callback: (error?: Error) => void) => {
        queueMicrotask(() => callback());
        return undefined as never;
      },
      closeAllConnections
    } as unknown as Server,
    closeAllConnections
  };
}
