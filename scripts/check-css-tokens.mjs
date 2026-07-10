import { readdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";

const REPO_ROOT = process.cwd();
const SOURCE_ROOT = join(REPO_ROOT, "src");
const TOKEN_FILE = "src/renderer/styles/tokens.css";
const RAW_COLOR_PATTERN = /(?:#[0-9a-fA-F]{3,8}\b|\brgba?\s*\(|\bhsla?\s*\()/g;

await main();

async function main() {
  const cssFiles = collectCssFiles(SOURCE_ROOT).filter((file) => toPosix(relative(REPO_ROOT, file)) !== TOKEN_FILE);
  const results = await Promise.all(
    cssFiles.map(async (file) => {
      const text = await readFile(file, "utf8");
      const path = toPosix(relative(REPO_ROOT, file));
      return {
        path,
        violations: scanForRawColors(text)
      };
    })
  );

  results.sort((left, right) => left.path.localeCompare(right.path));

  const failures = [];

  for (const result of results) {
    if (result.violations.length === 0) continue;

    for (const violation of result.violations) {
      failures.push(`${result.path}:${violation.line}: raw color token(s) ${violation.tokens.join(", ")}`);
    }
  }

  if (failures.length > 0) {
    console.error("css:tokens failed:");
    for (const failure of failures) console.error(`- ${failure}`);
    process.exitCode = 1;
    return;
  }

  console.log(`css:tokens passed (${results.length} stylesheets).`);
}

function collectCssFiles(root) {
  const files = [];
  if (!existsAsDirectory(root)) return files;
  collectFromDirectory(root, files);
  return files;
}

function collectFromDirectory(directory, output) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (shouldSkipDirectory(entry.name)) continue;
    const fullPath = join(directory, entry.name);
    if (entry.isDirectory()) {
      collectFromDirectory(fullPath, output);
      continue;
    }

    if (fullPath.toLowerCase().endsWith(".css")) output.push(fullPath);
  }
}

function shouldSkipDirectory(name) {
  return (
    name === "node_modules" ||
    name === "dist" ||
    name === "dist-server" ||
    name === ".git" ||
    name === ".tmp" ||
    name === "coverage" ||
    name === "playwright-report" ||
    name === ".aetherops" ||
    name === "vendor" ||
    name === "tmp"
  );
}

function scanForRawColors(text) {
  const lines = text.split(/\r?\n/);
  const violations = [];
  const state = { inBlockComment: false };

  for (let index = 0; index < lines.length; index += 1) {
    const stripped = stripBlockComments(lines[index], state);
    const tokens = stripped.match(RAW_COLOR_PATTERN);
    if (tokens && tokens.length > 0) {
      violations.push({ line: index + 1, tokens });
    }
  }

  return violations;
}

function stripBlockComments(line, state) {
  let result = "";
  let cursor = 0;

  while (cursor < line.length) {
    if (state.inBlockComment) {
      const endIndex = line.indexOf("*/", cursor);
      if (endIndex === -1) return result;
      state.inBlockComment = false;
      cursor = endIndex + 2;
      continue;
    }

    const startIndex = line.indexOf("/*", cursor);
    if (startIndex === -1) {
      result += line.slice(cursor);
      break;
    }

    result += line.slice(cursor, startIndex);
    state.inBlockComment = true;
    cursor = startIndex + 2;
  }

  return result;
}

function existsAsDirectory(pathname) {
  try {
    return readdirSync(pathname, { withFileTypes: true }).length >= 0;
  } catch {
    return false;
  }
}

function toPosix(pathname) {
  return pathname.split(sep).join("/");
}
