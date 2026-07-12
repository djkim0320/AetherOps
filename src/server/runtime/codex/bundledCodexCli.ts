import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { CodexCliResolution } from "./codexCliTypes.js";

export const REQUIRED_CODEX_CLI_VERSION = "0.144.1";

export function resolveBundledCodexCli(appRoot = process.cwd()): CodexCliResolution {
  const packageRoot = resolve(appRoot, "node_modules", "@openai", "codex");
  const packagePath = join(packageRoot, "package.json");
  if (!existsSync(packagePath)) throw new Error("Bundled @openai/codex is not installed. Run npm ci before starting AetherOps.");
  const packageJson = JSON.parse(readFileSync(packagePath, "utf8")) as { version?: string };
  if (packageJson.version !== REQUIRED_CODEX_CLI_VERSION) {
    throw new Error(`Bundled Codex CLI version mismatch: expected ${REQUIRED_CODEX_CLI_VERSION}, found ${packageJson.version ?? "unknown"}.`);
  }
  const launcher = resolve(appRoot, "node_modules", ".bin", process.platform === "win32" ? "codex.cmd" : "codex");
  if (!existsSync(launcher)) throw new Error(`Bundled Codex CLI launcher is missing: ${launcher}`);
  return process.platform === "win32"
    ? {
        command: process.execPath,
        argsPrefix: [join(packageRoot, "bin", "codex.js")],
        packageRoot,
        version: packageJson.version
      }
    : { command: launcher, argsPrefix: [], packageRoot, version: packageJson.version };
}

export function defaultCodexAppRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "../../../../..");
}
