import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createStrictTestOrchestrator, strictTestSettings } from "../core/testing/orchestratorTestHarness.js";
import type { ResearchProjectInput } from "../core/shared/types.js";
import { assertLoopbackHostAllowed, rpcAuthConfigFileName, rpcTokenCookieName, rpcTokenHeader } from "./runtime/security/loopbackRpcSecurity.js";
import { NodeProjectStorage } from "./runtime/storage/projectResearchStore.js";
import { SqliteResearchStore } from "./runtime/storage/sqliteStore.js";
import { runEngineeringProgramDirect } from "./http/directEngineering.js";
import { startWebServer, type WebServerHandle } from "./webServer.js";

let tempDir: string | undefined;
let store: SqliteResearchStore | undefined;
let serverHandle: WebServerHandle | undefined;

const rpcToken = "test-rpc-token-1234567890";
const originalEnv = {
  AETHEROPS_RPC_TOKEN: process.env.AETHEROPS_RPC_TOKEN,
  AETHEROPS_DEBUG_HEALTH: process.env.AETHEROPS_DEBUG_HEALTH,
  AETHEROPS_HOST: process.env.AETHEROPS_HOST,
  AETHEROPS_ALLOW_NON_LOOPBACK_HOST: process.env.AETHEROPS_ALLOW_NON_LOOPBACK_HOST,
  AETHEROPS_UI_ORIGIN: process.env.AETHEROPS_UI_ORIGIN,
  AETHEROPS_UI_PORT: process.env.AETHEROPS_UI_PORT
};

afterEach(async () => {
  vi.restoreAllMocks();
  if (serverHandle) {
    await serverHandle.close();
    serverHandle = undefined;
  }
  store?.close();
  store = undefined;
  if (tempDir) {
    rmSync(tempDir, { recursive: true, force: true });
    tempDir = undefined;
  }
  restoreEnv();
});

