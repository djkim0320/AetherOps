import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { rpcTokenHeader } from "../runtime/security/loopbackRpcSecurity.js";
import { startWebServer, type WebServerHandle } from "../webServer.js";

const token = "durable-engineering-test-token-123456";
const NACA_0012_POST_PANE_GEOMETRY_HASH = "99324fe31b74dcfaf49e011b6382adb9884fdb5945bfdac2414fb25c89a22593";
interface EngineeringJobDetail {
  status: string;
  currentStep?: string;
  trace: {
    toolDecisions: Array<Record<string, unknown>>;
    toolAttempts: Array<Record<string, unknown>>;
    outputs: Array<{
      promoted: boolean;
      engineeringPromotionId?: string;
      baselineId?: string;
      baselineRevision?: number;
      engineeringStatus?: "current" | "stale";
    }>;
  };
}
let root: string | undefined;
let server: WebServerHandle | undefined;

afterEach(async () => {
  if (server) await server.close();
  server = undefined;
  if (root) rmSync(root, { recursive: true, force: true });
  root = undefined;
  delete process.env.AETHEROPS_RPC_TOKEN;
});

describe("durable engineering job handler", () => {
  it("executes bundled WebXFOIL through the fenced tool trace and terminal promotion boundary", async () => {
    root = mkdtempSync(join(tmpdir(), "aetherops-durable-engineering-"));
    process.env.AETHEROPS_RPC_TOKEN = token;
    server = await startWebServer({
      port: 0,
      host: "127.0.0.1",
      dataRoot: root,
      appRoot: process.cwd(),
      installSignalHandlers: false
    });
    await enableEngineering(server);
    const project = await createEngineeringProject(server);
    const updated = await rpc(server, "projects.update", {
      projectId: project.id,
      expectedRevision: project.execution.revision,
      input: {},
      capabilities: { engineering: true }
    });
    expect(updated.ok).toBe(true);
    await activateEngineeringBaseline(server, project.id);

    const enqueued = await rpc(server, "engineering.enqueue", {
      projectId: project.id,
      idempotencyKey: "durable-webxfoil-naca0012",
      requestedCapabilities: { agent: true, engineering: true, search: false },
      requests: [
        {
          target: "webxfoil",
          objective: "Compute the explicitly requested NACA 0012 polar without solver substitution.",
          inputs: { naca: "0012", reynolds: 1_000_000, mach: 0, alphaStart: -2, alphaEnd: 2, alphaStep: 2 }
        }
      ]
    });
    expect(enqueued.ok).toBe(true);
    const receipt = enqueued.result as { jobId: string };
    const detail = await waitForTerminalJob(server, project.id, receipt.jobId);

    expect(detail.status, JSON.stringify(detail, null, 2)).toBe("completed");
    expect(detail.currentStep).toBe("EXECUTE_TOOLS");
    expect(detail.trace.toolDecisions).toEqual([expect.objectContaining({ toolName: "EngineeringProgramTool", policyStatus: "accepted" })]);
    expect(detail.trace.toolAttempts).toEqual([
      expect.objectContaining({ status: "completed", inputHash: expect.stringMatching(/^[a-f0-9]{64}$/), outputHash: expect.stringMatching(/^[a-f0-9]{64}$/) })
    ]);
    expect(detail.trace.outputs).toHaveLength(2);
    expect(detail.trace.outputs.every((output: { promoted: boolean }) => output.promoted)).toBe(true);
    expect(detail.trace.outputs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          engineeringPromotionId: expect.any(String),
          baselineId: expect.any(String),
          baselineRevision: 1,
          engineeringStatus: "current"
        }),
        expect.objectContaining({
          engineeringPromotionId: expect.any(String),
          baselineId: expect.any(String),
          baselineRevision: 1,
          engineeringStatus: "current"
        })
      ])
    );
    const promotionIds = detail.trace.outputs.map((output) => output.engineeringPromotionId as string);
    for (const promotionId of promotionIds) {
      const readback = await rpc(server, "engineering.artifact.read", { projectId: project.id, promotionId, maximumBytes: 65_536 });
      expect(readback.ok, JSON.stringify(readback, null, 2)).toBe(true);
      expect(readback.result).toMatchObject({ promotionId, artifactUri: `artifact://${promotionId}`, complete: true, baselineRevision: 1 });
    }
    const executionRoot = join(root, "ready", "jobs", receipt.jobId, `engineering-execution-${receipt.jobId}`);
    expect(existsSync(join(executionRoot, "manifest.json"))).toBe(true);
    expect(existsSync(join(root, "staging", "jobs", receipt.jobId, `engineering-execution-${receipt.jobId}`))).toBe(false);
    expect(existsSync(join(root, "quarantine", "jobs", receipt.jobId, `engineering-execution-${receipt.jobId}`))).toBe(false);

    await server.close();
    server = await startWebServer({ port: 0, host: "127.0.0.1", dataRoot: root, appRoot: process.cwd(), installSignalHandlers: false });
    for (const promotionId of promotionIds) {
      const restartedReadback = await rpc(server, "engineering.artifact.read", { projectId: project.id, promotionId, maximumBytes: 65_536 });
      expect(restartedReadback.ok, JSON.stringify(restartedReadback, null, 2)).toBe(true);
      expect(restartedReadback.result).toMatchObject({ promotionId, artifactUri: `artifact://${promotionId}`, complete: true, baselineRevision: 1 });
    }
    const changed = await activateEngineeringBaseline(server, project.id, 1, sha256("naca0012-changed-airfoil-geometry"));
    expect(changed.stalePromotionIds).toEqual(expect.arrayContaining(promotionIds));
    const staleDetailResponse = await rpc(server, "jobs.get", { projectId: project.id, jobId: receipt.jobId });
    expect(staleDetailResponse.ok).toBe(true);
    const staleDetail = staleDetailResponse.result as EngineeringJobDetail;
    expect(staleDetail.trace.outputs.every((output) => output.engineeringStatus === "stale")).toBe(true);
    for (const promotionId of promotionIds) {
      const denied = await rpc(server, "engineering.artifact.read", { projectId: project.id, promotionId, maximumBytes: 65_536 });
      expect(denied.ok).toBe(false);
      expect(denied.error).toMatchObject({ code: "NOT_READY", details: { reason: "ENGINEERING_ARTIFACT_NOT_CURRENT" } });
    }
  }, 45_000);
});

