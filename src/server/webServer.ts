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
import { createServerRequestId, internalErrorMessage, logInternalError } from "./http/errorBoundary.js";
import { readJsonBody } from "./http/jsonBody.js";
import { HttpError, sendJson } from "./http/response.js";
import { serveStatic } from "./http/staticFiles.js";
import { closeResourcesInOrder, ServerDrainController, type ServerLifecycleState } from "./http/serverDrain.js";
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
import { sanitizeTraceRecord } from "./runtime/security/traceSanitizer.js";

// UTF-8 request decoding is delegated to readJsonBody, which uses decodeStrictUtf8Chunks.
// Static UTF-8 contracts are delegated to staticFiles: return "text/markdown; charset=utf-8",
// return "text/plain; charset=utf-8", and return "application/json; charset=utf-8".

interface WebServerOptions {
  port?: number;
  host?: string;
  dataRoot?: string;
  appRoot?: string;
  installSignalHandlers?: boolean;
  shutdownGraceMs?: number;
}

export interface WebServerHandle {
  host: string;
  port: number;
  url: string;
  readonly state: ServerLifecycleState;
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
  const drain = new ServerDrainController(normalizeShutdownGrace(options.shutdownGraceMs ?? Number(process.env.AETHEROPS_SHUTDOWN_GRACE_MS ?? 10_000)));
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
    const lease = drain.begin(request, response);
    if (!lease) {
      sendJson(response, 503, { ok: false, error: "Server is shutting down." }, { headers: { "Retry-After": "1" } });
      return;
    }
    const requestStartedAt = Date.now();
    const operation = `${request.method ?? "UNKNOWN"} ${(request.url ?? "/").split("?", 1)[0]}`;
    const serverRequestId = createServerRequestId();
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
        if (request.method !== "GET" && request.method !== "HEAD") {
          sendJson(response, 405, { ok: false, error: "Method not allowed." }, { headers: { Allow: "GET, HEAD" } });
          return;
        }
        setRpcTokenCookie(response, rpcSecurity.token);
        sendJson(response, 200, healthPayload({ port: actualPort, startedAt, version, dataRoot }), { head: request.method === "HEAD" });
        return;
      }
      if (url.pathname === "/api/v2/rpc") {
        if (request.method !== "POST") {
          sendJson(response, 405, { ok: false, error: "Method not allowed." }, { headers: { Allow: "POST" } });
          return;
        }
        const authFailure = authenticateRpcRequest(request, rpcSecurity.token);
        if (authFailure) throw new HttpError(authFailure.status, authFailure.message);
        assertJsonRequest(request);
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
      if (url.pathname === "/api/v2/events") {
        if (request.method !== "GET") {
          sendJson(response, 405, { ok: false, error: "Method not allowed." }, { headers: { Allow: "GET" } });
          return;
        }
        const authFailure = authenticateRpcRequest(request, rpcSecurity.token);
        if (authFailure) throw new HttpError(authFailure.status, authFailure.message);
        drain.trackSse(response, await serveProjectEvents(request, response, url, jobs));
        return;
      }
      if (url.pathname.startsWith("/api/")) {
        sendJson(response, 404, { ok: false, error: "Not found." });
        return;
      }
      if (request.method !== "GET" && request.method !== "HEAD") {
        sendJson(response, 405, { ok: false, error: "Method not allowed." }, { headers: { Allow: "GET, HEAD" } });
        return;
      }
      setRpcTokenCookie(response, rpcSecurity.token);
      await serveStatic(appRoot, url.pathname, response, { head: request.method === "HEAD" });
    } catch (error) {
      if (error instanceof RpcV2Error) {
        if (error.code === "INTERNAL_ERROR") {
          logInternalError(error.cause ?? error, { requestId: error.requestId, operation, startedAt: requestStartedAt });
        }
        sendJson(response, error.status, {
          requestId: error.requestId,
          ok: false,
          error: { code: error.code, message: error.message, ...(error.details ? { details: sanitizeTraceRecord(error.details) } : {}) }
        });
        return;
      }
      const status = error instanceof HttpError ? error.status : 500;
      const message = error instanceof HttpError && status < 500 ? error.message : internalErrorMessage;
      if (!(error instanceof HttpError) || status >= 500) {
        logInternalError(error, { requestId: serverRequestId, operation, startedAt: requestStartedAt });
      }
      if ((request.url ?? "").startsWith("/api/v2/")) {
        sendJson(response, status, {
          requestId: serverRequestId,
          ok: false,
          error: { code: httpStatusErrorCode(status), message }
        });
        return;
      }
      sendJson(response, status, { requestId: serverRequestId, ok: false, error: message });
    } finally {
      lease.release();
    }
  });

  let signalHandlers: { sigint: () => void; sigterm: () => void } | undefined;
  const removeSignalHandlers = (): void => {
    if (!signalHandlers) return;
    process.off("SIGINT", signalHandlers.sigint);
    process.off("SIGTERM", signalHandlers.sigterm);
    signalHandlers = undefined;
  };
  const closeResources = () =>
    closeResourcesInOrder([
      { name: "jobs", close: () => jobs.close() },
      { name: "codex-cli", close: () => codexCli.dispose() },
      { name: "llm", close: () => llm.dispose() },
      { name: "storage", close: () => legacyStorage.close() }
    ]);
  const close = (): Promise<void> => {
    removeSignalHandlers();
    return drain.shutdown(server, closeResources);
  };
  if (options.installSignalHandlers !== false) {
    const shutdown = (): void => {
      void close().catch((error: unknown) => {
        process.exitCode = 1;
        logInternalError(error, { requestId: createServerRequestId(), operation: "SIGNAL shutdown", startedAt: Date.now() });
      });
    };
    signalHandlers = { sigint: shutdown, sigterm: shutdown };
    process.once("SIGINT", signalHandlers.sigint);
    process.once("SIGTERM", signalHandlers.sigterm);
  }
  return new Promise<WebServerHandle>((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(options.port ?? defaultPort, effectiveHost, () => {
      server.off("error", rejectListen);
      const address = server.address();
      actualPort = typeof address === "object" && address ? address.port : (options.port ?? defaultPort);
      const url = `http://${effectiveHost}:${actualPort}`;
      resolveListen({
        host: effectiveHost,
        port: actualPort,
        url,
        get state() {
          return drain.state;
        },
        close
      });
    });
  });
}

