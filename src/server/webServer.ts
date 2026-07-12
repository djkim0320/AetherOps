import { mkdir } from "node:fs/promises";
import { createServer } from "node:http";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { AetherOpsOrchestrator } from "../core/orchestration/orchestrator.js";
import { ApiEmbeddingProvider } from "../core/providers/embeddingProvider.js";
import { VectorRagEngine } from "../core/retrieval/vectorRagEngine.js";
import { dedupeResearchTools, ToolRunner } from "../core/tools/toolRunner.js";
import { CodexCliTool } from "../core/tools/codexCliTool.js";
import { DurableJobRuntime } from "./composition/durableJobRuntime.js";
import { registerDurableJobHandlers } from "./composition/registerDurableJobHandlers.js";
import { runRequiredMigration } from "./composition/migrationGate.js";
import { healthPayload, readPackageVersion } from "./http/health.js";
import { readJsonBody } from "./http/jsonBody.js";
import { HttpError, sendJson } from "./http/response.js";
import { serveStatic } from "./http/staticFiles.js";
import { handleRpcV2, RpcV2Error } from "./http/v2/rpcRouter.js";
import { serveProjectEvents } from "./http/v2/sseController.js";
import { BackgroundBrowserRuntime } from "./runtime/browser/backgroundBrowserRuntime.js";
import { BrowserResearchTool } from "./runtime/browser/browserResearchTool.js";
import { CodexOAuthLlmProvider } from "./runtime/codex/codexOAuthLlmProvider.js";
import { CodexCliAdapter } from "./runtime/codex/codexCliAdapter.js";
import { buildServerRuntimeToolDiagnostics } from "./runtime/engineering/runtimeEngineeringDiagnostics.js";
import {
  addRestrictedCorsHeaders,
  assertLoopbackHostAllowed,
  authenticateRpcRequest,
  resolveLoopbackRpcSecurity,
  setRpcTokenCookie
} from "./runtime/security/loopbackRpcSecurity.js";
import { createLegacyStorageWorker } from "./runtime/storage/worker/legacyStorageClient.js";
import { createRuntimeResearchTools } from "./runtime/tools/defaultResearchTools.js";
import { FileToolExecutionWorkspace } from "./runtime/tools/toolExecutionWorkspace.js";

// UTF-8 request decoding is delegated to readJsonBody, which uses decodeStrictUtf8Chunks.
// Static UTF-8 contracts are delegated to staticFiles: return "text/markdown; charset=utf-8",
// return "text/plain; charset=utf-8", and return "application/json; charset=utf-8".

interface WebServerOptions {
  port?: number;
  host?: string;
  dataRoot?: string;
  appRoot?: string;
  installSignalHandlers?: boolean;
}

export interface WebServerHandle {
  host: string;
  port: number;
  url: string;
  close(): Promise<void>;
}

const defaultHost = "127.0.0.1";
const defaultPort = 5179;

