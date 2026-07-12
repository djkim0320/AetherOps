import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { createServer } from "node:net";
import { isAbsolute, join, relative, resolve } from "node:path";

import { runCommand } from "./process.mjs";
import { AutonomyRpcClient } from "./rpc-client.mjs";

export async function startAutonomyServer(context) {
  const build = await runCommand(context.npm, ["run", "server:build"], {
    cwd: context.repoRoot,
    timeoutMs: context.timeoutMs ?? 300_000
  });
  if (build.exitCode !== 0) throw new Error(`Autonomy server build failed: ${build.stderr || build.stdout}`);
  const dataRoot = resolve(context.dataRoot ?? join(context.runtimeRoot, "data"));
  assertEvaluationDataRoot(context, dataRoot);
  mkdirSync(dataRoot, { recursive: true });
  const port = await freePort();
  const token = randomUUID();
  const logs = { stdout: [], stderr: [] };
  const processHandle = spawn(process.execPath, [join(context.repoRoot, "dist-server", "server", "webServer.js")], {
    cwd: context.repoRoot,
    windowsHide: true,
    env: {
      ...process.env,
      AETHEROPS_DATA_DIR: dataRoot,
      AETHEROPS_RPC_TOKEN: token,
      AETHEROPS_PORT: String(port),
      PYTHONIOENCODING: "utf-8",
      LANG: "C.UTF-8"
    }
  });
  processHandle.stdout?.on("data", (chunk) => logs.stdout.push(String(chunk)));
  processHandle.stderr?.on("data", (chunk) => logs.stderr.push(String(chunk)));
  const client = new AutonomyRpcClient(`http://127.0.0.1:${port}`, token);
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    if (processHandle.exitCode !== null) throw new Error(`Autonomy server exited early (${processHandle.exitCode}): ${logs.stderr.join("")}`);
    try {
      const health = await client.health(2_000);
      if (health.ok) return { build, client, dataRoot, port, processHandle, logs };
    } catch {
      await delay(250);
    }
  }
  await stopAutonomyServer({ processHandle });
  throw new Error(`Autonomy server health timeout: ${logs.stderr.join("")}`);
}

export async function stopAutonomyServer(server) {
  if (!server?.processHandle || server.processHandle.exitCode !== null) return;
  await new Promise((resolveStop) => {
    const timer = setTimeout(() => {
      if (server.processHandle.exitCode === null) server.processHandle.kill("SIGKILL");
      resolveStop();
    }, 5_000);
    server.processHandle.once("exit", () => {
      clearTimeout(timer);
      resolveStop();
    });
    server.processHandle.kill();
  });
}

function assertEvaluationDataRoot(context, dataRoot) {
  const actualData = resolve(dataRoot);
  const allowedRuntimeRoot = resolve(context.repoRoot, ".tmp", "autonomy-runtime");
  const legacyRoot = resolve(context.repoRoot, ".aetherops");
  if (actualData === legacyRoot || relative(legacyRoot, actualData).split(/[\\/]/)[0] !== "..") {
    throw new Error("Autonomy verification must never write to the real .aetherops data root.");
  }
  const relativePath = relative(allowedRuntimeRoot, actualData);
  if (!relativePath || relativePath.startsWith("..") || isAbsolute(relativePath)) {
    throw new Error("Autonomy verification data root must be a child of .tmp/autonomy-runtime.");
  }
}

function freePort() {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => resolvePort(port));
    });
  });
}

function delay(ms) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}
