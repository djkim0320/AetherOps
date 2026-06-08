import { createReadStream, mkdirSync, readFileSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { extname, join, normalize, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { ApiEmbeddingProvider } from "../core/providers/embeddingProvider.js";
import { EngineeringProgramTool, runEngineeringProgramPreflight } from "../core/tools/engineeringProgramTool.js";
import { AetherOpsOrchestrator } from "../core/orchestration/orchestrator.js";
import { createDefaultResearchTools } from "../core/tools/toolRegistry.js";
import { dedupeResearchTools, ToolRunner } from "../core/tools/toolRunner.js";
import { buildRuntimeToolDiagnostics } from "../core/tools/runtimeToolDiagnostics.js";
import { VectorRagEngine } from "../core/retrieval/vectorRagEngine.js";
import { createId, nowIso } from "../core/shared/ids.js";
import { ResearchLoopStep } from "../core/shared/types.js";
import type {
  AppSettings,
  EngineeringProgramDirectRunInput,
  EngineeringProgramDirectRunResult,
  EngineeringProgramRequest,
  EngineeringProgramTarget,
  OpenCodeRunInput,
  ResearchArtifact,
  ResearchProjectInput
} from "../core/shared/types.js";
import { BackgroundBrowserRuntime } from "./runtime/browser/backgroundBrowserRuntime.js";
import { BrowserResearchTool } from "./runtime/browser/browserResearchTool.js";
import { CodexOAuthLlmProvider } from "./runtime/opencode/codexOAuthLlmProvider.js";
import { launchOpenCodeAuthLogin, listOpenCodeAuth } from "./runtime/opencode/opencodeAuth.js";
import { NodeProjectStorage } from "./runtime/storage/projectResearchStore.js";
import { RealOpenCodeAdapter } from "./runtime/opencode/realOpenCodeAdapter.js";
import { JsonAppSettingsStore } from "./runtime/storage/settingsStore.js";
import { SqliteResearchStore } from "./runtime/storage/sqliteStore.js";
import { decodeStrictUtf8Chunks } from "./runtime/support/strictUtf8.js";

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
  const startedAt = new Date().toISOString();
  const version = readPackageVersion(appRoot);
  let actualPort = options.port ?? defaultPort;
  mkdirSync(dataRoot, { recursive: true });
  console.log(`[AetherOps] web storage root: ${dataRoot}`);

  const store = new SqliteResearchStore(join(dataRoot, "aetherops.sqlite"));
  const settingsStore = new JsonAppSettingsStore(join(dataRoot, "settings.json"));
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
    cwd: dataRoot,
    model: async () => {
      const runtimeSettings = await settingsStore.getRuntimeSettings();
      return runtimeSettings.openCodeLlm.source === "codex-oauth" ? runtimeSettings.openCodeLlm.model : undefined;
    }
  });
  const openCode = new RealOpenCodeAdapter(settings, { searchRoots: [appRoot, process.cwd()] });
  const browserRuntime = new BackgroundBrowserRuntime(dataRoot);
  const toolRunner = new ToolRunner(dedupeResearchTools([...createDefaultResearchTools(), new BrowserResearchTool(browserRuntime)]));
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
        sendJson(response, 200, { ok: true, mode: "web", dataRoot, port: actualPort, pid: process.pid, startedAt, version });
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
      sendJson(response, error instanceof HttpError ? error.status : 500, { ok: false, error: message });
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
    actualPort = typeof address === "object" && address ? address.port : options.port ?? defaultPort;
    console.log(`[AetherOps] web backend listening on http://${options.host ?? defaultHost}:${actualPort} dataRoot=${dataRoot} pid=${process.pid} startedAt=${startedAt}`);
  });
}

