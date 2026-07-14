import { existsSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { spawn } from "node:child_process";
import { join, relative, resolve } from "node:path";

import { canListen } from "../lib/checks.mjs";
import { findPortInServerOutput, runTimed, sleep } from "./runtime.mjs";

const TERMINAL_JOB_STATUSES = new Set(["aborted", "blocked", "failed", "completed", "interrupted"]);

export async function assertPortSafe(context, port) {
  if (port === 0 || (await canListen(port))) return;
  const health = await fetchJson(`http://127.0.0.1:${port}/api/health`, 2_000).catch(() => undefined);
  const existingRoot = health?.body?.dataRoot ? resolve(String(health.body.dataRoot)) : undefined;
  if (existingRoot === context.dataRoot) {
    throw new Error(`Port ${port} already serves the self-test data root. Stop that server first.`);
  }
  throw new Error(`Port ${port} is occupied${existingRoot ? ` by dataRoot=${existingRoot}` : ""}.`);
}

export async function startServer(context, port) {
  const serverPath = join(context.repoRoot, "dist-server", "server", "webServer.js");
  if (!existsSync(serverPath)) throw new Error("Build did not produce dist-server/server/webServer.js.");
  const env = {
    ...process.env,
    AETHEROPS_DATA_DIR: context.dataRoot,
    AETHEROPS_RPC_TOKEN: context.selfTestRpcToken,
    AETHEROPS_PORT: String(port),
    PYTHONIOENCODING: "utf-8",
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8"
  };
  if (context.mode !== "live") {
    env.CODEX_HOME = join(context.dataRoot, "offline-codex-home");
  }
  const stdout = [];
  const stderr = [];
  context.results.server.port = port;
  context.serverProcess = spawn(process.execPath, [serverPath], {
    cwd: context.repoRoot,
    env,
    windowsHide: true
  });
  context.serverProcess.stdout.setEncoding("utf8");
  context.serverProcess.stderr.setEncoding("utf8");
  context.serverProcess.stdout.on("data", (chunk) => {
    stdout.push(String(chunk));
    context.results.server.stdout = stdout.join("");
  });
  context.serverProcess.stderr.on("data", (chunk) => {
    stderr.push(String(chunk));
    context.results.server.stderr = stderr.join("");
  });

  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (context.serverProcess.exitCode !== null) {
      throw new Error(`Server exited early (${context.serverProcess.exitCode}). ${stderr.join("")}`);
    }
    const health = await fetchJson(`http://127.0.0.1:${port}/api/health`, 2_000).catch(() => undefined);
    if (health?.body?.ok) {
      context.results.server.command = `${process.execPath} ${relative(context.repoRoot, serverPath)}`;
      return;
    }
    await sleep(250);
  }
  throw new Error("Server health check timed out after 30 seconds.");
}

export async function runServerVerify(context) {
  const port = serverPort(context);
  const health = await fetchJson(`http://127.0.0.1:${port}/api/health`, 5_000);
  const settings = await rpc(context, port, "settings.get", {});
  const diagnostics = await rpc(context, port, "tools.diagnostics", {});
  context.results.server.health = health;
  context.results.settings = settings.result;
  context.results.toolDiagnostics = diagnostics.result;
  context.results.toolPreflight = { status: "SKIPPED", reason: "requires projectId" };
  if (!health.contentType.includes("application/json")) {
    context.results.findings.critical.push("Health response is not JSON.");
  }
  const legacy = await fetchJson(`http://127.0.0.1:${port}/api/rpc`, 5_000, { method: "POST" });
  context.results.server.legacyRpcBlocked = legacy.status === 404;
  if (!context.results.server.legacyRpcBlocked) {
    context.results.findings.high.push("Legacy /api/rpc endpoint did not return 404.");
  }
}

