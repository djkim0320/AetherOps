import { existsSync } from "node:fs";
import { isAbsolute, join, normalize, resolve } from "node:path";

export interface OpenCodeCommandResolution {
  command: string;
  source: "bundled" | "configured" | "system";
  checkedPaths: string[];
}

export interface OpenCodeCommandOptions {
  searchRoots?: string[];
}

export function resolveOpenCodeCommand(configuredCommand?: string, options: OpenCodeCommandOptions = {}): OpenCodeCommandResolution {
  const command = (configuredCommand ?? "").trim();
  const checkedPaths: string[] = [];
  const roots = uniquePaths([...(options.searchRoots ?? []), ...defaultOpenCodeSearchRoots()]);

  if (!command) {
    const bundled = findBundledOpenCode(roots, checkedPaths);
    if (bundled) {
      return {
        command: bundled,
        source: "bundled",
        checkedPaths
      };
    }
    throw new Error(`OpenCode command/path is not configured and bundled OpenCode was not found. Checked: ${checkedPaths.join(", ")}`);
  }

  const resolvedConfigured = resolveConfiguredCommand(command, roots, checkedPaths);
  if (resolvedConfigured) {
    return {
      command: resolvedConfigured,
      source: "configured",
      checkedPaths
    };
  }
  const bundled = isDefaultOpenCodeCommand(command) ? findBundledOpenCode(roots, checkedPaths) : undefined;
  if (bundled) {
    return {
      command: bundled,
      source: "bundled",
      checkedPaths
    };
  }
  if (!isDefaultOpenCodeCommand(command)) {
    return {
      command,
      source: "configured",
      checkedPaths
    };
  }
  return {
    command,
    source: "system",
    checkedPaths
  };
}

export function isWindowsShellCommand(command: string): boolean {
  return process.platform === "win32" && /\.(?:cmd|bat)$/i.test(command);
}

function findBundledOpenCode(roots: string[], checkedPaths: string[]): string | undefined {
  for (const root of roots) {
    for (const relativePath of bundledOpenCodeCandidates()) {
      const candidate = normalize(join(root, ...relativePath.split("/")));
      checkedPaths.push(candidate);
      if (existsSync(candidate)) {
        return candidate;
      }
    }
  }
  return undefined;
}

function resolveConfiguredCommand(command: string, roots: string[], checkedPaths: string[]): string | undefined {
  if (isAbsolute(command)) {
    checkedPaths.push(command);
    return existsSync(command) ? command : undefined;
  }

  if (/[\\/]/.test(command)) {
    for (const root of roots) {
      const candidate = resolve(root, command);
      checkedPaths.push(candidate);
      if (existsSync(candidate)) {
        return candidate;
      }
    }
  }

  return undefined;
}

function isDefaultOpenCodeCommand(command: string): boolean {
  const normalized = command
    .trim()
    .replace(/^["']|["']$/g, "")
    .replace(/\\/g, "/")
    .toLowerCase();
  return normalized === "opencode" || normalized === "opencode.cmd" || normalized === "opencode.exe";
}

function bundledOpenCodeCandidates(): string[] {
  if (process.platform === "win32") {
    return ["node_modules/opencode-ai/bin/opencode.exe", "node_modules/.bin/opencode.cmd", "node_modules/.bin/opencode"];
  }

  return ["node_modules/.bin/opencode", "node_modules/opencode-ai/bin/opencode", "node_modules/opencode-ai/bin/opencode.exe"];
}

function defaultOpenCodeSearchRoots(): string[] {
  return [process.cwd()];
}

function uniquePaths(paths: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const path of paths) {
    const normalized = normalize(path);
    const key = process.platform === "win32" ? normalized.toLowerCase() : normalized;
    if (!seen.has(key)) {
      seen.add(key);
      result.push(normalized);
    }
  }
  return result;
}