function readPackageVersion(appRoot: string): string {
  try {
    const parsed = JSON.parse(readFileSync(join(appRoot, "package.json"), "utf8")) as { version?: unknown };
    return typeof parsed.version === "string" ? parsed.version : "unknown";
  } catch {
    return "unknown";
  }
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
    case "projects.update":
      return orchestrator.updateProjectInput(String(args[0]), args[1] as ResearchProjectInput);
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
      return orchestrator.inputResearchQuestionHypothesis(String(args[0]), args[1] as never);
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
      requireLegacyRpc(method);
      return orchestrator.runOpenCode(String(args[0]));
    case "opencode.authLogin":
      return launchOpenCodeAuthLogin(await settingsStore.getRuntimeSettings(), optionalString(args[0]));
    case "opencode.authList":
      return listOpenCodeAuth(await settingsStore.getRuntimeSettings());
    case "artifacts.store":
      return orchestrator.storeArtifact(String(args[0]), args[1] as Partial<ResearchArtifact>);
    case "rag.buildContext":
      requireLegacyRpc(method);
      return orchestrator.buildRagContext(String(args[0]));
    case "results.derive":
      requireLegacyRpc(method);
      return orchestrator.deriveResult(String(args[0]));
    case "reports.finalize":
      requireLegacyRpc(method);
      return orchestrator.finalizeReport(String(args[0]));
    case "llm.status":
      return orchestrator.getLlmStatus();
    case "settings.get":
    case "aetherops:getSettings":
      return settingsStore.getSettings();
    case "settings.save":
    case "aetherops:updateSettings":
      return settingsStore.saveSettings(args[0] as AppSettings);
    case "tools.diagnostics":
    case "aetherops:getToolDiagnostics":
      return buildRuntimeToolDiagnostics(await settingsStore.getRuntimeSettings());
    case "tools.preflightEngineering":
    case "aetherops:preflightEngineering": {
      const runtimeSettings = await settingsStore.getRuntimeSettings();
      const preflight = await runEngineeringProgramPreflight(runtimeSettings, optionalEngineeringProgramTarget(args[0]));
      return { ...preflight, diagnostics: buildRuntimeToolDiagnostics(runtimeSettings) };
    }
    case "engineering.runProgram":
    case "aetherops:runEngineeringProgram":
      return runEngineeringProgramDirect(args[0] as EngineeringProgramDirectRunInput, await settingsStore.getRuntimeSettings());
    case "snapshots.get":
    case "aetherops:getSnapshot":
      return orchestrator.getSnapshot(String(args[0]));
    default:
      throw new Error(`Unknown RPC method: ${method}`);
  }
}

function requireLegacyRpc(method: string): void {
  if (process.env.AETHEROPS_ENABLE_LEGACY_RPC !== "true") {
    throw new Error(`Legacy RPC method ${method} is disabled. Use the 12-step AetherOps RPC methods instead.`);
  }
  console.warn(`[AetherOps] Legacy RPC method ${method} was called. Set AETHEROPS_ENABLE_LEGACY_RPC=false to block old clients.`);
}

