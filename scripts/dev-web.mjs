import { rmSync } from "node:fs";
import { spawn } from "node:child_process";

const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
const npmSpawnOptions = process.platform === "win32" ? { shell: true } : {};

rmSync("dist-server", { recursive: true, force: true });
await run(npmCommand, ["run", "server:build"]);

const children = new Set();
const backend = spawn(process.execPath, ["dist-server/server/webServer.js"], {
  env: {
    ...process.env,
    AETHEROPS_HOST: process.env.AETHEROPS_HOST ?? "127.0.0.1",
    AETHEROPS_PORT: process.env.AETHEROPS_PORT ?? "5179"
  },
  stdio: "inherit"
});
children.add(backend);

const vite = spawn(npmCommand, ["exec", "vite", "--", "--host", "127.0.0.1", "--port", "5180", "--strictPort"], {
  env: {
    ...process.env,
    VITE_AETHEROPS_API_URL: process.env.VITE_AETHEROPS_API_URL ?? "http://127.0.0.1:5179"
  },
  stdio: "inherit",
  ...npmSpawnOptions
});
children.add(vite);

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    for (const child of children) {
      child.kill();
    }
    process.exit(0);
  });
}

await Promise.race([
  waitForExit(backend),
  waitForExit(vite)
]).finally(() => {
  for (const child of children) {
    child.kill();
  }
});

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "inherit", ...npmSpawnOptions });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`${command} ${args.join(" ")} exited with code ${code}`));
      }
    });
  });
}

function waitForExit(child) {
  return new Promise((resolve) => {
    child.on("close", resolve);
    child.on("error", resolve);
  });
}
