import { spawn } from "node:child_process";

export function runCommand(command, args, options = {}) {
  const startedAt = performance.now();
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      windowsHide: true,
      shell: process.platform === "win32" && /\.(?:cmd|bat)$/i.test(command)
    });
    const stdout = [];
    const stderr = [];
    child.stdout?.on("data", (chunk) => stdout.push(String(chunk)));
    child.stderr?.on("data", (chunk) => stderr.push(String(chunk)));
    const timer = setTimeout(() => child.kill("SIGKILL"), options.timeoutMs ?? 600_000);
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      resolve({
        command: [command, ...args].join(" "),
        exitCode: code ?? 1,
        signal: signal ?? undefined,
        elapsedMs: Math.round(performance.now() - startedAt),
        stdout: truncate(stdout.join("")),
        stderr: truncate(stderr.join(""))
      });
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      resolve({ command: [command, ...args].join(" "), exitCode: 1, elapsedMs: Math.round(performance.now() - startedAt), stdout: "", stderr: error.message });
    });
  });
}

export async function mapBounded(items, concurrency, handler) {
  const results = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(Math.max(1, concurrency), items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await handler(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

function truncate(value, max = 12_000) {
  const text = value.replace(/\r\n/g, "\n");
  return text.length <= max ? text : `${text.slice(0, max)}\n[TRUNCATED]`;
}