describe("web server security boundary", () => {
  it("requires the loopback RPC token and differentiates missing from invalid tokens", async () => {
    const server = await startTestServer();

    const missing = await postRpc(server, "settings.get", {});
    expect(missing.status).toBe(401);
    expect(await missing.json()).toMatchObject({ ok: false, error: { code: "CAPABILITY_DENIED", message: "RPC token is required." } });

    const invalid = await postRpc(server, "settings.get", {}, "wrong-rpc-token-123456");
    expect(invalid.status).toBe(403);
    expect(await invalid.json()).toMatchObject({ ok: false, error: { code: "CAPABILITY_DENIED", message: "RPC token is invalid." } });

    const valid = await postRpc(server, "settings.get", {}, rpcToken);
    expect(valid.status).toBe(200);
    const payload = (await valid.json()) as { requestId?: string; ok?: boolean; result?: unknown };
    expect(payload.requestId).toMatch(/^test-request-/);
    expect(payload.ok).toBe(true);
    expect(payload.result).toMatchObject({
      codex: { reasoningEffort: "xhigh" },
      capabilities: { agent: true, engineering: false, search: expect.any(Boolean) }
    });
  });

  it("generates and reuses a data-root RPC token config when no env token is set", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "aetherops-web-security-"));
    delete process.env.AETHEROPS_RPC_TOKEN;

    serverHandle = await startWebServer({
      port: 0,
      host: "127.0.0.1",
      dataRoot: tempDir,
      appRoot: process.cwd(),
      installSignalHandlers: false
    });
    const firstConfig = JSON.parse(readFileSync(join(tempDir, rpcAuthConfigFileName), "utf8")) as { token?: string };
    expect(firstConfig.token).toMatch(/^[A-Za-z0-9_-]{32,}$/);
    expect((await postRpc(serverHandle, "settings.get", {}, firstConfig.token)).status).toBe(200);

    await serverHandle.close();
    serverHandle = undefined;

    serverHandle = await startWebServer({
      port: 0,
      host: "127.0.0.1",
      dataRoot: tempDir,
      appRoot: process.cwd(),
      installSignalHandlers: false
    });
    const secondConfig = JSON.parse(readFileSync(join(tempDir, rpcAuthConfigFileName), "utf8")) as { token?: string };
    expect(secondConfig.token).toBe(firstConfig.token);
    expect((await postRpc(serverHandle, "settings.get", {}, secondConfig.token)).status).toBe(200);
  });

  it("restricts CORS to loopback UI origins without wildcard reflection", async () => {
    const server = await startTestServer();

    const allowed = await fetch(`${server.url}/api/v2/rpc`, {
      method: "OPTIONS",
      headers: { Origin: "http://127.0.0.1:5180", "Access-Control-Request-Method": "POST" }
    });
    expect(allowed.status).toBe(204);
    expect(allowed.headers.get("access-control-allow-origin")).toBe("http://127.0.0.1:5180");
    expect(allowed.headers.get("access-control-allow-origin")).not.toBe("*");
    expect(allowed.headers.get("access-control-allow-headers")).toContain(rpcTokenHeader);

    const denied = await fetch(`${server.url}/api/v2/rpc`, {
      method: "OPTIONS",
      headers: { Origin: "https://evil.example", "Access-Control-Request-Method": "POST" }
    });
    expect(denied.status).toBe(403);
    expect(denied.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("redacts dataRoot and pid from health unless debug health is enabled", async () => {
    const server = await startTestServer();
    const response = await fetch(`${server.url}/api/health`);
    const payload = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(200);
    const cookie = response.headers.get("set-cookie") ?? "";
    expect(cookie).toContain(`${rpcTokenCookieName}=`);
    expect(cookie).toMatch(/;\s*HttpOnly(?:;|$)/i);
    expect(cookie).toMatch(/;\s*SameSite=Strict(?:;|$)/i);
    expect(payload).toMatchObject({ ok: true, mode: "web", port: server.port });
    expect(payload.dataRoot).toBeUndefined();
    expect(payload.pid).toBeUndefined();
  });

  it("exposes health debug fields only when explicitly enabled", async () => {
    process.env.AETHEROPS_DEBUG_HEALTH = "true";
    const server = await startTestServer();
    const response = await fetch(`${server.url}/api/health`);
    const payload = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(payload.dataRoot).toBe(tempDir);
    expect(payload.pid).toBe(process.pid);
  });

  it("refuses non-loopback host binding even when the retired opt-in is present", () => {
    process.env.AETHEROPS_ALLOW_NON_LOOPBACK_HOST = "true";

    expect(() => assertLoopbackHostAllowed("0.0.0.0", process.env)).toThrow("AetherOps supports loopback hosts only");
  });

  it("rejects positional args and malformed named params before dispatch", async () => {
    const server = await startTestServer();

    const positional = await fetch(`${server.url}/api/v2/rpc`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        [rpcTokenHeader]: rpcToken
      },
      body: JSON.stringify({ requestId: "legacy-positional", method: "projects.list", args: [] })
    });
    expect(positional.status).toBe(400);
    expect(await positional.json()).toMatchObject({
      requestId: "legacy-positional",
      ok: false,
      error: { code: "VALIDATION_ERROR" }
    });

    const badSettings = await postRpc(server, "settings.save", { capabilities: { agent: true, engineering: false, search: "true" } }, rpcToken);
    expect(badSettings.status).toBe(400);
    expect(await badSettings.json()).toMatchObject({ ok: false, error: { code: "VALIDATION_ERROR" } });

    const badProject = await postRpc(server, "projects.create", { input: { goal: "g", topic: "t" } }, rpcToken);
    expect(badProject.status).toBe(400);
    expect(await badProject.json()).toMatchObject({ ok: false, error: { code: "VALIDATION_ERROR" } });
  });

  it("returns 404 for the retired legacy RPC endpoint", async () => {
    const server = await startTestServer();
    const response = await fetch(`${server.url}/api/rpc`, {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8", [rpcTokenHeader]: rpcToken },
      body: JSON.stringify({ method: "projects.list", args: [] })
    });

    expect(response.status).toBe(404);
  });

  it("enforces the health, static, and RPC HTTP protocol matrix", async () => {
    const server = await startTestServer();

    const healthPost = await fetch(`${server.url}/api/health`, { method: "POST" });
    expect(healthPost.status).toBe(405);
    expect(healthPost.headers.get("allow")).toBe("GET, HEAD");

    const healthHead = await fetch(`${server.url}/api/health`, { method: "HEAD" });
    expect(healthHead.status).toBe(200);
    expect(await healthHead.text()).toBe("");

    const staticGet = await fetch(`${server.url}/`);
    const staticHead = await fetch(`${server.url}/`, { method: "HEAD" });
    expect(staticHead.status).toBe(200);
    expect(staticHead.headers.get("content-type")).toBe(staticGet.headers.get("content-type"));
    expect(staticHead.headers.get("content-length")).toBe(staticGet.headers.get("content-length"));
    expect(await staticHead.text()).toBe("");
    expect(staticHead.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    expect(staticHead.headers.get("x-content-type-options")).toBe("nosniff");
    expect(staticHead.headers.get("referrer-policy")).toBe("no-referrer");

    const staticPut = await fetch(`${server.url}/`, { method: "PUT", body: "ignored" });
    expect(staticPut.status).toBe(405);
    expect(staticPut.headers.get("allow")).toBe("GET, HEAD");

    const wrongMediaType = await fetch(`${server.url}/api/v2/rpc`, {
      method: "POST",
      headers: { "Content-Type": "text/plain", [rpcTokenHeader]: rpcToken },
      body: JSON.stringify({ requestId: "wrong-media", method: "projects.list", params: {} })
    });
    expect(wrongMediaType.status).toBe(415);
    expect(await wrongMediaType.json()).toMatchObject({ ok: false, error: { code: "VALIDATION_ERROR" } });

    const compressed = await fetch(`${server.url}/api/v2/rpc`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Content-Encoding": "gzip", [rpcTokenHeader]: rpcToken },
      body: "not-compressed"
    });
    expect(compressed.status).toBe(415);
  });

  it("applies explicit conservative HTTP ingress limits without limiting long RPC handler execution", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "aetherops-web-timeouts-"));
    process.env.AETHEROPS_RPC_TOKEN = rpcToken;
    serverHandle = await startWebServer({
      port: 0,
      host: "127.0.0.1",
      dataRoot: tempDir,
      appRoot: process.cwd(),
      installSignalHandlers: false,
      httpPolicy: {
        headersTimeoutMs: 12_000,
        requestTimeoutMs: 90_000,
        bodyReadTimeoutMs: 15_000,
        keepAliveTimeoutMs: 4_000,
        maxRequestsPerSocket: 25,
        connectionsCheckingIntervalMs: 2_000
      }
    });

    expect(serverHandle.httpPolicy).toEqual({
      headersTimeoutMs: 12_000,
      requestTimeoutMs: 90_000,
      bodyReadTimeoutMs: 15_000,
      keepAliveTimeoutMs: 4_000,
      maxRequestsPerSocket: 25,
      connectionsCheckingIntervalMs: 2_000
    });
  });

  it("handles malformed HTTP at the socket boundary without logging or returning packet contents", async () => {
    const server = await startTestServer();
    const diagnostic = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const secretMarker = "client-error-secret-marker";

    const rawResponse = await sendRawHttp(server, `GET / HTTP/1.1\r\nHost: 127.0.0.1\r\nCookie: session=${secretMarker}\r\nInvalid Header\r\n\r\n`);

    expect(rawResponse).toMatch(/^HTTP\/1\.1 400 Bad Request\r\n/);
    expect(rawResponse).toContain("Connection: close");
    expect(rawResponse).not.toContain(secretMarker);
    expect(diagnostic).toHaveBeenCalledOnce();
    expect(String(diagnostic.mock.calls[0]?.[0])).not.toContain(secretMarker);
  });

  it("authenticates SSE with the HttpOnly cookie and replays committed events", async () => {
    const server = await startTestServer();
    const project = await createProject(server, rpcToken);
    const health = await fetch(`${server.url}/api/health`);
    const cookie = (health.headers.get("set-cookie") ?? "").split(";", 1)[0];

    const missing = await fetch(`${server.url}/api/v2/events?projectId=${encodeURIComponent(project.id)}`);
    expect(missing.status).toBe(401);

    const updated = await postRpc(
      server,
      "projects.update",
      {
        projectId: project.id,
        expectedRevision: project.execution.revision,
        input: { topic: "Updated through API v2" }
      },
      rpcToken
    );
    expect(updated.status).toBe(200);

    const controller = new AbortController();
    const stream = await fetch(`${server.url}/api/v2/events?projectId=${encodeURIComponent(project.id)}`, {
      headers: { Cookie: cookie, "Last-Event-ID": "0" },
      signal: controller.signal
    });
    expect(stream.status).toBe(200);
    expect(stream.headers.get("content-type")).toContain("text/event-stream");
    const chunk = await readSseChunk(stream, controller);
    expect(chunk).toContain("event: project.snapshot.changed");
    expect(chunk).toContain('"reason":"project_updated"');
  });

  it("persists projects across a server restart using the same data root", async () => {
    const server = await startTestServer();
    const project = await createProject(server, rpcToken);
    const updated = await postRpc(
      server,
      "projects.update",
      {
        projectId: project.id,
        expectedRevision: project.execution.revision,
        input: { scope: "Restart and durable SSE replay" }
      },
      rpcToken
    );
    expect(updated.status).toBe(200);
    await server.close();
    serverHandle = undefined;

    serverHandle = await startWebServer({
      port: 0,
      host: "127.0.0.1",
      dataRoot: tempDir,
      appRoot: process.cwd(),
      installSignalHandlers: false
    });
    const persisted = await postRpc(serverHandle, "projects.get", { projectId: project.id }, rpcToken);
    expect(persisted.status).toBe(200);
    expect(await persisted.json()).toMatchObject({
      ok: true,
      result: { id: project.id, input: { topic: "API v2 persistence" } }
    });

    const controller = new AbortController();
    const replay = await fetch(`${serverHandle.url}/api/v2/events?projectId=${encodeURIComponent(project.id)}`, {
      headers: { [rpcTokenHeader]: rpcToken, "Last-Event-ID": "0" },
      signal: controller.signal
    });
    expect(replay.status).toBe(200);
    expect(await readSseChunk(replay, controller)).toContain("event: project.snapshot.changed");
  });

  it("closes idempotently with an open SSE connection and permits a same-port restart", async () => {
    const server = await startTestServer();
    const project = await createProject(server, rpcToken);
    const stream = await fetch(`${server.url}/api/v2/events?projectId=${encodeURIComponent(project.id)}`, {
      headers: { [rpcTokenHeader]: rpcToken }
    });
    expect(stream.status).toBe(200);

    const firstClose = server.close();
    const secondClose = server.close();
    expect(firstClose).toBe(secondClose);
    await firstClose;
    expect(server.state).toBe("CLOSED");
    serverHandle = undefined;

    serverHandle = await startWebServer({
      port: server.port,
      host: "127.0.0.1",
      dataRoot: tempDir,
      appRoot: process.cwd(),
      installSignalHandlers: false
    });
    expect(serverHandle.port).toBe(server.port);
    expect((await fetch(`${serverHandle.url}/api/health`)).status).toBe(200);
  });
});