async function enableEngineering(handle: WebServerHandle): Promise<void> {
  const current = await rpc(handle, "settings.get", {});
  expect(current.ok).toBe(true);
  const settings = current.result as {
    codex: Record<string, unknown>;
    embedding: Record<string, unknown>;
    search: Record<string, unknown>;
    capabilities: Record<string, boolean>;
  };
  const embedding = withoutConfiguredFlag(settings.embedding);
  const search = withoutConfiguredFlag(settings.search);
  const saved = await rpc(handle, "settings.save", {
    codex: settings.codex,
    embedding,
    search,
    capabilities: { ...settings.capabilities, engineering: true }
  });
  expect(saved.ok).toBe(true);
}

async function activateEngineeringBaseline(
  handle: WebServerHandle,
  projectId: string,
  expectedRevision = 0,
  airfoilGeometryHash = NACA_0012_POST_PANE_GEOMETRY_HASH,
  geometryHash = NACA_0012_POST_PANE_GEOMETRY_HASH
): Promise<{ stalePromotionIds: string[] }> {
  const response = await rpc(handle, "engineering.baseline.activate", {
    projectId,
    expectedRevision,
    changeReason: "Pin the NACA 0012 geometry and coefficient references for the integration run.",
    baseline: {
      geometryHash,
      airfoilGeometryHash,
      aerodynamicReference: {
        area: quantity(1, "m^2", 2),
        chord: quantity(1, "m", 1),
        span: quantity(1, "m", 1),
        momentReferencePointId: "quarter-chord",
        axisConventionId: "wind-axes-right-handed-v1",
        dynamicPressureDefinition: "q=0.5*rho*V^2"
      },
      atmosphereModelId: "isa-1976-troposphere",
      unitConventionId: "si-v1",
      coordinateConventionId: "wind-axes-right-handed-v1",
      solverVersions: { "xfoil-wasm": "0.1.1" },
      materialRevisionIds: [],
      sourceRevisionIds: ["integration:naca0012"],
      equationVersionIds: ["aerodynamic-coefficients-v1"],
      createdBy: "integration-test",
      provenance: [{ id: "integration:naca0012", contentHash: geometryHash }]
    }
  });
  expect(response.ok, JSON.stringify(response, null, 2)).toBe(true);
  return response.result as { stalePromotionIds: string[] };
}

function quantity(value: number, unit: string, lengthExponent: number): Record<string, unknown> {
  return {
    kind: "scalar",
    valueSI: value,
    dimension: { mass: 0, length: lengthExponent, time: 0, temperature: 0, current: 0, amount: 0, luminousIntensity: 0, angle: 0 },
    semantic: "generic",
    originalValue: value,
    originalUnit: unit,
    displayUnit: unit,
    provenance: { sourceType: "user", sourceId: "integration:naca0012" },
    serializationVersion: 1
  };
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function createEngineeringProject(handle: WebServerHandle): Promise<{ id: string; execution: { revision: number } }> {
  const response = await rpc(handle, "projects.create", {
    input: {
      goal: "Verify a durable engineering execution receipt.",
      topic: "WebXFOIL durable integration",
      scope: "Bundled offline solver and fenced output promotion",
      budget: "bounded integration test"
    }
  });
  expect(response.ok).toBe(true);
  return response.result as { id: string; execution: { revision: number } };
}

async function waitForTerminalJob(handle: WebServerHandle, projectId: string, jobId: string): Promise<EngineeringJobDetail> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const response = await rpc(handle, "jobs.get", { projectId, jobId });
    expect(response.ok).toBe(true);
    const detail = response.result as EngineeringJobDetail;
    if (["completed", "blocked", "failed", "aborted", "interrupted"].includes(String(detail.status))) return detail;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Durable engineering job did not become terminal: ${jobId}`);
}

function withoutConfiguredFlag(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([key]) => key !== "apiKeyConfigured"));
}

let requestSequence = 0;
async function rpc(handle: WebServerHandle, method: string, params: unknown): Promise<{ ok: boolean; result?: unknown; error?: unknown }> {
  requestSequence += 1;
  const response = await fetch(`${handle.url}/api/v2/rpc`, {
    method: "POST",
    headers: { "Content-Type": "application/json; charset=utf-8", [rpcTokenHeader]: token },
    body: JSON.stringify({ requestId: `durable-engineering-${requestSequence}`, method, params })
  });
  return (await response.json()) as { ok: boolean; result?: unknown; error?: unknown };
}
