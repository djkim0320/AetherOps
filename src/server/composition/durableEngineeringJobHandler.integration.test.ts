import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { rpcTokenHeader } from "../runtime/security/loopbackRpcSecurity.js";
import { startWebServer, type WebServerHandle } from "../webServer.js";

const token = "durable-engineering-test-token-123456";
interface EngineeringJobDetail {
  status: string;
  currentStep?: string;
  trace: {
    toolDecisions: Array<Record<string, unknown>>;
    toolAttempts: Array<Record<string, unknown>>;
    outputs: Array<{ promoted: boolean }>;
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
    const executionRoot = join(root, "ready", "jobs", receipt.jobId, `engineering-execution-${receipt.jobId}`);
    expect(existsSync(join(executionRoot, "manifest.json"))).toBe(true);
    expect(existsSync(join(root, "staging", "jobs", receipt.jobId, `engineering-execution-${receipt.jobId}`))).toBe(false);
    expect(existsSync(join(root, "quarantine", "jobs", receipt.jobId, `engineering-execution-${receipt.jobId}`))).toBe(false);
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
