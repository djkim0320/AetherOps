import { createReadStream, existsSync, mkdirSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { extname, join, normalize, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { ApiEmbeddingProvider } from "../core/embeddingProvider.js";
import { AetherOpsOrchestrator } from "../core/orchestrator.js";
import { ToolRunner } from "../core/toolRunner.js";
import { VectorRagEngine } from "../core/vectorRagEngine.js";
import type { AppSettings, ResearchProjectInput, ResearchArtifact } from "../core/types.js";
import { BackgroundBrowserRuntime } from "./runtime/backgroundBrowserRuntime.js";
import { BrowserResearchTool } from "./runtime/browserResearchTool.js";
import { CodexOAuthLlmProvider } from "./runtime/codexOAuthLlmProvider.js";
import { launchOpenCodeAuthLogin, listOpenCodeAuth } from "./runtime/opencodeAuth.js";
import { NodeProjectStorage } from "./runtime/projectResearchStore.js";
import { RealOpenCodeAdapter } from "./runtime/realOpenCodeAdapter.js";
import { JsonAppSettingsStore } from "./runtime/settingsStore.js";
import { SqliteResearchStore } from "./runtime/sqliteStore.js";

interface RpcRequest {
  method?: string;
  args?: unknown[];
}

interface WebServerOptions {
  port?: number;
  host?: string;
  dataRoot?: string;
  appRoot?: string;
}

const defaultHost = "127.0.0.1";
const defaultPort = 5179;

export async function startWebServer(options: WebServerOptions = {}): Promise<void> {
  const appRoot = resolve(options.appRoot ?? process.cwd());
  const dataRoot = resolve(options.dataRoot ?? process.env.AETHEROPS_DATA_DIR ?? join(appRoot, ".aetherops"));
  mkdirSync(dataRoot, { recursive: true });
  console.log(`[AetherOps] web storage root: ${dataRoot}`);

  const store = new SqliteResearchStore(join(dataRoot, "aetherops.sqlite"));
  const settingsStore = new JsonAppSettingsStore(join(dataRoot, "settings.json"));
  const settings = () => settingsStore.getRuntimeSettings();
  const embeddingProvider = {
    embed: async (text: string) => new ApiEmbeddingProvider((await settings()).embedding).embed(text)
  };
  const llm = new CodexOAuthLlmProvider({
    cwd: dataRoot,
    model: async () => {
      const runtimeSettings = await settingsStore.getRuntimeSettings();
      return runtimeSettings.openCodeLlm.source === "codex-oauth" ? runtimeSettings.openCodeLlm.model : undefined;
    }
  });
  const openCode = new RealOpenCodeAdapter(settings, { searchRoots: [appRoot, process.cwd()] });
  const browserRuntime = new BackgroundBrowserRuntime(dataRoot);
  const toolRunner = new ToolRunner([new BrowserResearchTool(browserRuntime)]);
  const orchestrator = new AetherOpsOrchestrator(
    store,
    openCode,
    new VectorRagEngine(embeddingProvider),
    join(dataRoot, "projects"),
    llm,
    new NodeProjectStorage(),
    embeddingProvider,
    settings,
    toolRunner
  );

  const server = createServer(async (request, response) => {
    try {
      addCorsHeaders(response);
      if (request.method === "OPTIONS") {
        response.writeHead(204);
        response.end();
        return;
      }

      const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
      if (url.pathname === "/api/health") {
        sendJson(response, 200, { ok: true, mode: "web", dataRoot });
        return;
      }
      if (url.pathname === "/api/rpc" && request.method === "POST") {
        const body = (await readJson(request)) as RpcRequest;
        const result = await handleRpc(body.method, body.args ?? [], orchestrator, settingsStore);
        sendJson(response, 200, { ok: true, result });
        return;
      }

      await serveStatic(appRoot, url.pathname, response);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      sendJson(response, 500, { ok: false, error: message });
    }
  });

  const shutdown = () => {
    llm.dispose();
    store.close();
    server.close();
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  server.listen(options.port ?? defaultPort, options.host ?? defaultHost, () => {
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : options.port ?? defaultPort;
    console.log(`[AetherOps] web backend listening on http://${options.host ?? defaultHost}:${port}`);
  });
}

async function handleRpc(
  method: string | undefined,
  args: unknown[],
  orchestrator: AetherOpsOrchestrator,
  settingsStore: JsonAppSettingsStore
): Promise<unknown> {
  if (!method) {
    throw new Error("RPC method is required.");
  }

  switch (method) {
    case "projects.create":
      return orchestrator.createProject(args[0] as ResearchProjectInput);
    case "projects.list":
      return orchestrator.listProjects();
    case "sessions.createForProject": {
      const snapshot = await orchestrator.createSubSessions(String(args[0]));
      return snapshot.sessions;
    }
    case "sessions.create":
      return orchestrator.createChatSession(String(args[0]), optionalString(args[1]), optionalString(args[2]));
    case "sessions.delete":
      return orchestrator.deleteChatSession(String(args[0]), String(args[1]));
    case "chat.send":
      return orchestrator.sendChatMessage(String(args[0]), String(args[1]), String(args[2]));
    case "researchDb.create":
    case "aetherops:createResearchDb":
      return orchestrator.createResearchDb(String(args[0]));
    case "research.seedQuestions":
      return orchestrator.seedQuestions(String(args[0]));
    case "research.inputResearchQuestionHypothesis":
    case "aetherops:inputResearchQuestionHypothesis":
      return orchestrator.inputResearchQuestionHypothesis(String(args[0]));
    case "research.buildSpecification":
    case "aetherops:buildResearchSpecification":
      return orchestrator.buildResearchSpecification(String(args[0]));
    case "research.plan":
    case "aetherops:planResearch":
      return orchestrator.planResearch(String(args[0]));
    case "loop.start":
    case "aetherops:startLoop":
      return orchestrator.startLoop(String(args[0]));
    case "loop.pause":
    case "aetherops:pause":
      return orchestrator.pause(String(args[0]));
    case "loop.resume":
    case "aetherops:resume":
      return orchestrator.resume(String(args[0]));
    case "loop.abort":
    case "aetherops:abort":
      return orchestrator.abort(String(args[0]));
    case "opencode.run":
      return orchestrator.runOpenCode(String(args[0]));
    case "opencode.authLogin":
      return launchOpenCodeAuthLogin(await settingsStore.getRuntimeSettings(), optionalString(args[0]));
    case "opencode.authList":
      return listOpenCodeAuth(await settingsStore.getRuntimeSettings());
    case "artifacts.store":
      return orchestrator.storeArtifact(String(args[0]), args[1] as Partial<ResearchArtifact>);
    case "rag.buildContext":
      return orchestrator.buildRagContext(String(args[0]));
    case "results.derive":
      return orchestrator.deriveResult(String(args[0]));
    case "reports.finalize":
      return orchestrator.finalizeReport(String(args[0]));
    case "llm.status":
      return orchestrator.getLlmStatus();
    case "settings.get":
    case "aetherops:getSettings":
      return settingsStore.getSettings();
    case "settings.save":
    case "aetherops:updateSettings":
      return settingsStore.saveSettings(args[0] as AppSettings);
    case "snapshots.get":
    case "aetherops:getSnapshot":
      return orchestrator.getSnapshot(String(args[0]));
    default:
      throw new Error(`Unknown RPC method: ${method}`);
  }
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function readJson(request: IncomingMessage): Promise<unknown> {
  return new Promise((resolveJson, reject) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      body += chunk;
      if (body.length > 10_000_000) {
        reject(new Error("Request body is too large."));
        request.destroy();
      }
    });
    request.on("end", () => {
      try {
        resolveJson(body ? JSON.parse(body) : {});
      } catch {
        reject(new Error("Invalid JSON request body."));
      }
    });
    request.on("error", reject);
  });
}

async function serveStatic(appRoot: string, pathname: string, response: ServerResponse): Promise<void> {
  const distRoot = resolve(appRoot, "dist");
  const decodedPath = decodeURIComponent(pathname === "/" ? "/index.html" : pathname);
  const requested = resolve(distRoot, `.${normalize(decodedPath)}`);
  const relativePath = relative(distRoot, requested);
  if (relativePath.startsWith("..") || relativePath === "" && requested !== distRoot) {
    sendJson(response, 403, { ok: false, error: "Forbidden path." });
    return;
  }

  const filePath = existsSync(requested) && statSync(requested).isFile() ? requested : join(distRoot, "index.html");
  if (!existsSync(filePath)) {
    sendJson(response, 404, {
      ok: false,
      error: "Frontend build was not found. Run `npm run build` or use `npm run dev` for development."
    });
    return;
  }

  response.writeHead(200, { "Content-Type": contentType(filePath) });
  createReadStream(filePath).pipe(response);
}

function sendJson(response: ServerResponse, status: number, payload: unknown): void {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  response.end(`${JSON.stringify(payload)}\n`);
}

function addCorsHeaders(response: ServerResponse): void {
  response.setHeader("Access-Control-Allow-Origin", "*");
  response.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  response.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

function contentType(filePath: string): string {
  switch (extname(filePath)) {
    case ".html":
      return "text/html; charset=utf-8";
    case ".js":
      return "text/javascript; charset=utf-8";
    case ".css":
      return "text/css; charset=utf-8";
    case ".svg":
      return "image/svg+xml";
    case ".json":
      return "application/json; charset=utf-8";
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    default:
      return "application/octet-stream";
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void startWebServer({
    port: Number(process.env.AETHEROPS_PORT ?? defaultPort),
    host: process.env.AETHEROPS_HOST ?? defaultHost
  });
}
