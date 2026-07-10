import { existsSync, readdirSync, readFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";

export const REQUIRED_SCRIPTS = Object.freeze([
  "typecheck",
  "test",
  "build",
  "start",
  "selftest",
  "selftest:blocked",
  "selftest:live",
  "doctor",
  "ui:verify",
  "metadata:verify"
]);
const DISALLOWED_PRODUCTION_ADAPTER_NAMES = Object.freeze([["M", "ockOpenCodeAdapter"].join(""), "LocalResearchAdapter", "CompositeOpenCodeAdapter"]);
export const PRODUCTION_ADAPTER_PATTERN = new RegExp(DISALLOWED_PRODUCTION_ADAPTER_NAMES.join("|"));
export const PRODUCTION_ADAPTER_PATHS = Object.freeze(["src", "README.md"]);
const DEFAULT_TEXT_EXTENSIONS = Object.freeze([".css", ".html", ".js", ".json", ".md", ".mjs", ".ts", ".tsx", ".yml", ".yaml"]);

export async function canListen(port) {
  return new Promise((resolveCanListen) => {
    const server = createServer();
    server.once("error", () => resolveCanListen(false));
    server.once("listening", () => server.close(() => resolveCanListen(true)));
    server.listen(port, "127.0.0.1");
  });
}

export function satisfiesNodeEngine(version, range) {
  const actual = parseVersionParts(version);
  const comparators = [...range.matchAll(/(>=|<=|>|<|=)?\s*v?(\d+)(?:\.(\d+))?(?:\.(\d+))?/g)];
  if (!comparators.length) return true;
  return comparators.every((match) => {
    const operator = match[1] || "=";
    const required = [Number(match[2] ?? 0), Number(match[3] ?? 0), Number(match[4] ?? 0)];
    const comparison = compareVersionParts(actual, required);
    if (operator === ">=") return comparison >= 0;
    if (operator === ">") return comparison > 0;
    if (operator === "<=") return comparison <= 0;
    if (operator === "<") return comparison < 0;
    return comparison === 0;
  });
}

function compareVersionParts(actual, required) {
  for (let index = 0; index < 3; index += 1) {
    const difference = (actual[index] ?? 0) - (required[index] ?? 0);
    if (difference !== 0) return Math.sign(difference);
  }
  return 0;
}

export function collectMissingScripts(requiredScripts, scripts) {
  const missing = [];
  for (const name of requiredScripts) {
    if (!scripts[name]) missing.push(name);
  }
  return missing;
}

export function hasForbiddenProductionAdapterLine(stdout, readmeAllowlistPattern) {
  for (const line of stdout.split(/\r?\n/)) {
    if (isForbiddenProductionAdapterLine(line, readmeAllowlistPattern)) return true;
  }
  return false;
}

export function forbiddenProductionAdapterLines(stdout, readmeAllowlistPattern) {
  const forbidden = [];
  for (const line of stdout.split(/\r?\n/)) {
    if (isForbiddenProductionAdapterLine(line, readmeAllowlistPattern)) forbidden.push(line);
  }
  return forbidden;
}

export function scanTextForPattern(pattern, paths, options = {}) {
  const regex = pattern instanceof RegExp ? new RegExp(pattern.source, pattern.flags.replace(/g/g, "")) : new RegExp(pattern);
  const extensions = new Set(options.extensions ?? DEFAULT_TEXT_EXTENSIONS);
  const matches = [];
  for (const file of textFiles(paths, extensions)) {
    let text;
    try {
      text = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    const lines = text.split(/\r?\n/);
    for (let index = 0; index < lines.length; index += 1) {
      if (regex.test(lines[index])) matches.push(`${file}:${index + 1}:${lines[index]}`);
    }
  }
  return matches;
}

function isForbiddenProductionAdapterLine(line, readmeAllowlistPattern) {
  if (!line) return false;
  if (/\.test\./.test(line)) return false;
  if (readmeAllowlistPattern?.test(line)) return false;
  return true;
}

function textFiles(paths, extensions) {
  const files = [];
  for (const path of paths) {
    collectTextFiles(path, extensions, files);
  }
  return files;
}

function collectTextFiles(path, extensions, output) {
  if (!existsSync(path)) return;
  const entries = safeReaddirEntries(path);
  if (!entries) {
    if (hasTextExtension(path, extensions)) output.push(path);
    return;
  }
  for (const entry of entries) {
    const child = join(path, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "dist" || entry.name === "dist-server" || entry.name === ".git" || entry.name === ".tmp") continue;
      collectTextFiles(child, extensions, output);
    } else if (hasTextExtension(child, extensions)) {
      output.push(child);
    }
  }
}

function safeReaddirEntries(path) {
  try {
    return readdirSync(path, { withFileTypes: true });
  } catch {
    return undefined;
  }
}

function hasTextExtension(path, extensions) {
  const lower = path.toLowerCase();
  for (const extension of extensions) {
    if (lower.endsWith(extension)) return true;
  }
  return false;
}

function parseVersionParts(version) {
  const normalized = String(version).replace(/^v/, "");
  const parts = [0, 0, 0];
  let index = 0;
  for (const part of normalized.split(".")) {
    if (index >= parts.length) break;
    parts[index] = Number(part) || 0;
    index += 1;
  }
  return parts;
}
