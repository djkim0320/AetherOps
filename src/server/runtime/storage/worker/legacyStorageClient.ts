import { randomUUID } from "node:crypto";
import { Worker } from "node:worker_threads";
import type { ResearchStore } from "../../../../core/shared/types.js";
import type { ProjectStorage } from "../../../../core/storage/projectStorage.js";
import type { AppSettingsStore } from "../settingsStore.js";
import {
  PROJECT_STORAGE_METHODS,
  RESEARCH_STORE_METHODS,
  SETTINGS_STORE_METHODS,
  type LegacyStorageRequest,
  type LegacyStorageResponse,
  type LegacyStorageTarget
} from "./legacyStorageProtocol.js";
import { sourceAwareWorkerExecArgv, sourceAwareWorkerUrl } from "./sourceWorkerRuntime.js";

export interface LegacyStorageWorkerHandle {
  researchStore: ResearchStore;
  projectStorage: ProjectStorage;
  settingsStore: AppSettingsStore;
  close(): Promise<void>;
}

export function createLegacyStorageWorker(sqlitePath: string, settingsPath: string): LegacyStorageWorkerHandle {
  const worker = new Worker(sourceAwareWorkerUrl("legacyStorageThread"), {
    workerData: { sqlitePath, settingsPath },
    execArgv: sourceAwareWorkerExecArgv()
  });
  const pending = new Map<string, { resolve(value: unknown): void; reject(error: unknown): void }>();
  let closed = false;
  worker.on("message", (response: LegacyStorageResponse) => {
    const request = pending.get(response.id);
    if (!request) return;
    pending.delete(response.id);
    if (response.ok) request.resolve(response.result);
    else {
      const error = new Error(response.error.message);
      error.name = response.error.name;
      error.stack = response.error.stack;
      request.reject(error);
    }
  });
  worker.on("error", rejectAll);
  worker.on("exit", (code) => {
    if (!closed && code !== 0) rejectAll(new Error(`Legacy storage worker exited with code ${code}.`));
  });

  function request(target: LegacyStorageTarget, method: string, args: unknown[]): Promise<unknown> {
    if (closed) return Promise.reject(new Error("Legacy storage worker is closed."));
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      worker.postMessage({ id, target, method, args } satisfies LegacyStorageRequest);
    });
  }
  function rejectAll(error: unknown): void {
    for (const entry of pending.values()) entry.reject(error);
    pending.clear();
  }
  function proxy<T extends object>(target: LegacyStorageTarget, methods: readonly string[]): T {
    const methodSet = new Set(methods);
    return new Proxy(
      {},
      {
        get(_object, property) {
          if (typeof property !== "string" || !methodSet.has(property)) return undefined;
          return (...args: unknown[]) => request(target, property, args);
        }
      }
    ) as T;
  }
  return {
    researchStore: proxy<ResearchStore>("researchStore", RESEARCH_STORE_METHODS),
    projectStorage: proxy<ProjectStorage>("projectStorage", PROJECT_STORAGE_METHODS),
    settingsStore: proxy<AppSettingsStore>("settingsStore", SETTINGS_STORE_METHODS),
    async close() {
      if (closed) return;
      const id = randomUUID();
      await new Promise<void>((resolve, reject) => {
        pending.set(id, { resolve: () => resolve(), reject });
        worker.postMessage({ id, target: "close" });
      });
      closed = true;
      await worker.terminate();
      rejectAll(new Error("Legacy storage worker closed."));
    }
  };
}
