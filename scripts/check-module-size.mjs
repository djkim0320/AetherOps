import { readdirSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";

const REPO_ROOT = process.cwd();
const SOURCE_ROOTS = [join(REPO_ROOT, "src"), join(REPO_ROOT, "scripts"), join(REPO_ROOT, "tests")];
const INCLUDED_EXTENSIONS = new Set([".js", ".mjs", ".cjs", ".ts", ".tsx", ".css"]);
const SIZE_LIMITS = {
  production: 400,
  test: 600
};

await main();

async function main() {
  const files = collectSourceFiles(SOURCE_ROOTS);
  const results = await Promise.all(
    files.map(async (file) => {
      const text = await readFile(file, "utf8");
      const normalizedPath = toPosix(relative(REPO_ROOT, file));
      return {
        path: normalizedPath,
        lines: text.split(/\r?\n/).length,
        isTest: isTestPath(normalizedPath)
      };
    })
  );

  results.sort((left, right) => left.path.localeCompare(right.path));

  const failures = [];

  for (const result of results) {
    const limit = result.isTest ? SIZE_LIMITS.test : SIZE_LIMITS.production;
    if (result.lines <= limit) continue;

    failures.push(`${result.path}: ${result.lines} lines (limit ${limit})`);
  }

  if (failures.length > 0) {
    console.error("size:check failed:");
    for (const failure of failures) console.error(`- ${failure}`);
    process.exitCode = 1;
    return;
  }

  console.log(`size:check passed (${results.length} modules).`);
}

function collectSourceFiles(roots) {
  const files = [];
  for (const root of roots) {
    if (!existsAsDirectory(root)) continue;
    collectFromDirectory(root, files);
  }
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

    if (isSourceFile(fullPath)) output.push(fullPath);
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

function isSourceFile(filePath) {
  return INCLUDED_EXTENSIONS.has(fileExtension(filePath));
}

function fileExtension(filePath) {
  const dot = filePath.lastIndexOf(".");
  return dot === -1 ? "" : filePath.slice(dot).toLowerCase();
}

function isTestPath(pathname) {
  return pathname.includes(".test.") || pathname.startsWith("tests/") || pathname.includes("/test/");
}

function existsAsDirectory(pathname) {
  try {
    return statSync(pathname).isDirectory();
  } catch {
    return false;
  }
}

function toPosix(pathname) {
  return pathname.split(sep).join("/");
}