describe("web server engineering program RPC", () => {
  it("runs the bundled solver and persists the direct engineering report under project reports", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "aetherops-engineering-rpc-"));
    store = new SqliteResearchStore(join(tempDir, "aetherops.sqlite"));
    const settings = {
      ...strictTestSettings,
      allowExternalSearch: true,
      allowCodeExecution: true,
      engineeringTools: {
        ...strictTestSettings.engineeringTools,
        enabled: true,
        modeling: {
          ...strictTestSettings.engineeringTools.modeling,
          enabled: true,
          artifactRoot: join(process.cwd(), "src", "test", "fixtures", "airfoils")
        }
      }
    };
    const orchestrator = createStrictTestOrchestrator({
      store,
      storage: new NodeProjectStorage(),
      projectRootBase: join(tempDir, "projects"),
      settings
    });
    const projectInput: ResearchProjectInput = {
      goal: "Run a real WebXFOIL aerodynamic polar analysis and save the report.",
      topic: "WebXFOIL direct report persistence",
      scope: "Server RPC direct engineering program operation",
      budget: "test",
      autonomyPolicy: {
        toolApproval: "suggested",
        allowExternalSearch: true,
        allowCodeExecution: true,
        maxLoopIterations: 1
      }
    };
    const snapshot = await orchestrator.createProject(projectInput);

    const result = await runEngineeringProgramDirect(
      {
        projectId: snapshot.project.id,
        title: "Clark Y WebXFOIL polar analysis",
        programRequests: [
          {
            kind: "xfoil-wasm-polar",
            target: "xfoil-wasm",
            artifactPath: "clark-y.dat",
            reynolds: 1_000_000,
            mach: 0,
            alphaStart: -2,
            alphaEnd: 2,
            alphaStep: 2
          }
        ]
      },
      settings,
      orchestrator
    );

    expect(result.error).toBeUndefined();
    expect(result.status).toBe("completed");
    expect(result.savedReportArtifact).toMatchObject({
      relativePath: "reports/engineering-program-workbench.md",
      mimeType: "text/markdown"
    });
    expect(result.reportMarkdown).toContain("# Clark Y WebXFOIL polar analysis");
    expect(result.reportMarkdown).toContain("Runtime: webxfoil-wasm");
    expect(result.reportMarkdown).toContain("Clark Y WebXFOIL polar analysis");

    const latest = await orchestrator.getSnapshot(snapshot.project.id);
    const saved = latest.artifacts.find((artifact) => artifact.id === result.savedReportArtifact?.id);
    expect(saved).toBeDefined();
    expect(saved?.relativePath).toBe("reports/engineering-program-workbench.md");
    expect(saved?.rawPath).toBe(join(snapshot.project.projectRoot, "reports", "engineering-program-workbench.md"));
    expect(existsSync(saved?.rawPath ?? "")).toBe(true);
    const savedMarkdown = readFileSync(saved?.rawPath ?? "", "utf8");
    expect(savedMarkdown).toContain("# Clark Y WebXFOIL polar analysis");
    expect(savedMarkdown).toContain("Artifacts: 1");
    expect(savedMarkdown).toContain("Evidence items: 1");
  }, 30_000);

  it("requires project-scoped direct engineering and rejects requests without an airfoil input", async () => {
    const settings = {
      ...strictTestSettings,
      allowCodeExecution: true,
      engineeringTools: {
        ...strictTestSettings.engineeringTools,
        enabled: true
      }
    };

    tempDir = mkdtempSync(join(tmpdir(), "aetherops-web-program-invalid-"));
    store = new SqliteResearchStore(join(tempDir, "aetherops.sqlite"));
    const orchestrator = createStrictTestOrchestrator({
      store,
      storage: new NodeProjectStorage(),
      projectRootBase: join(tempDir, "projects"),
      settings
    });

    await expect(
      runEngineeringProgramDirect(
        {
          projectId: "validation-only",
          title: "Invalid WebXFOIL request",
          programRequests: [
            {
              kind: "xfoil-wasm-polar",
              target: "xfoil-wasm",
              reynolds: 1_000_000
            }
          ]
        },
        settings,
        orchestrator
      )
    ).rejects.toThrow("xfoil-wasm-polar requires sourceUrl, artifactPath, or naca.");
  });
});

