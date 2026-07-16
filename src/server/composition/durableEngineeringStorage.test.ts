import { describe, expect, it, vi } from "vitest";
import type { ConfigurationBaseline } from "../../core/aerospace/configurationBaseline.js";
import type { StorageActivateEngineeringBaselineTransactionResult } from "../runtime/storage/v2/engineeringBaselineTypes.js";
import type { StorageCapabilityAudit } from "../runtime/storage/v2/types.js";
import type { StorageWorkerClient } from "../runtime/storage/worker/typedRuntime.js";
import { DurableEngineeringStorage } from "./durableEngineeringStorage.js";

describe("DurableEngineeringStorage", () => {
  it("publishes the committed event again for an exact replay", async () => {
    const baseline = activeBaseline();
    const event = {
      sequence: 1,
      eventId: "event-baseline-1",
      projectId: baseline.projectId,
      type: "project.snapshot.changed",
      createdAt: baseline.createdAt,
      payload: { projectRevision: 1, data: { snapshotVersion: 1, reason: "project_updated" } }
    };
    const first: StorageActivateEngineeringBaselineTransactionResult = {
      activation: { baseline, exactReplay: false, changedAspects: [], stalePromotionIds: [] },
      event,
      publishEvent: true
    };
    const replay: StorageActivateEngineeringBaselineTransactionResult = {
      activation: { baseline, exactReplay: true, changedAspects: [], stalePromotionIds: [] },
      event,
      publishEvent: false
    };
    const request = vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(replay);
    const publish = vi.fn();
    const storage = new DurableEngineeringStorage(
      { request } as unknown as StorageWorkerClient,
      () => undefined,
      publish,
      () => {
        throw new Error("No active job is expected in this test.");
      }
    );
    const input = { baseline, expectedRevision: 0, changeReason: "Initial verified configuration." };

    await storage.activateBaseline(input, { projectRevision: 0, snapshotVersion: 0, capabilityAudits: audits(baseline.projectId, 0) });
    await storage.activateBaseline(
      { ...input, baseline: { ...baseline, id: "baseline-api-retry-uuid", createdAt: "2026-07-16T00:00:01.000Z" } },
      { projectRevision: 1, snapshotVersion: 1, capabilityAudits: audits(baseline.projectId, 1) }
    );

    expect(publish).toHaveBeenCalledOnce();
    expect(publish).toHaveBeenNthCalledWith(1, event);
    expect(request.mock.calls[0]?.[0].event.eventId).toBe(request.mock.calls[1]?.[0].event.eventId);
  });

  it("preserves an activation failure when no committed event exists", async () => {
    const baseline = activeBaseline();
    const failure = new Error("activation rejected before commit");
    const request = vi.fn().mockRejectedValueOnce(failure).mockResolvedValueOnce(undefined);
    const publish = vi.fn();
    const storage = new DurableEngineeringStorage(
      { request } as unknown as StorageWorkerClient,
      () => undefined,
      publish,
      () => {
        throw new Error("No active job is expected in this test.");
      }
    );

    await expect(
      storage.activateBaseline(
        { baseline, expectedRevision: 0, changeReason: "Rejected activation." },
        { projectRevision: 0, snapshotVersion: 0, capabilityAudits: audits(baseline.projectId, 0) }
      )
    ).rejects.toBe(failure);
    expect(request).toHaveBeenCalledTimes(2);
    expect(request.mock.calls[1]?.[0]).toMatchObject({ name: "event.get" });
    expect(publish).not.toHaveBeenCalled();
  });
});

function activeBaseline(): ConfigurationBaseline {
  return {
    id: "baseline-1",
    projectId: "project-1",
    revision: 1,
    status: "active",
    unitConventionId: "si-v1",
    coordinateConventionId: "body-axis-v1",
    solverVersions: { codex: "0.144.1" },
    materialRevisionIds: [],
    sourceRevisionIds: ["source-1"],
    equationVersionIds: [],
    contentHash: "a".repeat(64),
    createdAt: "2026-07-16T00:00:00.000Z",
    createdBy: "test",
    provenance: [{ id: "source-1", contentHash: "b".repeat(64) }]
  };
}

function audits(projectId: string, projectRevision: number): StorageCapabilityAudit[] {
  return (["agent", "engineering", "search"] as const).map((capability) => ({
    id: `${capability}-${projectRevision}`,
    projectId,
    operation: capability,
    capability,
    appAllowed: true,
    projectAllowed: capability !== "search",
    operationAllowed: capability !== "search",
    allowed: capability !== "search",
    data: { jobKind: "engineering_run", ...(capability === "search" ? { blockedBy: "project" as const } : {}), projectRevision },
    auditedAt: "2026-07-16T00:00:00.000Z"
  }));
}
