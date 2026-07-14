import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { AutonomyRpcClient } from "./autonomy/rpc-client.mjs";

const repoRoot = resolve(import.meta.dirname, "..");
const compiledServer = join(repoRoot, "dist-server", "server", "webServer.js");
const temporaryParent = join(repoRoot, ".tmp", "m1-server-restart");
if (!existsSync(compiledServer)) throw new Error("M1 server-restart verification requires npm run server:build first.");
mkdirSync(temporaryParent, { recursive: true });
const dataRoot = mkdtempSync(join(temporaryParent, "run-"));
const token = randomUUID();
const port = await freePort();

try {
  const first = await startServer();
  const created = await first.client.rpc("projects.create", {
    input: {
      goal: "Verify durable state survives a full server process restart.",
      topic: "M1 process restart",
      scope: "Local loopback storage and RPC readback only.",
      budget: "Bounded offline verification."
    }
  });
  const session = await first.client.rpc("sessions.create", {
    projectId: created.id,
    title: "Restart receipt",
    focus: "Receipt-only readback"
  });
  const before = await first.client.rpc("projects.get", { projectId: created.id });
  await stopServer(first.processHandle);

  const second = await startServer();
  const after = await second.client.rpc("projects.get", { projectId: created.id });
  const snapshot = await second.client.rpc("snapshots.get", { projectId: created.id });
  await stopServer(second.processHandle);

  if (after.id !== before.id || after.input.goal !== before.input.goal) throw new Error("Project RPC readback changed across the server process restart.");
  if (!snapshot?.data?.sessions?.some((item) => item.id === session.id)) throw new Error("ProjectResearchStore session readback was lost across restart.");
  verifySqlite(join(dataRoot, "migration", "v2", "storage.sqlite"));
  verifySqlite(join(dataRoot, "migration", "v2", "legacy-research.sqlite"));
  console.log("M1 server process restart: PASS");
} finally {
  rmSync(dataRoot, { recursive: true, force: true });
}

async function startServer() {
  const processHandle = spawn(process.execPath, [compiledServer], {
    cwd: repoRoot,
    windowsHide: true,
    env: {
      ...process.env,
      AETHEROPS_DATA_DIR: dataRoot,
      AETHEROPS_RPC_TOKEN: token,
      AETHEROPS_PORT: String(port),
      CODEX_HOME: join(dataRoot, "offline-codex-home"),
      PYTHONIOENCODING: "utf-8",
      LANG: "C.UTF-8"
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  const stderr = [];
  processHandle.stderr.setEncoding("utf8");
  processHandle.stderr.on("data", (chunk) => stderr.push(String(chunk)));
  const client = new AutonomyRpcClient(`http://127.0.0.1:${port}`, token);
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (processHandle.exitCode !== null) throw new Error(`M1 server exited before health readback (${processHandle.exitCode}): ${stderr.join("")}`);
    try {
      if ((await client.health(2_000)).ok) return { processHandle, client };
    } catch {
      await delay(200);
    }
  }
  await stopServer(processHandle);
  throw new Error(`M1 server health check timed out: ${stderr.join("")}`);
}

async function stopServer(processHandle) {
  if (processHandle.exitCode !== null) return;
  await new Promise((resolveStop) => {
    const timeout = setTimeout(() => {
      if (processHandle.exitCode === null) processHandle.kill("SIGKILL");
      resolveStop();
    }, 10_000);
    processHandle.once("exit", () => {
      clearTimeout(timeout);
      resolveStop();
    });
    processHandle.kill("SIGTERM");
  });
}

function verifySqlite(path) {
  if (!existsSync(path)) throw new Error(`M1 restart verification is missing SQLite storage: ${path}`);
  const database = new DatabaseSync(path, { readOnly: true });
  try {
    const result = database.prepare("pragma integrity_check").get();
    if (result.integrity_check !== "ok") throw new Error(`SQLite integrity verification failed: ${path}`);
  } finally {
    database.close();
  }
}

function freePort() {
  return new Promise((resolvePort, rejectPort) => {
    const server = createServer();
    server.once("error", rejectPort);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const selected = typeof address === "object" && address ? address.port : 0;
      server.close((error) => (error ? rejectPort(error) : resolvePort(selected)));
    });
  });
}

function delay(milliseconds) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}
