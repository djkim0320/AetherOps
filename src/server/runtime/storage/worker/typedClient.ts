import { randomUUID } from "node:crypto";
import { Worker } from "node:worker_threads";
import { acquireStorageRuntimeOwnerLock } from "./storageOwnerLock.js";
import { sourceAwareWorkerExecArgv, sourceAwareWorkerUrl } from "./sourceWorkerRuntime.js";
import { STORAGE_WORKER_REQUEST, type StorageWorkerCommand, type StorageWorkerInit, type StorageWorkerRequest } from "./typedProtocol.js";
import { isStorageWorkerReady, isStorageWorkerResponse, workerError } from "./workerMessageSupport.js";

export interface StorageWorkerClientOptions {
  requestTimeoutMs?: number;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
  timeout?: ReturnType<typeof setTimeout>;
}

export class StorageWorkerClient {
  private readonly pending = new Map<string, PendingRequest>();
  private readonly requestTimeoutMs: number;
  private closed = false;
  private ownerReleased = false;

  constructor(
    private readonly worker: Worker,
    options: StorageWorkerClientOptions = {},
    private readonly releaseStorageOwner: () => void = () => undefined
  ) {
    this.requestTimeoutMs = options.requestTimeoutMs ?? 60_000;
    this.worker.on("message", this.handleMessage);
    this.worker.on("error", this.rejectAllFromError);
    this.worker.on("exit", this.handleExit);
  }

  request<T = unknown>(command: StorageWorkerCommand, clientRequestId?: string): Promise<T> {
    if (this.closed) return Promise.reject(new Error("Storage worker client is closed."));
    const requestId = randomUUID();
    const message: StorageWorkerRequest = { type: STORAGE_WORKER_REQUEST, requestId, clientRequestId, command };
    return new Promise<T>((resolve, reject) => {
      const timeout =
        this.requestTimeoutMs > 0
          ? setTimeout(() => {
              this.pending.delete(requestId);
              reject(new Error(`Storage worker request timed out: ${requestId}`));
            }, this.requestTimeoutMs)
          : undefined;
      this.pending.set(requestId, { resolve: resolve as (value: unknown) => void, reject, timeout });
      this.worker.postMessage(message);
    });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    try {
      await this.request({ name: "close" });
    } finally {
      this.closed = true;
      this.worker.off("message", this.handleMessage);
      this.worker.off("error", this.rejectAllFromError);
      this.worker.off("exit", this.handleExit);
      await this.worker.terminate();
      this.releaseOwnerOnce();
      this.rejectAll(new Error("Storage worker client closed."));
    }
  }

  private readonly handleMessage = (message: unknown): void => {
    if (isStorageWorkerReady(message)) {
      if (!message.ok) {
        this.closed = true;
        this.releaseOwnerOnce();
        this.rejectAll(workerError(message.error));
      }
      return;
    }
    if (!isStorageWorkerResponse(message)) return;
    const pending = this.pending.get(message.requestId);
    if (!pending) return;
    this.pending.delete(message.requestId);
    if (pending.timeout) clearTimeout(pending.timeout);
    if (message.ok) pending.resolve(message.result);
    else pending.reject(workerError(message.error));
  };

  private readonly rejectAllFromError = (error: Error): void => {
    this.rejectAll(error);
  };

  private readonly handleExit = (code: number): void => {
    this.releaseOwnerOnce();
    if (this.closed) return;
    this.closed = true;
    this.rejectAll(new Error(`Storage worker exited before shutdown: ${code}`));
  };

  private rejectAll(error: Error): void {
    for (const [requestId, pending] of this.pending) {
      this.pending.delete(requestId);
      if (pending.timeout) clearTimeout(pending.timeout);
      pending.reject(error);
    }
  }

  private releaseOwnerOnce(): void {
    if (this.ownerReleased) return;
    this.ownerReleased = true;
    this.releaseStorageOwner();
  }
}

export function createStorageWorkerClient(
  init: StorageWorkerInit,
  options: StorageWorkerClientOptions = {},
  workerUrl: URL | string = sourceAwareWorkerUrl("typedRuntime")
): StorageWorkerClient {
  const releaseStorageOwner = acquireStorageRuntimeOwnerLock(init.appDbPath);
  try {
    const worker = new Worker(workerUrl, { workerData: init, execArgv: sourceAwareWorkerExecArgv() });
    return new StorageWorkerClient(worker, options, releaseStorageOwner);
  } catch (error) {
    releaseStorageOwner();
    throw error;
  }
}