async function runEngineeringProgramDirect(payload: EngineeringProgramDirectRunInput, settings: AppSettings): Promise<EngineeringProgramDirectRunResult> {
  const startedAt = nowIso();
  const projectId = createId("direct_project");
  const questionId = createId("question");
  const hypothesisId = createId("hypothesis");
  const programRequests = normalizeDirectProgramRequests(payload?.programRequests);
  const question = payload?.question?.trim() || "Run a direct engineering program analysis and report the computed values.";
  const title = payload?.title?.trim() || "Direct engineering program run";
  const input: OpenCodeRunInput = {
    project: {
      id: projectId,
      goal: title,
      topic: title,
      scope: "Direct program operation through AetherOps EngineeringProgramTool.",
      budget: "single direct run",
      autonomyPolicy: {
        toolApproval: "suggested",
        allowExternalSearch: Boolean(settings.allowExternalSearch),
        allowCodeExecution: Boolean(settings.allowCodeExecution),
        maxLoopIterations: 1
      },
      createdAt: startedAt,
      updatedAt: startedAt,
      currentStep: ResearchLoopStep.ExecuteTools,
      status: "running",
      projectRoot: ".aetherops/direct-engineering"
    },
    questions: [{ id: questionId, projectId, text: question, status: "open", createdAt: startedAt }],
    hypotheses: [
      {
        id: hypothesisId,
        projectId,
        questionId,
        statement: "A real engineering program execution can produce traceable numerical output.",
        status: "untested",
        confidence: 0.5,
        createdAt: startedAt
      }
    ],
    evidence: [],
    artifacts: [],
    sources: [],
    researchPlan: {
      id: createId("plan"),
      projectId,
      iteration: 1,
      objective: title,
      targetQuestions: [questionId],
      targetHypotheses: [hypothesisId],
      requiredTools: ["EngineeringProgramTool"],
      expectedSources: ["real engineering program inputs"],
      expectedArtifacts: ["engineering program output artifact"],
      executionSteps: ["Run EngineeringProgramTool with the supplied structured request."],
      stopCriteria: ["Engineering program output is returned or an explicit failure is recorded."],
      programRequests,
      createdAt: startedAt
    },
    iteration: 1
  };

  try {
    const result = await new EngineeringProgramTool().run(input, settings);
    const completedAt = nowIso();
    const programRuns = programRunsFromOutput(result.toolRun.output);
    const reportMarkdown = engineeringDirectReport(title, result.toolRun.status, programRuns, result.artifacts, result.evidence, result.toolRun.error);
    return {
      status: result.toolRun.status === "completed" ? "completed" : "failed",
      startedAt,
      completedAt,
      toolRun: result.toolRun,
      programRuns,
      artifacts: result.artifacts,
      evidence: result.evidence,
      reportMarkdown,
      error: result.toolRun.error
    };
  } catch (error) {
    const completedAt = nowIso();
    const message = error instanceof Error ? error.message : String(error);
    const toolRun = {
      id: createId("tool"),
      projectId,
      iteration: 1,
      toolName: "EngineeringProgramTool",
      input: { programRequests },
      output: { programRequests },
      status: "failed" as const,
      error: message,
      startedAt,
      completedAt
    };
    return {
      status: "failed",
      startedAt,
      completedAt,
      toolRun,
      programRuns: [],
      artifacts: [],
      evidence: [],
      reportMarkdown: engineeringDirectReport(title, "failed", [], [], [], message),
      error: message
    };
  }
}

function normalizeDirectProgramRequests(value: unknown): EngineeringProgramRequest[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error("engineering.runProgram requires at least one program request.");
  }
  return value.slice(0, 4).map((item) => {
    if (!item || typeof item !== "object") {
      throw new Error("Engineering program request must be an object.");
    }
    const request = item as Partial<EngineeringProgramRequest>;
    if (typeof request.kind !== "string") {
      throw new Error("Engineering program request requires kind.");
    }
    return {
      kind: request.kind as EngineeringProgramRequest["kind"],
      target: request.target,
      artifactPath: request.artifactPath,
      sourceUrl: request.sourceUrl,
      outputFileName: request.outputFileName,
      naca: request.naca,
      reynolds: request.reynolds,
      mach: request.mach,
      alphaStart: request.alphaStart,
      alphaEnd: request.alphaEnd,
      alphaStep: request.alphaStep,
      reason: request.reason
    };
  });
}

function programRunsFromOutput(output: unknown): unknown[] {
  const record = asRecord(output);
  if (Array.isArray(record?.programRuns)) return record.programRuns;
  return Array.isArray(record?.outputs) ? record.outputs : [];
}