async function startTestServer(): Promise<WebServerHandle> {
  tempDir = mkdtempSync(join(tmpdir(), "aetherops-web-security-"));
  process.env.AETHEROPS_RPC_TOKEN = rpcToken;
  serverHandle = await startWebServer({
    port: 0,
    host: "127.0.0.1",
    dataRoot: tempDir,
    appRoot: process.cwd(),
    installSignalHandlers: false
  });
  return serverHandle;
}

let requestSequence = 0;

function postRpc(server: WebServerHandle, method: string, params: unknown, token?: string): Promise<Response> {
  const headers: Record<string, string> = { "Content-Type": "application/json; charset=utf-8" };
  if (token !== undefined) headers[rpcTokenHeader] = token;
  requestSequence += 1;
  return fetch(`${server.url}/api/v2/rpc`, {
    method: "POST",
    headers,
    body: JSON.stringify({ requestId: `test-request-${requestSequence}`, method, params })
  });
}

async function createProject(server: WebServerHandle, token: string): Promise<{ id: string; execution: { revision: number } }> {
  const response = await postRpc(
    server,
    "projects.create",
    {
      input: {
        goal: "Verify the canonical API v2 server contract.",
        topic: "API v2 persistence",
        scope: "Loopback integration test",
        budget: "offline test"
      }
    },
    token
  );
  expect(response.status).toBe(200);
  const payload = (await response.json()) as {
    result: { id: string; execution: { revision: number } };
  };
  return payload.result;
}