export async function startWebServer(options: WebServerOptions = {}): Promise<WebServerHandle> {
  const appRoot = resolve(options.appRoot ?? process.cwd());
  const dataRoot = resolve(options.dataRoot ?? process.env.AETHEROPS_DATA_DIR ?? join(appRoot, ".aetherops"));
  const effectiveHost = options.host ?? process.env.AETHEROPS_HOST ?? defaultHost;
  assertLoopbackHostAllowed(effectiveHost);
  const startedAt = new Date().toISOString();
  const version = await readPackageVersion(appRoot);
  let actualPort = options.port ?? defaultPort;
  await mkdir(dataRoot, { recursive: true });
  await runRequiredMigration(appRoot, dataRoot);

  const rpcSecurity = resolveLoopbackRpcSecurity({ dataRoot, env: process.env });
  const legacyStorage = createLegacyStorageWorker(join(dataRoot, "migration", "v2", "legacy-research.sqlite"), join(dataRoot, "settings.json"));
  const store = legacyStorage.researchStore;
  const settingsStore = legacyStorage.settingsStore;
  const jobs = new DurableJobRuntime(join(dataRoot, "migration", "v2", "storage.sqlite"));
  const settings = () => settingsStore.getRuntimeSettings();
  let cachedEmbeddingKey = "";
  let cachedEmbeddingProvider: ApiEmbeddingProvider | undefined;
  const embeddingProvider = {
    embed: async (text: string) => {
      const runtimeSettings = await settings();
      const embeddingKey = JSON.stringify(runtimeSettings.embedding);
      if (!cachedEmbeddingProvider || cachedEmbeddingKey !== embeddingKey) {
        cachedEmbeddingKey = embeddingKey;
        cachedEmbeddingProvider = new ApiEmbeddingProvider(runtimeSettings.embedding);
      }
      return cachedEmbeddingProvider.embed(text);
    }
  };
  const llm = new CodexOAuthLlmProvider({
    appRoot,
    settings: async () => {
      const { codex } = await settingsStore.getRuntimeSettings();
      return {
        model: codex.model,
        reasoningEffort: codex.reasoningEffort,
        timeoutMs: codex.timeoutMs
      };
    }
  });
  const codexCli = new CodexCliAdapter({ appRoot });
  const browserRuntime = new BackgroundBrowserRuntime(dataRoot);
  const toolRunner = new ToolRunner(
    dedupeResearchTools([...createRuntimeResearchTools(), new BrowserResearchTool(browserRuntime), new CodexCliTool(codexCli)]),
    new FileToolExecutionWorkspace(dataRoot)
  );
  const orchestrator = new AetherOpsOrchestrator(
    store,
    codexCli,
    new VectorRagEngine(embeddingProvider),
    join(dataRoot, "projects"),
    llm,
    legacyStorage.projectStorage,
    embeddingProvider,
    settings,
    toolRunner,
    (runtimeSettings) => buildServerRuntimeToolDiagnostics(runtimeSettings)
  );
  registerDurableJobHandlers({ dataRoot, orchestrator, settingsStore, jobs, events: jobs, codexCli });
  await jobs.initialize();

  const server = createServer(async (request, response) => {
    try {
      if (!addRestrictedCorsHeaders(request, response, { host: effectiveHost, port: actualPort, env: process.env })) {
        sendJson(response, 403, { ok: false, error: "CORS origin is not allowed." });
        return;
      }
      if (request.method === "OPTIONS") {
        response.writeHead(204);
        response.end();
        return;
      }
      const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
      if (url.pathname === "/api/health") {
        setRpcTokenCookie(response, rpcSecurity.token);
        sendJson(response, 200, healthPayload({ port: actualPort, startedAt, version, dataRoot }));
        return;
      }
      if (url.pathname === "/api/v2/rpc" && request.method === "POST") {
        const authFailure = authenticateRpcRequest(request, rpcSecurity.token);
        if (authFailure) throw new HttpError(authFailure.status, authFailure.message);
        const body = await readJsonBody(request, { label: "RPC request body" });
        const routed = await handleRpcV2(body, {
          appRoot,
          dataRoot,
          host: effectiveHost,
          port: actualPort,
          startedAt,
          version,
          env: process.env,
          llm,
          orchestrator,
          settingsStore,
          events: jobs,
          jobs
        });
        sendJson(response, 200, { requestId: routed.requestId, ok: true, result: routed.result });
        return;
      }
      if (url.pathname === "/api/v2/events" && request.method === "GET") {
        const authFailure = authenticateRpcRequest(request, rpcSecurity.token);
        if (authFailure) throw new HttpError(authFailure.status, authFailure.message);
        await serveProjectEvents(request, response, url, jobs);
        return;
      }
      if (url.pathname.startsWith("/api/")) {
        sendJson(response, 404, { ok: false, error: "Not found." });
        return;
      }
      if (request.method === "GET") setRpcTokenCookie(response, rpcSecurity.token);
      await serveStatic(appRoot, url.pathname, response);
    } catch (error) {
      if (error instanceof RpcV2Error) {
        sendJson(response, error.status, {
          requestId: error.requestId,
          ok: false,
          error: { code: error.code, message: error.message, ...(error.details ? { details: error.details } : {}) }
        });
        return;
      }
      const status = error instanceof HttpError ? error.status : 500;
      sendJson(response, status, { ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  });

  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    llm.dispose();
    await codexCli.dispose();
    await jobs.close();
    await legacyStorage.close();
    await new Promise<void>((resolveClose, rejectClose) => server.close((error) => (error ? rejectClose(error) : resolveClose())));
  };
  if (options.installSignalHandlers !== false) {
    const shutdown = () => void close();
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
  }
  return new Promise<WebServerHandle>((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(options.port ?? defaultPort, effectiveHost, () => {
      server.off("error", rejectListen);
      const address = server.address();
      actualPort = typeof address === "object" && address ? address.port : (options.port ?? defaultPort);
      const url = `http://${effectiveHost}:${actualPort}`;
      resolveListen({ host: effectiveHost, port: actualPort, url, close });
    });
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void startWebServer({ port: Number(process.env.AETHEROPS_PORT ?? defaultPort), host: process.env.AETHEROPS_HOST ?? defaultHost });
}