function engineeringDirectReport(
  title: string,
  status: string,
  programRuns: unknown[],
  artifacts: ResearchArtifact[],
  evidence: Array<{ title: string; summary: string; limitations?: string[] }>,
  error?: string
): string {
  const lines = [`# ${title}`, "", `Status: ${status}`, ""];
  if (error) {
    lines.push("## Error", error, "");
  }
  for (const run of programRuns) {
    const record = asRecord(run);
    const summary = asRecord(record?.summary);
    lines.push(`## ${String(record?.target ?? record?.kind ?? "Engineering program")}`);
    if (summary?.airfoil) lines.push(`Airfoil: ${String(summary.airfoil)}`);
    if (summary?.sourceUrl) lines.push(`Source URL: ${String(summary.sourceUrl)}`);
    if (summary?.runtime) lines.push(`Runtime: ${String(summary.runtime)} ${summary.runtimeVersion ? String(summary.runtimeVersion) : ""}`.trim());
    if (summary?.runtimeLicense) lines.push(`Runtime license: ${String(summary.runtimeLicense)}`);
    if (summary?.reynolds !== undefined) lines.push(`Reynolds: ${formatReportNumber(summary.reynolds)}`);
    if (summary?.mach !== undefined) lines.push(`Mach: ${formatReportNumber(summary.mach)}`);
    const rows = Array.isArray(summary?.rows) ? summary.rows.map(asRecord).filter(Boolean) : [];
    if (rows.length) {
      lines.push("", "| alpha | CL | CD | Cm | Top Xtr | Bot Xtr |", "| ---: | ---: | ---: | ---: | ---: | ---: |");
      for (const row of rows) {
        lines.push(
          `| ${formatReportNumber(row?.alpha)} | ${formatReportNumber(row?.cl)} | ${formatReportNumber(row?.cd)} | ${formatReportNumber(row?.cm)} | ${formatReportNumber(row?.topXtr)} | ${formatReportNumber(row?.botXtr)} |`
        );
      }
    }
    lines.push("");
  }
  if (evidence.length) {
    lines.push("## Evidence");
    for (const item of evidence) {
      lines.push(`- ${item.title}: ${item.summary}`);
      for (const limitation of item.limitations ?? []) lines.push(`  - Limitation: ${limitation}`);
    }
    lines.push("");
  }
  lines.push(`Artifacts: ${artifacts.length}`, `Evidence items: ${evidence.length}`, "");
  return `${lines.join("\n").trim()}\n`;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
}

function formatReportNumber(value: unknown): string {
  const numberValue = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numberValue)) return "";
  if (Math.abs(numberValue) >= 1000) return numberValue.toLocaleString("en-US", { maximumFractionDigits: 0 });
  return Number(numberValue.toFixed(5)).toString();
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function optionalEngineeringProgramTarget(value: unknown): EngineeringProgramTarget {
  if (
    value === "xfoil" ||
    value === "xfoil-wasm" ||
    value === "modeling" ||
    value === "openfoam" ||
    value === "su2" ||
    value === "freecad" ||
    value === "openvsp" ||
    value === "flightstream" ||
    value === "starccm" ||
    value === "all"
  ) {
    return value;
  }
  return "all";
}

function readJson(request: IncomingMessage): Promise<unknown> {
  return new Promise((resolveJson, reject) => {
    const chunks: Buffer[] = [];
    let bodyBytes = 0;
    request.on("data", (chunk) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      chunks.push(buffer);
      bodyBytes += buffer.byteLength;
      if (bodyBytes > 10_000_000) {
        reject(new HttpError(413, "Request body is too large."));
        request.destroy();
      }
    });
    request.on("end", () => {
      try {
        const body = chunks.length ? decodeStrictUtf8Chunks(chunks, "RPC request body") : "";
        resolveJson(body ? JSON.parse(body) : {});
      } catch (error) {
        if (error instanceof SyntaxError) {
          reject(new HttpError(400, "Invalid JSON request body."));
          return;
        }
        reject(new HttpError(400, error instanceof Error ? error.message : "Invalid UTF-8 request body."));
      }
    });
    request.on("error", reject);
  });
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message);
    this.name = "HttpError";
  }
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

  const requestedStats = statSync(requested, { throwIfNoEntry: false });
  const filePath = requestedStats?.isFile() ? requested : join(distRoot, "index.html");
  const fileStats = statSync(filePath, { throwIfNoEntry: false });
  if (!fileStats?.isFile()) {
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
    case ".map":
      return "application/json; charset=utf-8";
    case ".css":
      return "text/css; charset=utf-8";
    case ".svg":
      return "image/svg+xml; charset=utf-8";
    case ".json":
      return "application/json; charset=utf-8";
    case ".txt":
      return "text/plain; charset=utf-8";
    case ".md":
      return "text/markdown; charset=utf-8";
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
