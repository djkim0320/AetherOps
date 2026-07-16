import { describe, expect, it, vi } from "vitest";
import type { ApiV2RpcRequest } from "../../../contracts/api-v2/rpc.js";
import type { RpcHandlerContext } from "./context.js";
import { handleEngineeringRpc } from "./engineeringRpcHandlers.js";
import { RpcNotReadyError } from "./rpcErrors.js";
import { defaultSettings } from "../../runtime/storage/settingsStore.js";
import type { ConfigurationBaseline } from "../../../core/aerospace/configurationBaseline.js";
import type { EngineeringQuantity } from "../../../core/aerospace/quantity.js";
import { readableProjectMutations } from "./rpcRouterTestSupport.js";
import { CapabilityMutationGate } from "./capabilityMutationGate.js";

describe("engineering RPC response validation", () => {
  it("uses the durable project head when activating a baseline snapshot", async () => {
    const current = baseline({ "xfoil-wasm": "0.1.1" });
    const draft = baselineDraft(current);
    const activateBaseline = vi.fn(async (input: { baseline: ConfigurationBaseline }) => ({
      baseline: input.baseline,
      exactReplay: false,
      changedAspects: [],
      stalePromotionIds: []
    }));
    const context = enqueueContext(current, vi.fn());
    context.projectMutations.readSnapshot = vi.fn().mockResolvedValue({
      snapshot: await context.orchestrator.getSnapshot("project-1"),
      projectRevision: 12
    });
    context.jobs.engineering.activateBaseline = activateBaseline;

    await handleEngineeringRpc(
      request({
        requestId: "request-baseline-activate-head",
        method: "engineering.baseline.activate",
        params: { projectId: "project-1", expectedRevision: 1, changeReason: "Validated update", baseline: draft }
      }),
      context
    );

    expect(activateBaseline).toHaveBeenCalledWith(
      expect.objectContaining({ expectedRevision: 1, baseline: expect.objectContaining({ projectId: "project-1", revision: 2 }) }),
      {
        projectRevision: 12,
        snapshotVersion: 12,
        capabilityAudits: expect.arrayContaining([
          expect.objectContaining({ capability: "agent", allowed: true, data: expect.objectContaining({ projectRevision: 12 }) }),
          expect.objectContaining({ capability: "engineering", allowed: true, data: expect.objectContaining({ projectRevision: 12 }) })
        ])
      }
    );
  });

  it("rejects a malformed persisted baseline instead of returning it through API v2", async () => {
    const context = {
      projectMutations: readableProjectMutations(),
      orchestrator: { getSnapshot: vi.fn().mockResolvedValue({}) },
      jobs: { engineering: { getBaseline: vi.fn().mockResolvedValue({ id: "baseline-invalid", projectId: "project-1" }) } }
    } as unknown as RpcHandlerContext;

    await expect(
      handleEngineeringRpc(
        request({ requestId: "request-baseline", method: "engineering.baseline.get", params: { projectId: "project-1", baselineId: "baseline-invalid" } }),
        context
      )
    ).rejects.toMatchObject({ name: "ZodError" });
  });

  it("rejects malformed artifact readback metadata at the HTTP response boundary", async () => {
    const context = {
      projectMutations: readableProjectMutations(),
      orchestrator: { getSnapshot: vi.fn().mockResolvedValue({}) },
      jobs: {
        engineering: {
          readArtifact: vi.fn().mockResolvedValue({
            promotion: {
              id: "promotion-1",
              artifact: { sha256: "not-a-sha256", byteLength: 4, mediaType: "text/plain" },
              baselineId: "baseline-1",
              baselineRevision: 1
            },
            artifactUri: "artifact://promotion-1",
            excerptBase64: "dGVzdA==",
            excerptBytes: 4,
            complete: true,
            readAt: "2026-07-16T00:00:00.000Z",
            readReceiptHash: "a".repeat(64)
          })
        }
      }
    } as unknown as RpcHandlerContext;

    await expect(
      handleEngineeringRpc(
        request({ requestId: "request-artifact", method: "engineering.artifact.read", params: { projectId: "project-1", promotionId: "promotion-1" } }),
        context
      )
    ).rejects.toMatchObject({ name: "ZodError" });
  });

  it("rejects an idempotent receipt whose kind is not engineering_run", async () => {
    const context = {
      jobs: {
        findIdempotentReceipt: vi.fn().mockResolvedValue({
          jobId: "job-1",
          projectId: "project-1",
          kind: "research_loop",
          status: "queued",
          queuePosition: 1,
          acceptedAt: "2026-07-16T00:00:00.000Z",
          projectRevision: 1
        })
      }
    } as unknown as RpcHandlerContext;

    await expect(
      handleEngineeringRpc(
        request({
          requestId: "request-enqueue",
          method: "engineering.enqueue",
          params: {
            projectId: "project-1",
            idempotencyKey: "engineering-1",
            requests: [{ target: "webxfoil", objective: "Run the declared case.", inputs: {} }],
            requestedCapabilities: { agent: true, engineering: true, search: false }
          }
        }),
        context
      )
    ).rejects.toMatchObject({ name: "ZodError" });
  });

  it.each([
    ["xfoil", { xfoil: "6.99" }, /runtime-version receipt/i],
    ["webxfoil", { "xfoil-wasm": "0.1.0" }, /pinned runtime is 0\.1\.1/i]
  ] as const)("rejects %s before enqueue when durable runtime provenance is not ready", async (target, solverVersions, reason) => {
    const enqueue = vi.fn();
    const context = enqueueContext(baseline(solverVersions), enqueue);

    const error = await captureAsync(() =>
      handleEngineeringRpc(
        request({
          requestId: `request-${target}`,
          method: "engineering.enqueue",
          params: {
            projectId: "project-1",
            idempotencyKey: `engineering-${target}`,
            requests: [{ target, objective: "Run only the declared solver.", inputs: {} }],
            requestedCapabilities: { agent: true, engineering: true, search: false }
          }
        }),
        context
      )
    );
    expect(error).toBeInstanceOf(RpcNotReadyError);
    expect((error as RpcNotReadyError).details).toMatchObject({ targets: [expect.objectContaining({ reason: expect.stringMatching(reason) })] });
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("does not probe Codex readiness when the active baseline version mismatches the pinned CLI", async () => {
    const getStatus = vi.fn();
    const context = enqueueContext(baseline({ codex: "0.143.0" }), vi.fn(), getStatus);

    const response = await handleEngineeringRpc(
      request({
        requestId: "request-codex-preflight-mismatch",
        method: "engineering.preflight",
        params: {
          projectId: "project-1",
          targets: ["codex"],
          requestedCapabilities: { agent: true, engineering: true, search: false }
        }
      }),
      context
    );

    expect(response).toMatchObject({ ready: false, targets: [{ target: "codex", ready: false, reason: expect.stringContaining("pinned runtime") }] });
    expect(getStatus).not.toHaveBeenCalled();
  });
});

function request<T extends Extract<ApiV2RpcRequest, { method: `engineering.${string}` }>>(value: T): T {
  return value;
}

async function captureAsync(run: () => Promise<unknown>): Promise<unknown> {
  try {
    await run();
  } catch (error) {
    return error;
  }
  throw new Error("Expected RPC handler to reject.");
}

function enqueueContext(activeBaseline: ConfigurationBaseline, enqueue: ReturnType<typeof vi.fn>, getStatus = vi.fn()) {
  const settings = {
    ...defaultSettings,
    allowAgent: true,
    allowCodeExecution: true,
    engineeringTools: {
      ...defaultSettings.engineeringTools,
      enabled: true,
      xfoil: { ...defaultSettings.engineeringTools.xfoil, enabled: true, command: process.execPath }
    }
  };
  const snapshot = {
    project: {
      id: "project-1",
      name: "Project",
      description: "Engineering provenance guard",
      status: "idle",
      currentStep: "IDLE",
      maxIterations: 1,
      convergenceThreshold: 1,
      autoRunOpenCode: false,
      autonomyPolicy: { allowAgent: true, allowCodeExecution: true, allowExternalSearch: false },
      createdAt: "2026-07-16T00:00:00.000Z",
      updatedAt: "2026-07-16T00:00:00.000Z"
    }
  };
  return {
    capabilityMutations: new CapabilityMutationGate(),
    projectMutations: readableProjectMutations(snapshot),
    orchestrator: {
      getSnapshot: vi.fn().mockResolvedValue(snapshot)
    },
    settingsStore: { getRuntimeSettings: vi.fn().mockResolvedValue(settings) },
    jobs: {
      findIdempotentReceipt: vi.fn().mockResolvedValue(undefined),
      getProjectRevision: vi.fn().mockResolvedValue(1),
      enqueue,
      recordCapabilityAudits: vi.fn().mockResolvedValue(undefined),
      engineering: { activeBaseline: vi.fn().mockResolvedValue(activeBaseline) }
    },
    llm: { getStatus }
  } as unknown as RpcHandlerContext;
}

function baseline(solverVersions: Record<string, string>): ConfigurationBaseline {
  return {
    id: "baseline-1",
    projectId: "project-1",
    revision: 1,
    status: "active",
    geometryHash: "1".repeat(64),
    airfoilGeometryHash: "2".repeat(64),
    aerodynamicReference: {
      area: quantity(12, "m^2"),
      chord: quantity(1.5, "m"),
      span: quantity(8, "m"),
      axisConventionId: "wind-axes-v1",
      dynamicPressureDefinition: "q=0.5*rho*V^2"
    },
    massPropertiesHash: "3".repeat(64),
    atmosphereModelId: "isa-1976",
    unitConventionId: "si-v1",
    coordinateConventionId: "right-handed-cartesian-v1",
    solverVersions,
    materialRevisionIds: ["material:v1"],
    sourceRevisionIds: ["source:v1"],
    equationVersionIds: [],
    contentHash: "4".repeat(64),
    createdAt: "2026-07-16T00:00:00.000Z",
    createdBy: "test",
    provenance: [{ id: "source:v1", contentHash: "5".repeat(64) }]
  };
}

function baselineDraft(value: ConfigurationBaseline) {
  return {
    geometryHash: value.geometryHash,
    airfoilGeometryHash: value.airfoilGeometryHash,
    aerodynamicReference: value.aerodynamicReference,
    massProperties: value.massProperties,
    massPropertiesHash: value.massPropertiesHash,
    atmosphereModelId: value.atmosphereModelId,
    propulsionModelId: value.propulsionModelId,
    unitConventionId: value.unitConventionId,
    coordinateConventionId: value.coordinateConventionId,
    solverVersions: value.solverVersions,
    materialRevisionIds: value.materialRevisionIds,
    sourceRevisionIds: value.sourceRevisionIds,
    equationVersionIds: value.equationVersionIds,
    createdBy: value.createdBy,
    provenance: value.provenance
  };
}

function quantity(valueSI: number, unit: string): EngineeringQuantity {
  return {
    kind: "scalar",
    valueSI,
    dimension: { mass: 0, length: unit === "m^2" ? 2 : 1, time: 0, temperature: 0, current: 0, amount: 0, luminousIntensity: 0, angle: 0 },
    semantic: "generic",
    originalValue: valueSI,
    originalUnit: unit,
    displayUnit: unit,
    provenance: { sourceType: "calculation", sourceId: "baseline-test" },
    serializationVersion: 1
  };
}
