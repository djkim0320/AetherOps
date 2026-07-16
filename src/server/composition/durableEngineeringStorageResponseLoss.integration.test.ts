import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ConfigurationBaseline } from "../../core/aerospace/configurationBaseline.js";
import { configurationBaselineContentHash } from "../runtime/storage/v2/engineeringBaselineIntegrity.js";
import { migrateStorageV2Schema } from "../runtime/storage/v2/schema.js";
import type { StorageCapabilityAudit, StorageJobEvent } from "../runtime/storage/v2/types.js";
import { createStorageWorkerClient, type StorageWorkerClient } from "../runtime/storage/worker/typedRuntime.js";
import { DurableEngineeringStorage } from "./durableEngineeringStorage.js";

let root: string | undefined;
let client: StorageWorkerClient | undefined;

afterEach(async () => {
  await client?.close().catch(() => undefined);
  client = undefined;
  if (root) rmSync(root, { recursive: true, force: true });
  root = undefined;
});

describe("DurableEngineeringStorage response-loss recovery", () => {
  it("replays and republishes one committed event after the real worker response is lost", async () => {
    root = mkdtempSync(join(tmpdir(), "aetherops-engineering-response-loss-"));
    const databasePath = join(root, "storage.sqlite");
    const setup = new DatabaseSync(databasePath);
    migrateStorageV2Schema(setup);
    setup.close();
    client = createStorageWorkerClient({
      appDbPath: databasePath,
      vectorDbPath: databasePath,
      ontologyDbPath: databasePath,
      dataRoot: root
    });
    const baseline = activeBaseline();
    const projectRoot = join(root, "project");
    mkdirSync(projectRoot);
    await client.request({
      name: "project.upsert",
      project: {
        id: baseline.projectId,
        projectRoot,
        topic: "Worker response loss",
        status: "active",
        autonomyPolicy: { allowAgent: true, allowCodeExecution: true, allowExternalSearch: false },
        createdAt: baseline.createdAt,
        updatedAt: baseline.createdAt
      }
    });
    const publish = vi.fn<(event: StorageJobEvent) => void>();
    const storage = new DurableEngineeringStorage(loseFirstActivationResponse(client), () => undefined, publish, unexpectedFence);
    const input = { baseline, expectedRevision: 0, changeReason: "Commit once and recover the lost response." };

    const replay = await storage.activateBaseline(input, {
      projectRevision: 0,
      snapshotVersion: 0,
      capabilityAudits: audits(baseline.projectId, 0)
    });
    expect(replay.exactReplay).toBe(true);
    expect(publish).toHaveBeenCalledOnce();
    const durableEvents = await client.request<StorageJobEvent[]>({ name: "event.after", projectId: baseline.projectId, limit: 10 });
    expect(durableEvents).toHaveLength(1);
    expect(publish).toHaveBeenCalledWith(durableEvents[0]);

    await client.request({
      name: "event.append",
      event: {
        eventId: "event-after-baseline-activation",
        projectId: baseline.projectId,
        type: "run.status.changed",
        createdAt: "2026-07-17T00:00:01.000Z",
        payload: { status: "idle" }
      }
    });
    const historicalReplay = await storage.activateBaseline(input, {
      projectRevision: 2,
      snapshotVersion: 2,
      capabilityAudits: audits(baseline.projectId, 2)
    });
    expect(historicalReplay.exactReplay).toBe(true);
    expect(publish).toHaveBeenCalledOnce();
    expect(await client.request<StorageJobEvent[]>({ name: "event.after", projectId: baseline.projectId, limit: 10 })).toHaveLength(2);

    const readback = new DatabaseSync(databasePath, { readOnly: true });
    try {
      expect(readback.prepare("pragma integrity_check").get()).toEqual({ integrity_check: "ok" });
      expect(readback.prepare("select count(*) count from engineering_configuration_baselines").get()).toEqual({ count: 1 });
      expect(readback.prepare("select count(*) count from capability_audits").get()).toEqual({ count: 3 });
      expect(readback.prepare("select count(*) count from job_events").get()).toEqual({ count: 2 });
    } finally {
      readback.close();
    }
  });
});

function loseFirstActivationResponse(target: StorageWorkerClient): StorageWorkerClient {
  let lost = false;
  return new Proxy(target, {
    get(client, property) {
      if (property === "request") {
        return async <T>(...args: Parameters<StorageWorkerClient["request"]>): Promise<T> => {
          const result = await client.request<T>(...args);
          if (!lost && args[0].name === "engineering.baseline.activate") {
            lost = true;
            throw new Error("injected baseline activation response loss");
          }
          return result;
        };
      }
      const value = Reflect.get(client, property, client) as unknown;
      return typeof value === "function" ? value.bind(client) : value;
    }
  });
}

function activeBaseline(): ConfigurationBaseline {
  const baseline: ConfigurationBaseline = {
    id: "baseline-response-loss",
    projectId: "project-response-loss",
    revision: 1,
    status: "active",
    unitConventionId: "si-v1",
    coordinateConventionId: "body-axis-v1",
    solverVersions: { codex: "0.144.1" },
    materialRevisionIds: [],
    sourceRevisionIds: ["source-response-loss"],
    equationVersionIds: [],
    contentHash: "0".repeat(64),
    createdAt: "2026-07-17T00:00:00.000Z",
    createdBy: "response-loss-test",
    provenance: [{ id: "source-response-loss", contentHash: "a".repeat(64) }]
  };
  return { ...baseline, contentHash: configurationBaselineContentHash(baseline) };
}

function audits(projectId: string, projectRevision: number): StorageCapabilityAudit[] {
  return (["agent", "engineering", "search"] as const).map((capability) => ({
    id: `audit-${projectRevision}-${capability}`,
    projectId,
    operation: capability,
    capability,
    appAllowed: true,
    projectAllowed: capability !== "search",
    operationAllowed: capability !== "search",
    allowed: capability !== "search",
    data: { jobKind: "engineering_run", ...(capability === "search" ? { blockedBy: "project" as const } : {}), projectRevision },
    auditedAt: "2026-07-17T00:00:00.000Z"
  }));
}

function unexpectedFence(): never {
  throw new Error("No active job is expected in this test.");
}