export async function runBlockedPath(context) {
  const port = serverPort(context);
  const project = await createProject(context, port, {
    goal: "한글 질문으로 fail-closed 오프라인 실행을 검증합니다.",
    topic: "근거 추적성 blocked-path self test",
    scope: "검색 snippet은 evidence가 아님을 유지하며 한 번 실행합니다.",
    budget: "설정 부족 상태의 오프라인 1회 실행"
  });
  const receipt = await enqueueLoop(context, port, project.id, `blocked-${project.id}`, {
    requestedCapabilities: { agent: true, engineering: false, search: false },
    toolPolicy: { allowCodexCli: false, sourceAccess: { mode: "offline" } }
  });
  const startedAt = performance.now();
  const terminal = await waitForTerminalJob(context, port, project.id, receipt.jobId, 360_000);
  const detail = (await rpc(context, port, "jobs.get", { projectId: project.id, jobId: receipt.jobId })).result;
  const snapshot = (await rpc(context, port, "snapshots.get", { projectId: project.id })).result;
  const runtimeBlockers = Array.isArray(snapshot.data?.runtimeBlockers) ? snapshot.data.runtimeBlockers : [];
  const stepErrors = Array.isArray(snapshot.data?.stepErrors) ? snapshot.data.stepErrors : [];
  const runAuditOutputs = Array.isArray(snapshot.data?.runAuditOutputs) ? snapshot.data.runAuditOutputs : [];
  const finalOutputs = Array.isArray(snapshot.data?.finalOutputs) ? snapshot.data.finalOutputs : [];
  const evidence = Array.isArray(snapshot.data?.evidence) ? snapshot.data.evidence : [];
  context.results.blockedPath = {
    status: terminal.status,
    projectId: project.id,
    jobId: receipt.jobId,
    elapsedSeconds: Number(((performance.now() - startedAt) / 1_000).toFixed(2)),
    revision: snapshot.revision,
    currentStep: snapshot.execution?.currentStep,
    blockedReason: detail.blockedReason,
    failureReason: detail.failureReason,
    runtimeBlockers: runtimeBlockers.length,
    stepErrors: stepErrors.length,
    runAuditOutputs: runAuditOutputs.length,
    finalOutputs: finalOutputs.length,
    counts: {
      runtimeBlockers: runtimeBlockers.length,
      stepErrors: stepErrors.length,
      runAuditOutputs: runAuditOutputs.length,
      finalOutputs: finalOutputs.length,
      evidence: evidence.length
    },
    latestBlocker: runtimeBlockers.at(-1)
  };
  writeFileSync(join(context.dataRoot, "blocked-path-result.json"), `${JSON.stringify({ snapshot }, null, 2)}\n`, "utf8");
  if (terminal.status !== "blocked") {
    context.results.findings.high.push(`Blocked path ended with ${terminal.status}; expected blocked.`);
  }
  if (!detail.blockedReason || runtimeBlockers.length === 0) {
    context.results.findings.high.push("Blocked job did not persist both blockedReason and a runtime blocker.");
  }
  if (runAuditOutputs.length === 0) {
    context.results.findings.high.push("Blocked job did not persist a run audit output.");
  }
}

export async function assessLiveGate(context) {
  const settings = context.results.settings ?? {};
  const capabilities = settings.capabilities ?? {};
  const prerequisites = {
    agent: Boolean(capabilities.agent),
    embedding: Boolean(settings.embedding?.apiKeyConfigured),
    search: !capabilities.search || Boolean(settings.search?.apiKeyConfigured)
  };
  if (prerequisites.agent) {
    const llm = await rpc(context, serverPort(context), "llm.status", {}, { allowFailure: true });
    prerequisites.codex = Boolean(llm.result?.available);
  } else {
    prerequisites.codex = false;
  }
  const missing = Object.entries(prerequisites)
    .filter(([, ready]) => !ready)
    .map(([name]) => name);
  return { ready: missing.length === 0, prerequisites, reason: missing.join(", ") || undefined };
}

export async function runLivePath(context) {
  const port = serverPort(context);
  const project = await createProject(context, port, {
    goal: "Compare Vector RAG and Hybrid RAG citation coverage.",
    topic: "Citation traceability in local research systems",
    scope: "Use real configured providers and one bounded research iteration.",
    budget: "Thirty minutes"
  });
  const search = Boolean(context.results.settings?.capabilities?.search);
  const receipt = await enqueueLoop(context, port, project.id, `live-${project.id}`, {
    requestedCapabilities: { agent: true, engineering: false, search },
    toolPolicy: {
      allowCodexCli: false,
      sourceAccess: search ? { mode: "discovery", allowedDomains: [] } : { mode: "offline" }
    }
  });
  const terminal = await waitForTerminalJob(context, port, project.id, receipt.jobId, 900_000);
  const snapshot = (await rpc(context, port, "snapshots.get", { projectId: project.id })).result;
  context.results.livePath = {
    status: terminal.status,
    projectId: project.id,
    jobId: receipt.jobId,
    revision: snapshot.revision,
    currentStep: snapshot.execution?.currentStep
  };
  if (terminal.status !== "completed") context.results.findings.high.push(`Live path ended with ${terminal.status}.`);
}

export async function runUiVerify(context) {
  const port = serverPort(context);
  const check = runTimed(
    process.execPath,
    [join(context.repoRoot, "scripts", "ui-verify.mjs"), "--url", `http://127.0.0.1:${port}`],
    "npm run ui:verify",
    120_000
  );
  context.results.uiVerify = { status: check.exitCode === 0 ? "PASS" : "FAIL", ...check };
  if (check.exitCode !== 0) context.results.findings.high.push("UI verification failed.");
}

export async function stopServer(context) {
  if (!context.serverProcess || context.serverProcess.exitCode !== null) return;
  await new Promise((resolveStop) => {
    context.serverProcess.once("exit", resolveStop);
    context.serverProcess.kill();
    setTimeout(() => {
      if (context.serverProcess.exitCode === null) context.serverProcess.kill("SIGKILL");
      resolveStop();
    }, 3_000).unref();
  });
}