async function readSseChunk(response: Response, controller: AbortController): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("SSE response did not expose a body reader.");
  const timeout = setTimeout(() => controller.abort(), 5_000);
  try {
    const decoder = new TextDecoder();
    let text = "";
    while (!text.includes("\n\n")) {
      const item = await reader.read();
      if (item.done) break;
      text += decoder.decode(item.value, { stream: true });
    }
    return text;
  } finally {
    clearTimeout(timeout);
    controller.abort();
    await reader.cancel().catch(() => undefined);
  }
}

function sendRawHttp(server: WebServerHandle, request: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect({ host: server.host, port: server.port });
    const chunks: Buffer[] = [];
    socket.setTimeout(5_000, () => socket.destroy(new Error("Raw HTTP response timed out.")));
    socket.on("connect", () => socket.end(request));
    socket.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    socket.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    socket.on("error", reject);
  });
}

function restoreEnv(): void {
  restoreEnvValue("AETHEROPS_RPC_TOKEN", originalEnv.AETHEROPS_RPC_TOKEN);
  restoreEnvValue("AETHEROPS_DEBUG_HEALTH", originalEnv.AETHEROPS_DEBUG_HEALTH);
  restoreEnvValue("AETHEROPS_HOST", originalEnv.AETHEROPS_HOST);
  restoreEnvValue("AETHEROPS_ALLOW_NON_LOOPBACK_HOST", originalEnv.AETHEROPS_ALLOW_NON_LOOPBACK_HOST);
  restoreEnvValue("AETHEROPS_UI_ORIGIN", originalEnv.AETHEROPS_UI_ORIGIN);
  restoreEnvValue("AETHEROPS_UI_PORT", originalEnv.AETHEROPS_UI_PORT);
}

function restoreEnvValue(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
    return;
  }
  process.env[key] = value;
}
