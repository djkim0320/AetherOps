import { describe, expect, it, vi } from "vitest";
import { listenHttpServer, type ListenServer } from "./serverListen.js";

describe("listenHttpServer", () => {
  it("runs and awaits full cleanup when listen throws synchronously", async () => {
    const failure = new RangeError("Injected synchronous listen failure.");
    const beforeCleanup = vi.fn();
    let finishCleanup!: () => void;
    const closeResources = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishCleanup = resolve;
        })
    );
    const server: ListenServer = {
      once: vi.fn(),
      off: vi.fn(),
      close: vi.fn(),
      listen: vi.fn(() => {
        throw failure;
      })
    };

    const result = listenHttpServer({ server, port: 5179, host: "127.0.0.1", beforeCleanup, closeResources, onListening: () => "ready" });
    let rejected = false;
    void result.catch(() => {
      rejected = true;
    });
    await Promise.resolve();

    expect(beforeCleanup).toHaveBeenCalledOnce();
    expect(closeResources).toHaveBeenCalledOnce();
    expect(rejected).toBe(false);
    finishCleanup();
    await expect(result).rejects.toBe(failure);
  });

  it("closes the listening server and resources when handle construction fails", async () => {
    const failure = new Error("Injected handle construction failure.");
    const order: string[] = [];
    const server: ListenServer = {
      once: vi.fn(),
      off: vi.fn(),
      listen: vi.fn((_port, _host, listener) => listener()),
      close: vi.fn((listener) => {
        order.push("server");
        listener();
      })
    };

    const result = listenHttpServer({
      server,
      port: 5179,
      host: "127.0.0.1",
      beforeCleanup: () => order.push("prepare"),
      closeResources: async () => {
        order.push("resources");
      },
      onListening: () => {
        throw failure;
      }
    });

    await expect(result).rejects.toBe(failure);
    expect(order).toEqual(["prepare", "server", "resources"]);
  });
});
