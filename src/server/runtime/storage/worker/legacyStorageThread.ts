import { isMainThread, parentPort, workerData } from "node:worker_threads";
import { DatabaseSync } from "node:sqlite";
import { assertLegacyProjectMutationSchemaReady } from "../legacyProjectMutationSchema.js";
import { SqliteResearchStore } from "../sqliteStore.js";
import { NodeProjectStorage } from "../projectResearchStore.js";
import { JsonAppSettingsStore } from "../settingsStore.js";
import {
  PROJECT_STORAGE_METHODS,
  PROJECT_MUTATION_METHODS,
  RESEARCH_STORE_METHODS,
  SETTINGS_STORE_METHODS,
  type LegacyStorageRequest,
  type LegacyStorageReady,
  type LegacyStorageResponse
} from "./legacyStorageProtocol.js";

if (isMainThread || !parentPort) throw new Error("Legacy storage thread must run as a worker.");
const paths = workerData as { sqlitePath: string; settingsPath: string };
const schemaDatabase = new DatabaseSync(String(paths.sqlitePath), { readOnly: true });
try {
  assertLegacyProjectMutationSchemaReady(schemaDatabase);
} finally {
  schemaDatabase.close();
}
const researchStore = new SqliteResearchStore(String(paths.sqlitePath));
const projectStorage = new NodeProjectStorage();
const settingsStore = new JsonAppSettingsStore(String(paths.settingsPath));
const projectMutations = {
  apply: researchStore.applyProjectMutation.bind(researchStore),
  getReceipt: researchStore.getProjectMutationReceipt.bind(researchStore),
  listReceipts: researchStore.listProjectMutationReceipts.bind(researchStore)
};
const allowed = {
  researchStore: new Set<string>(RESEARCH_STORE_METHODS),
  projectStorage: new Set<string>(PROJECT_STORAGE_METHODS),
  settingsStore: new Set<string>(SETTINGS_STORE_METHODS),
  projectMutations: new Set<string>(PROJECT_MUTATION_METHODS)
};

parentPort.on("message", async (request: LegacyStorageRequest | { id: string; target: "close" }) => {
  if (!request || typeof request.id !== "string") return;
  try {
    if (request.target === "close") {
      researchStore.close();
      parentPort?.postMessage({ id: request.id, ok: true, result: null } satisfies LegacyStorageResponse);
      parentPort?.close();
      return;
    }
    if (!allowed[request.target].has(request.method)) throw new Error(`Unsupported ${request.target} method: ${request.method}`);
    const instance =
      request.target === "researchStore"
        ? researchStore
        : request.target === "projectStorage"
          ? projectStorage
          : request.target === "settingsStore"
            ? settingsStore
            : projectMutations;
    const method = (instance as unknown as Record<string, (...args: unknown[]) => unknown>)[request.method];
    if (typeof method !== "function") throw new Error(`Storage method is unavailable: ${request.method}`);
    const result = await method.apply(instance, request.args);
    parentPort?.postMessage({ id: request.id, ok: true, result } satisfies LegacyStorageResponse);
  } catch (error) {
    const failure = error instanceof Error ? error : new Error(String(error));
    parentPort?.postMessage({
      id: request.id,
      ok: false,
      error: { name: failure.name, message: failure.message, stack: failure.stack }
    } satisfies LegacyStorageResponse);
  }
});

parentPort.postMessage({ type: "ready" } satisfies LegacyStorageReady);
