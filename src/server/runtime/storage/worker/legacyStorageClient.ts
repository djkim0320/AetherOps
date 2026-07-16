import { randomUUID } from "node:crypto";
import { Worker } from "node:worker_threads";
import type { ResearchStore } from "../../../../core/shared/types.js";
import type { ProjectStorage } from "../../../../core/storage/projectStorage.js";
import type { AppSettingsStore } from "../settingsStore.js";
import type { LegacyProjectMutationPort } from "../legacyProjectMutationTypes.js";
import {
  PROJECT_STORAGE_METHODS,
  PROJECT_MUTATION_METHODS,
  RESEARCH_STORE_METHODS,
  SETTINGS_STORE_METHODS,
  type LegacyStorageRequest,
  type LegacyStorageReady,
  type LegacyStorageResponse,
  type LegacyStorageTarget
} from "./legacyStorageProtocol.js";
import { sourceAwareWorkerExecArgv, sourceAwareWorkerUrl } from "./sourceWorkerRuntime.js";

export interface LegacyStorageWorkerHandle {
  ready: Promise<void>;
  researchStore: ResearchStore;
  projectStorage: ProjectStorage;
  settingsStore: AppSettingsStore;
  projectMutations: LegacyProjectMutationPort;
  close(): Promise<void>;
}

export function createLegacyStorageWorker(sqlitePath: string, settingsPath: string): LegacyStorageWorkerHandle {
  const worker = new Worker(sourceAwareWorkerUrl("legacyStorageThread"), {
    workerData: { sqlitePath, settingsPath },
    execArgv: sourceAwareWorkerExecArgv()
  });
  const pending = new Map<string, { resolve(value: unknown): void; reject(error: unknown): void; timeout: ReturnType<typeof setTimeout> }>();
  let stopped = false;
  let closing = false;
  let readySettled = false;
  let termination: Promise<number> | undefined;
  let resolveReady!: () => void;
  let rejectReady!: (error: unknown) => void;
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  void ready.catch(() => undefined);
  const readyTimeout = setTimeout(() => failWorker(new Error("Legacy storage worker readiness timed out.")), 10_000);
  worker.on("message", (message: LegacyStorageResponse | LegacyStorageReady) => {
    if (isReadyMessage(message)) {
      settleReady();
      return;
    }
    const response = message;
    const request = pending.get(response.id);
    if (!request) return;
    pending.delete(response.id);
    clearTimeout(request.timeout);
    if (response.ok) request.resolve(response.result);
    else {
      const error = new Error(response.error.message);
      error.name = response.error.name;
      error.stack = response.error.stack;
      request.reject(error);
    }
  });
  worker.on("error", failWorker);
  worker.on("exit", (code) => {
    if (!stopped) failWorker(new Error(`Legacy storage worker exited before shutdown with code ${code}.`), false);
  });

  async function request(target: LegacyStorageTarget, method: string, args: unknown[]): Promise<unknown> {
    await ready;
    return sendRequest(target, method, args);
  }
  function sendRequest(target: LegacyStorageTarget | "close", method: string, args: unknown[], allowClosing = false): Promise<unknown> {
    if (stopped || (closing && !allowClosing)) return Promise.reject(new Error("Legacy storage worker is closed."));
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`Legacy storage request timed out: ${target}.${method}`));
      }, 30_000);
      pending.set(id, { resolve, reject, timeout });
      worker.postMessage(target === "close" ? { id, target } : ({ id, target, method, args } satisfies LegacyStorageRequest));
    });
  }
  function rejectAll(error: unknown): void {
    for (const entry of pending.values()) {
      clearTimeout(entry.timeout);
      entry.reject(error);
    }
    pending.clear();
  }
  function settleReady(): void {
    if (readySettled) return;
    readySettled = true;
    clearTimeout(readyTimeout);
    resolveReady();
  }
  function failWorker(error: unknown, terminate = true): void {
    if (stopped) return;
    stopped = true;
    clearTimeout(readyTimeout);
    if (!readySettled) {
      readySettled = true;
      rejectReady(error);
    }
    rejectAll(error);
    if (terminate) void terminateWorker();
  }
  function terminateWorker(): Promise<number> {
    termination ??= worker.terminate();
    return termination;
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
    ready,
    researchStore: proxy<ResearchStore>("researchStore", RESEARCH_STORE_METHODS),
    projectStorage: proxy<ProjectStorage>("projectStorage", PROJECT_STORAGE_METHODS),
    settingsStore: proxy<AppSettingsStore>("settingsStore", SETTINGS_STORE_METHODS),
    projectMutations: proxy<LegacyProjectMutationPort>("projectMutations", PROJECT_MUTATION_METHODS),
    async close() {
      if (stopped || closing) {
        await termination;
        return;
      }
      closing = true;
      try {
        await ready;
        await sendRequest("close", "close", [], true);
      } finally {
        stopped = true;
        clearTimeout(readyTimeout);
        await terminateWorker();
        rejectAll(new Error("Legacy storage worker closed."));
      }
    }
  };
}

function isReadyMessage(message: LegacyStorageResponse | LegacyStorageReady): message is LegacyStorageReady {
  return "type" in message && message.type === "ready";
}
