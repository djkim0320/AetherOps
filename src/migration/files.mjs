import { copyFileSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, normalize, relative, sep } from "node:path";
import { normalizeText, semanticTextHash, sha256Hex, stableJsonHash } from "./hash.mjs";

const ignoredSidecarSuffixes = [".sqlite-wal", ".sqlite-shm", ".sqlite-journal"];

export function collectFileEntries(root, options = {}) {
  const rootPath = normalize(root);
  const skipRelativePrefixes = (options.skipRelativePrefixes ?? []).map((entry) => normalize(entry).replace(/^[\\/]+/, ""));
  const entries = [];
  for (const absolutePath of walkFiles(rootPath)) {
    const relativePath = relative(rootPath, absolutePath);
    if (shouldSkipRelativePath(relativePath, skipRelativePrefixes)) continue;
    if (shouldSkipSidecar(absolutePath)) continue;
    entries.push(buildFileEntry(rootPath, absolutePath));
  }
  return entries.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
}

export function copyFileEntries(entries, sourceRoot, destinationRoot) {
  const sourcePath = normalize(sourceRoot);
  const destinationPath = normalize(destinationRoot);
  for (const entry of entries) {
    const absoluteSource = join(sourcePath, entry.relativePath);
    const absoluteDestination = join(destinationPath, entry.relativePath);
    mkdirSync(dirname(absoluteDestination), { recursive: true });
    copyFileSync(absoluteSource, absoluteDestination);
  }
}

export function writeJsonFile(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const serialized = `${JSON.stringify(value, null, 2)}\n`;
  writeFileSync(path, serialized, "utf8");
  return {
    path,
    sha256: sha256Hex(serialized)
  };
}

export function buildFileEntry(root, absolutePath) {
  const stats = statSync(absolutePath);
  const raw = readFileSync(absolutePath);
  const relativePath = relative(root, absolutePath);
  const filename = relativePath.toLowerCase();
  const isJson = filename.endsWith(".json");
  const isJsonl = filename.endsWith(".jsonl");
  const isText = isJson || isJsonl || /\.(md|txt|nt|csv|ts|js|mjs|cjs|css|html|xml|yaml|yml)$/i.test(filename);
  if (isJson) {
    const parsed = parseJsonFile(raw, absolutePath);
    return {
      relativePath,
      size: stats.size,
      rawSha256: sha256Hex(raw),
      semanticType: "json",
      semanticSha256: stableJsonHash(parsed),
      semanticSummary: {
        keys: Object.keys(parsed).sort((left, right) => left.localeCompare(right))
      }
    };
  }
  if (isJsonl) {
    const lines = normalizeText(raw.toString("utf8"))
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    const parsedLines = lines.map((line, index) => parseJsonLine(line, absolutePath, index + 1));
    return {
      relativePath,
      size: stats.size,
      rawSha256: sha256Hex(raw),
      semanticType: "jsonl",
      semanticSha256: stableJsonHash(parsedLines),
      semanticSummary: {
        lines: parsedLines.length
      }
    };
  }
  if (isText) {
    const text = normalizeText(raw.toString("utf8"));
    return {
      relativePath,
      size: stats.size,
      rawSha256: sha256Hex(raw),
      semanticType: "text",
      semanticSha256: semanticTextHash(text),
      semanticSummary: {
        lines: text ? text.split("\n").length : 0,
        firstLine: firstNonEmptyLine(text)
      }
    };
  }
  return {
    relativePath,
    size: stats.size,
    rawSha256: sha256Hex(raw),
    semanticType: "binary",
    semanticSummary: {
      signature: raw.byteLength >= 5 ? raw.subarray(0, 5).toString("ascii") : undefined
    }
  };
}

function walkFiles(root) {
  const stack = [root];
  const files = [];
  while (stack.length) {
    const current = stack.pop();
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const absolute = join(current, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        stack.push(absolute);
        continue;
      }
      if (entry.isFile()) {
        files.push(absolute);
      }
    }
  }
  return files;
}

function shouldSkipRelativePath(relativePath, skipPrefixes) {
  const normalized = normalize(relativePath);
  if (!normalized || normalized === ".") return true;
  for (const prefix of skipPrefixes) {
    if (normalized === prefix || normalized.startsWith(`${prefix}${sep}`)) {
      return true;
    }
  }
  return false;
}

function shouldSkipSidecar(absolutePath) {
  const lower = absolutePath.toLowerCase();
  return ignoredSidecarSuffixes.some((suffix) => lower.endsWith(suffix));
}

function parseJsonFile(raw, path) {
  try {
    return JSON.parse(normalizeText(raw.toString("utf8")));
  } catch (error) {
    throw new Error(`Invalid JSON file at ${path}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
}

function parseJsonLine(line, path, lineNumber) {
  try {
    return JSON.parse(line);
  } catch (error) {
    throw new Error(`Invalid JSONL file at ${path}:${lineNumber}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
}

function firstNonEmptyLine(text) {
  for (const line of text.split("\n")) {
    if (line.trim()) return line.trim();
  }
  return undefined;
}
