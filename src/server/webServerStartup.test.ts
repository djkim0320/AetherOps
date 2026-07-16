import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DurableJobRuntime } from "./composition/durableJobRuntime.js";
import { runRequiredMigration } from "./composition/migrationGate.js";
import { initializeStartupResources, StartupResourceRegistry } from "./composition/runtimeResourceCleanup.js";
import { SseRuntimeDiagnostics } from "./composition/sseRuntimeDiagnostics.js";
import { composeWebRuntime, type WebRuntimeComposition } from "./composition/webRuntimeComposition.js";
import { initializeServerTransport } from "./http/serverListen.js";
import { createLegacyStorageWorker, type LegacyStorageWorkerHandle } from "./runtime/storage/worker/legacyStorageClient.js";
import { startWebServer, type WebServerHandle } from "./webServer.js";

describe("web server startup cleanup", () => {
  it("rejects an invalid port before construction and permits same-root startup", async () => {
    const root = mkdtempSync(join(tmpdir(), "aetherops-invalid-port-"));
    const originalToken = process.env.AETHEROPS_RPC_TOKEN;
    let recovered: WebServerHandle | undefined;
    try {
      process.env.AETHEROPS_RPC_TOKEN = "startup-invalid-port-rpc-token-123456";
      await expect(
        startWebServer({ port: 65_536, host: "127.0.0.1", dataRoot: root, appRoot: process.cwd(), installSignalHandlers: false })
      ).rejects.toMatchObject({ code: "ERR_SOCKET_BAD_PORT" });
      expect(existsSync(join(root, "migration"))).toBe(false);
      expect(existsSync(join(root, "migration", ".storage-owner.lock"))).toBe(false);

      recovered = await startWebServer({ port: 0, host: "127.0.0.1", dataRoot: root, appRoot: process.cwd(), installSignalHandlers: false });
      expect((await fetch(`${recovered.url}/api/health`)).status).toBe(200);
    } finally {
      await recovered?.close();
      rmSync(root, { recursive: true, force: true });
      if (originalToken === undefined) delete process.env.AETHEROPS_RPC_TOKEN;
      else process.env.AETHEROPS_RPC_TOKEN = originalToken;
    }
  }, 30_000);

  it("closes a ready legacy worker when later construction fails and permits full restart", async () => {
    const root = mkdtempSync(join(tmpdir(), "aetherops-construction-fault-"));
    const originalToken = process.env.AETHEROPS_RPC_TOKEN;
    let legacyStorage: LegacyStorageWorkerHandle | undefined;
    let recovered: WebServerHandle | undefined;
    try {
      process.env.AETHEROPS_RPC_TOKEN = "startup-construction-fault-rpc-token-123456";
      await runRequiredMigration(process.cwd(), root);
      const registry = new StartupResourceRegistry();

      await expect(
        initializeStartupResources(registry, async () => {
          const storage = createLegacyStorageWorker(join(root, "migration", "v2", "legacy-research.sqlite"), join(root, "settings.json"));
          legacyStorage = storage;
          registry.registerDependency("storage", () => storage.close());
          await storage.ready;
          const jobs = new DurableJobRuntime(join(root, "migration", "v2", "storage.sqlite"), { dataRoot: root });
          registry.registerController("jobs", () => jobs.close());
          throw new Error("Injected later runtime construction failure.");
        })
      ).rejects.toThrow("Injected later runtime construction failure.");
      expect(legacyStorage).toBeDefined();
      await expect(legacyStorage!.settingsStore.getRuntimeSettings()).rejects.toThrow("Legacy storage worker is closed.");
      expect(existsSync(join(root, "migration", ".storage-owner.lock"))).toBe(false);

      recovered = await startWebServer({ port: 0, host: "127.0.0.1", dataRoot: root, appRoot: process.cwd(), installSignalHandlers: false });
      expect((await fetch(`${recovered.url}/api/health`)).status).toBe(200);
    } finally {
      await Promise.allSettled([recovered?.close(), legacyStorage?.close()].filter((value): value is Promise<void> => value !== undefined));
      rmSync(root, { recursive: true, force: true });
      if (originalToken === undefined) delete process.env.AETHEROPS_RPC_TOKEN;
      else process.env.AETHEROPS_RPC_TOKEN = originalToken;
    }
  }, 30_000);

  it("closes a composed runtime when HTTP transport construction fails and permits full restart", async () => {
    const root = mkdtempSync(join(tmpdir(), "aetherops-transport-fault-"));
    const originalToken = process.env.AETHEROPS_RPC_TOKEN;
    let runtime: WebRuntimeComposition | undefined;
    let recovered: WebServerHandle | undefined;
    try {
      process.env.AETHEROPS_RPC_TOKEN = "startup-transport-fault-rpc-token-123456";
      await runRequiredMigration(process.cwd(), root);
      runtime = await composeWebRuntime({
        appRoot: process.cwd(),
        dataRoot: root,
        sseDiagnostics: new SseRuntimeDiagnostics(),
        projectMutationResultMapper: {
          project: () => ({}),
          session: () => ({}),
          deleted: () => ({ deleted: true })
        }
      });
      const failure = new Error("Injected HTTP transport construction failure.");

      await expect(
        initializeServerTransport({
          initialize: () => {
            throw failure;
          },
          beforeCleanup: () => runtime?.jobs.beginDrain(),
          closeResources: () => runtime!.closeResources()
        })
      ).rejects.toBe(failure);
      expect(existsSync(join(root, "migration", ".storage-owner.lock"))).toBe(false);

      recovered = await startWebServer({ port: 0, host: "127.0.0.1", dataRoot: root, appRoot: process.cwd(), installSignalHandlers: false });
      expect((await fetch(`${recovered.url}/api/health`)).status).toBe(200);
    } finally {
      await Promise.allSettled([recovered?.close(), runtime?.closeResources()].filter((value): value is Promise<void> => value !== undefined));
      rmSync(root, { recursive: true, force: true });
      if (originalToken === undefined) delete process.env.AETHEROPS_RPC_TOKEN;
      else process.env.AETHEROPS_RPC_TOKEN = originalToken;
    }
  }, 30_000);

  it("closes runtime workers when the HTTP listen step fails", async () => {
    const primaryRoot = mkdtempSync(join(tmpdir(), "aetherops-listen-primary-"));
    const retryRoot = mkdtempSync(join(tmpdir(), "aetherops-listen-retry-"));
    const originalToken = process.env.AETHEROPS_RPC_TOKEN;
    let primary: WebServerHandle | undefined;
    let recovered: WebServerHandle | undefined;
    try {
      process.env.AETHEROPS_RPC_TOKEN = "startup-cleanup-test-rpc-token-123456";
      primary = await startWebServer({ port: 0, host: "127.0.0.1", dataRoot: primaryRoot, appRoot: process.cwd(), installSignalHandlers: false });

      await expect(
        startWebServer({ port: primary.port, host: "127.0.0.1", dataRoot: retryRoot, appRoot: process.cwd(), installSignalHandlers: false })
      ).rejects.toMatchObject({ code: "EADDRINUSE" });

      recovered = await startWebServer({ port: 0, host: "127.0.0.1", dataRoot: retryRoot, appRoot: process.cwd(), installSignalHandlers: false });
      expect((await fetch(`${recovered.url}/api/health`)).status).toBe(200);
    } finally {
      await Promise.allSettled([recovered?.close(), primary?.close()].filter((value): value is Promise<void> => value !== undefined));
      rmSync(primaryRoot, { recursive: true, force: true });
      rmSync(retryRoot, { recursive: true, force: true });
      if (originalToken === undefined) delete process.env.AETHEROPS_RPC_TOKEN;
      else process.env.AETHEROPS_RPC_TOKEN = originalToken;
    }
  }, 30_000);
});