function normalizeShutdownGrace(value: number): number {
  return Number.isFinite(value) && value >= 100 && value <= 120_000 ? Math.floor(value) : 10_000;
}

function assertJsonRequest(request: import("node:http").IncomingMessage): void {
  const contentEncoding = request.headers["content-encoding"]?.trim().toLowerCase();
  if (contentEncoding && contentEncoding !== "identity") throw new HttpError(415, "Compressed RPC request bodies are not supported.");
  const rawContentType = request.headers["content-type"];
  const contentType = Array.isArray(rawContentType) ? rawContentType[0] : rawContentType;
  const mediaType = contentType?.split(";", 1)[0]?.trim().toLowerCase();
  if (!mediaType || (mediaType !== "application/json" && !/^application\/[a-z0-9!#$&^_.+-]+\+json$/.test(mediaType))) {
    throw new HttpError(415, "RPC requests require an application/json Content-Type.");
  }
}

function httpStatusErrorCode(status: number): "VALIDATION_ERROR" | "CAPABILITY_DENIED" | "NOT_FOUND" | "INTERNAL_ERROR" {
  if (status === 401 || status === 403) return "CAPABILITY_DENIED";
  if (status === 404) return "NOT_FOUND";
  if (status >= 400 && status < 500) return "VALIDATION_ERROR";
  return "INTERNAL_ERROR";
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void startWebServer({ port: Number(process.env.AETHEROPS_PORT ?? defaultPort), host: process.env.AETHEROPS_HOST ?? defaultHost });
}
