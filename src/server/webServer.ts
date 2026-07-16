import { mkdir } from "node:fs/promises";
import { createServer } from "node:http";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { runRequiredMigration } from "./composition/migrationGate.js";
import { SseRuntimeDiagnostics } from "./composition/sseRuntimeDiagnostics.js";
import { composeWebRuntime } from "./composition/webRuntimeComposition.js";
import { readPackageVersion } from "./http/health.js";
import { createServerRequestId, logInternalError } from "./http/errorBoundary.js";
import { resolveHttpServerPolicy, type HttpServerPolicy, type HttpServerPolicyOptions } from "./http/jsonBody.js";
import { ServerDrainController, type ServerLifecycleState } from "./http/serverDrain.js";
import { initializeServerTransport, listenHttpServer, normalizeListenPort } from "./http/serverListen.js";
import { createWebRequestHandler, handleClientError } from "./http/webRequestHandler.js";
import { CapabilityMutationGate } from "./http/v2/capabilityMutationGate.js";
import { toProjectResponse, toSessionResponse } from "./http/v2/projectResponses.js";
import { assertLoopbackHostAllowed, resolveLoopbackRpcSecurity } from "./runtime/security/loopbackRpcSecurity.js";
import type { StorageJsonObject } from "./runtime/storage/v2/types.js";

// UTF-8 request decoding is delegated to readJsonBody, which uses decodeStrictUtf8Chunks.
// Static UTF-8 contracts are delegated to staticFiles: return "text/markdown; charset=utf-8",
// return "text/plain; charset=utf-8", and return "application/json; charset=utf-8".

export interface WebServerOptions {
  port?: number;
  host?: string;
  dataRoot?: string;
  appRoot?: string;
  installSignalHandlers?: boolean;
  shutdownGraceMs?: number;
  httpPolicy?: HttpServerPolicyOptions;
}

export interface WebServerHandle {
  host: string;
  port: number;
  url: string;
  readonly state: ServerLifecycleState;
  readonly httpPolicy: HttpServerPolicy;
  close(): Promise<void>;
}

const defaultHost = "127.0.0.1";
const defaultPort = 5179;

export async function startWebServer(options: WebServerOptions = {}): Promise<WebServerHandle> {
  const appRoot = resolve(options.appRoot ?? process.cwd());
  const dataRoot = resolve(options.dataRoot ?? process.env.AETHEROPS_DATA_DIR ?? join(appRoot, ".aetherops"));
  const effectiveHost = options.host ?? process.env.AETHEROPS_HOST ?? defaultHost;
  assertLoopbackHostAllowed(effectiveHost);
  const requestedPort = normalizeListenPort(options.port ?? defaultPort);
  const httpPolicy = resolveHttpServerPolicy(options.httpPolicy, process.env);
  const startedAt = new Date().toISOString();
  const drain = new ServerDrainController(normalizeShutdownGrace(options.shutdownGraceMs ?? Number(process.env.AETHEROPS_SHUTDOWN_GRACE_MS ?? 10_000)));
  const version = await readPackageVersion(appRoot);
  let actualPort = requestedPort;
  await mkdir(dataRoot, { recursive: true });
  await runRequiredMigration(appRoot, dataRoot);

  const rpcSecurity = resolveLoopbackRpcSecurity({ dataRoot, env: process.env });
  const capabilityMutations = new CapabilityMutationGate();
  const sseDiagnostics = new SseRuntimeDiagnostics();
  const {
    jobs,
    settingsStore,
    llm,
    orchestrator,
    projectMutations,
    closeResources: closeRuntimeResources
  } = await composeWebRuntime({
    appRoot,
    dataRoot,
    sseDiagnostics,
    projectMutationResultMapper: {
      project: (snapshot, revision) => toProjectResponse(snapshot, revision) as unknown as StorageJsonObject,
      session: (session) => toSessionResponse(session) as unknown as StorageJsonObject,
      deleted: () => ({ deleted: true })
    }
  });

  let removeSignalHandlers = (): void => undefined;
  const { server, close } = await initializeServerTransport({
    beforeCleanup: () => {
      removeSignalHandlers();
      jobs.beginDrain();
    },
    closeResources: closeRuntimeResources,
    initialize: () => {
      // requestTimeout covers ingress only in Node. It does not cap a handler after
      // the complete request has arrived, so long-running local RPC jobs remain valid.
      const server = createServer(
        {
          headersTimeout: httpPolicy.headersTimeoutMs,
          requestTimeout: httpPolicy.requestTimeoutMs,
          keepAliveTimeout: httpPolicy.keepAliveTimeoutMs,
          connectionsCheckingInterval: httpPolicy.connectionsCheckingIntervalMs
        },
        createWebRequestHandler({
          context: () => ({
            appRoot,
            dataRoot,
            host: effectiveHost,
            port: actualPort,
            startedAt,
            version,
            env: process.env,
            llm,
            orchestrator,
            capabilityMutations,
            projectMutations,
            settingsStore,
            events: jobs,
            jobs
          }),
          rpcToken: rpcSecurity.token,
          httpPolicy,
          drain,
          sseDiagnostics
        })
      );
      server.maxRequestsPerSocket = httpPolicy.maxRequestsPerSocket;
      server.on("clientError", (error, socket) => handleClientError(error, socket));

      let signalHandlers: { sigint: () => void; sigterm: () => void } | undefined;
      removeSignalHandlers = () => {
        if (!signalHandlers) return;
        process.off("SIGINT", signalHandlers.sigint);
        process.off("SIGTERM", signalHandlers.sigterm);
        signalHandlers = undefined;
      };
      const close = (): Promise<void> => {
        removeSignalHandlers();
        jobs.beginDrain();
        return drain.shutdown(server, closeRuntimeResources);
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
      return { server, close };
    }
  });
  return listenHttpServer({
    server,
    port: requestedPort,
    host: effectiveHost,
    beforeCleanup: () => {
      removeSignalHandlers();
      jobs.beginDrain();
    },
    closeResources: closeRuntimeResources,
    onListening: () => {
      const address = server.address();
      actualPort = typeof address === "object" && address ? address.port : requestedPort;
      const url = `http://${effectiveHost}:${actualPort}`;
      return {
        host: effectiveHost,
        port: actualPort,
        url,
        get state() {
          return drain.state;
        },
        httpPolicy,
        close
      };
    }
  });
}

function normalizeShutdownGrace(value: number): number {
  return Number.isFinite(value) && value >= 100 && value <= 120_000 ? Math.floor(value) : 10_000;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void startWebServer({ port: Number(process.env.AETHEROPS_PORT ?? defaultPort), host: process.env.AETHEROPS_HOST ?? defaultHost });
}
