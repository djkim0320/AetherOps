import { createServer } from "node:net";
import { existsSync, readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
export const selfTestRpcToken = "aetherops-selftest-rpc-token-20260626";

export function sampleOutput(text = "", limit = 240) {
  return text.replace(/\s+/g, " ").trim().slice(0, limit).trimEnd();
}

export function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

export function runProcess(commandName, commandArgs, timeoutMs) {
  const needsShell = process.platform === "win32" && /\.(?:cmd|bat)$/i.test(commandName);
  const result = spawnSync(commandName, commandArgs, {
    cwd: repoRoot,
    encoding: "utf8",
    shell: needsShell,
    timeout: timeoutMs,
    windowsHide: true
  });
  return {
    exitCode: result.status ?? 1,
    signal: result.signal ?? undefined,
    timedOut: result.error?.code === "ETIMEDOUT",
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? ""
  };
}

export function runTimed(commandName, commandArgs, label, timeoutMs) {
  const started = performance.now();
  const result = runProcess(commandName, commandArgs, timeoutMs);
  return {
    label,
    exitCode: result.exitCode,
    signal: result.signal,
    timedOut: result.timedOut,
    seconds: Number(((performance.now() - started) / 1000).toFixed(2)),
    stdout: sampleOutput(result.stdout, 1_500),
    stderr: sampleOutput(result.stderr, 1_500)
  };
}

export function command(commandName, commandArgs) {
  const result = runProcess(commandName, commandArgs);
  return { stdout: result.stdout, stderr: result.stderr, status: result.exitCode };
}

export async function findFreePort() {
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

export function findPortInServerOutput(output = "") {
  const match = output.match(/127\.0\.0\.1:(\d+)/);
  return match ? Number(match[1]) : undefined;
}

export function countFiles(root) {
  return countMatchingFiles(root, /./);
}

export function countMatchingFiles(root, pattern) {
  if (!existsSync(root)) return 0;
  let count = 0;
  const stack = [root];
  while (stack.length) {
    const current = stack.pop();
    for (const entry of safeReaddirEntries(current)) {
      const file = join(current, entry.name);
      if (entry.isDirectory()) stack.push(file);
      else if (pattern.test(file)) count += 1;
    }
  }
  return count;
}

export function safeGlobFiles(root, pattern) {
  if (!existsSync(root)) return [];
  const output = [];
  const stack = [root];
  while (stack.length) {
    const current = stack.pop();
    for (const entry of safeReaddirEntries(current)) {
      const file = join(current, entry.name);
      if (entry.isDirectory()) stack.push(file);
      else if (pattern.test(file)) output.push(file);
    }
  }
  return output;
}

export function safeReaddir(root) {
  try {
    return existsSync(root) ? readdirSync(root) : [];
  } catch {
    return [];
  }
}

export function safeReaddirEntries(root) {
  try {
    return existsSync(root) ? readdirSync(root, { withFileTypes: true }) : [];
  } catch {
    return [];
  }
}

export function hasDataColumn(db, quotedTable) {
  for (const column of db.prepare(`pragma table_info(${quotedTable})`).all()) {
    if (column.name === "data") return true;
  }
  return false;
}

export function quoteSqlIdentifier(value) {
  return JSON.stringify(value);
}

export function hasMissingRequiredPath(paths) {
  for (const item of paths) {
    if (!item.exists) return true;
  }
  return false;
}

export function makeSecuritySources(urls, now) {
  const sources = [];
  let index = 0;
  for (const url of urls) {
    sources.push({
      id: `s${index}`,
      projectId: "security-project",
      kind: "web",
      title: url,
      url,
      retrievedAt: now,
      metadata: {},
      createdAt: now
    });
    index += 1;
  }
  return sources;
}