export async function rpc(context, port, method, params, options = {}) {
  const requestId = `selftest-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const response = await fetchJson(`http://127.0.0.1:${port}/api/v2/rpc`, options.timeoutMs ?? 60_000, {
    method: "POST",
    headers: authHeaders(context, { "Content-Type": "application/json; charset=utf-8" }),
    body: JSON.stringify({ requestId, method, params })
  });
  if (!response.body?.ok) {
    const error = response.body?.error;
    const message = typeof error === "object" ? error.message : (error ?? `RPC ${method} failed`);
    if (options.allowFailure) return { error: message, status: response.status };
    throw new Error(`RPC ${method} failed: ${message}`);
  }
  return response.body;
}

export async function fetchJson(url, timeoutMs, init = {}) {
  const parsed = new URL(url);
  const body = typeof init.body === "string" ? init.body : init.body ? String(init.body) : undefined;
  const headers = { ...(init.headers ?? {}) };
  if (body !== undefined) headers["Content-Length"] = Buffer.byteLength(body);
  return new Promise((resolveJson, reject) => {
    const request = httpRequest(
      {
        protocol: parsed.protocol,
        hostname: parsed.hostname,
        port: parsed.port,
        path: `${parsed.pathname}${parsed.search}`,
        method: init.method ?? "GET",
        headers
      },
      (response) => {
        const chunks = [];
        response.setEncoding("utf8");
        response.on("data", (chunk) => chunks.push(String(chunk)));
        response.on("end", () => {
          const text = chunks.join("");
          try {
            resolveJson({
              status: response.statusCode ?? 0,
              contentType: String(response.headers["content-type"] ?? ""),
              body: text ? JSON.parse(text) : {}
            });
          } catch (error) {
            reject(new Error(`Invalid JSON from ${url}: ${error instanceof Error ? error.message : String(error)}`));
          }
        });
      }
    );
    request.setTimeout(timeoutMs, () => request.destroy(new Error(`Timed out after ${timeoutMs}ms`)));
    request.on("error", reject);
    if (body !== undefined) request.write(body);
    request.end();
  });
}

async function createProject(context, port, input, capabilities = { search: true }) {
  const result = (await rpc(context, port, "projects.create", { input })).result;
  const project = result.project ?? result;
  const updated = (
    await rpc(context, port, "projects.update", {
      projectId: project.id,
      expectedRevision: project.execution.revision,
      input: {},
      capabilities
    })
  ).result;
  return updated.project ?? updated;
}

async function enqueueLoop(context, port, projectId, idempotencyKey, policy) {
  const result = (await rpc(context, port, "loop.start", { projectId, idempotencyKey, ...policy })).result;
  return result.receipt ?? result;
}

function waitForTerminalJob(context, port, projectId, jobId, timeoutMs) {
  const url = new URL(`http://127.0.0.1:${port}/api/v2/events`);
  url.searchParams.set("projectId", projectId);
  return new Promise((resolveTerminal, reject) => {
    let settled = false;
    let buffer = "";
    const request = httpRequest(url, { headers: authHeaders(context, { Accept: "text/event-stream", "Last-Event-ID": "0" }) }, (response) => {
      if (response.statusCode !== 200) {
        response.resume();
        reject(new Error(`SSE connection failed with HTTP ${response.statusCode}.`));
        return;
      }
      response.setEncoding("utf8");
      response.on("data", (chunk) => {
        buffer += String(chunk).replace(/\r\n/g, "\n");
        let boundary = buffer.indexOf("\n\n");
        while (boundary >= 0) {
          const frame = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          const event = parseSseFrame(frame);
          const status = event?.type === "run.status.changed" && event.data?.jobId === jobId ? event.data.status : undefined;
          if (status && TERMINAL_JOB_STATUSES.has(status)) {
            settled = true;
            request.destroy();
            resolveTerminal({ status, event });
            return;
          }
          boundary = buffer.indexOf("\n\n");
        }
      });
      response.on("end", () => {
        if (!settled) reject(new Error(`SSE disconnected before job ${jobId} reached a terminal state.`));
      });
    });
    request.setTimeout(timeoutMs, () => request.destroy(new Error(`SSE timed out after ${timeoutMs}ms`)));
    request.on("error", (error) => {
      if (!settled) reject(error);
    });
    request.end();
  });
}

function parseSseFrame(frame) {
  const data = frame
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trimStart())
    .join("\n");
  if (!data) return undefined;
  try {
    return JSON.parse(data);
  } catch {
    return undefined;
  }
}

function authHeaders(context, extra) {
  return { "X-AetherOps-Rpc-Token": context.selfTestRpcToken, ...extra };
}

function serverPort(context) {
  const port = Number(context.results.server.port ?? 0) || findPortInServerOutput(context.results.server.stdout);
  if (!port) throw new Error("Could not determine the self-test server port.");
  return port;
}
