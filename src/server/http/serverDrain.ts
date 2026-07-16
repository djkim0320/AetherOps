import type { IncomingMessage, Server, ServerResponse } from "node:http";
export { closeResourcesInOrder, rethrowAfterStartupCleanup } from "../composition/runtimeResourceCleanup.js";

export type ServerLifecycleState = "RUNNING" | "DRAINING" | "CLOSING_RESOURCES" | "CLOSED";

export interface DrainLease {
  release(): void;
}

interface ActiveRequest {
  request: IncomingMessage;
  response: ServerResponse;
}

export class ServerDrainController {
  private lifecycleState: ServerLifecycleState = "RUNNING";
  private readonly active = new Map<symbol, ActiveRequest>();
  private readonly sseConnections = new Map<ServerResponse, () => void>();
  private activeWaiter: (() => void) | undefined;
  private shutdownPromise: Promise<void> | undefined;

  constructor(private readonly graceMs: number) {}

  get state(): ServerLifecycleState {
    return this.lifecycleState;
  }

  begin(request: IncomingMessage, response: ServerResponse): DrainLease | undefined {
    if (this.lifecycleState !== "RUNNING") return undefined;
    const id = Symbol("request");
    this.active.set(id, { request, response });
    let released = false;
    return {
      release: () => {
        if (released) return;
        released = true;
        this.active.delete(id);
        if (this.active.size === 0) this.activeWaiter?.();
      }
    };
  }

  trackSse(response: ServerResponse, cleanup: () => void): void {
    if (this.lifecycleState !== "RUNNING") {
      cleanup();
      response.end();
      return;
    }
    this.sseConnections.set(response, cleanup);
    response.once("close", () => this.sseConnections.delete(response));
  }

  shutdown(server: Server, closeResources: () => Promise<void>): Promise<void> {
    this.shutdownPromise ??= this.performShutdown(server, closeResources);
    return this.shutdownPromise;
  }

  private async performShutdown(server: Server, closeResources: () => Promise<void>): Promise<void> {
    this.lifecycleState = "DRAINING";
    const serverClosed = new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    this.closeSseConnections();
    const drained = await this.waitForActiveRequests();
    if (!drained) {
      for (const { request, response } of this.active.values()) {
        response.destroy();
        request.destroy();
      }
      this.active.clear();
      server.closeAllConnections?.();
    }
    this.lifecycleState = "CLOSING_RESOURCES";
    let resourceError: unknown;
    try {
      await closeResources();
    } catch (error) {
      resourceError = error;
    }
    await serverClosed;
    this.lifecycleState = "CLOSED";
    if (resourceError !== undefined) throw resourceError;
  }

  private closeSseConnections(): void {
    for (const [response, cleanup] of this.sseConnections) {
      cleanup();
      response.end();
    }
    this.sseConnections.clear();
  }

  private waitForActiveRequests(): Promise<boolean> {
    if (this.active.size === 0) return Promise.resolve(true);
    return new Promise((resolve) => {
      let settled = false;
      const finish = (drained: boolean): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        this.activeWaiter = undefined;
        resolve(drained);
      };
      const timeout = setTimeout(() => finish(false), this.graceMs);
      timeout.unref();
      this.activeWaiter = () => finish(true);
    });
  }
}
