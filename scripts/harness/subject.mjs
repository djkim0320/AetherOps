import { createHash } from "node:crypto";
import { existsSync, lstatSync, realpathSync, statSync } from "node:fs";
import { relative, resolve } from "node:path";

import { sha256File } from "../autonomy/artifacts.mjs";
import { runCommand } from "../autonomy/process.mjs";

const BASE_SHA = "a0727f2d5846b53717847ff908c411c24ab29d80";
const SCOPE = [
  "package.json",
  "tsconfig.server.json",
  "scripts/autonomy",
  "scripts/harness",
  "scripts/verify-harness.mjs",
  "src/core/testing/harness",
  "tests/contract",
  "tests/fixtures/harness",
  "docs/frontier-harness"
];

export async function readHarnessSubject(repoRoot) {
  const head = await git(repoRoot, ["rev-parse", "HEAD"]);
  if (!/^[a-f0-9]{40}$/.test(head)) throw new Error("Git HEAD is not a full commit SHA.");
  const changed = lines(await git(repoRoot, ["diff", "--name-only", "HEAD", "--", ...SCOPE]));
  const untracked = lines(await git(repoRoot, ["ls-files", "--others", "--exclude-standard", "--", ...SCOPE]));
  const paths = [...new Set([...changed, ...untracked])].sort();
  const realRepoRoot = realpathSync(repoRoot);
  const entries = paths.map((path) => {
    const target = resolve(repoRoot, path);
    const safePath = relative(repoRoot, target).replace(/\\/g, "/");
    if (!safePath || safePath === ".." || safePath.startsWith("../")) throw new Error(`Dirty source path escapes repository: ${path}`);
    if (!existsSync(target)) return { path: safePath, status: "deleted" };
    if (lstatSync(target).isSymbolicLink()) throw new Error(`Dirty source path must not be a symbolic link or junction: ${safePath}`);
    const realTarget = realpathSync(target);
    const realRelative = relative(realRepoRoot, realTarget).replace(/\\/g, "/");
    if (!realRelative || realRelative === ".." || realRelative.startsWith("../")) throw new Error(`Dirty source path resolves outside repository: ${safePath}`);
    if (!statSync(realTarget).isFile()) throw new Error(`Dirty source path is not a file: ${safePath}`);
    return { path: safePath, status: "present", sha256: sha256File(realTarget), bytes: statSync(realTarget).size };
  });
  return {
    baseSha: BASE_SHA,
    headSha: head,
    dirtyDiffHash: createHash("sha256").update(JSON.stringify(entries)).digest("hex")
  };
}

async function git(repoRoot, args) {
  const result = await runCommand("git", args, { cwd: repoRoot, timeoutMs: 30_000 });
  if (result.exitCode !== 0) throw new Error(`Git subject inspection failed (${args[0]}, exit ${result.exitCode}).`);
  if (result.stdout.includes("[TRUNCATED]")) throw new Error(`Git subject inspection exceeded its output budget: ${args[0]}`);
  return result.stdout.trim();
}

function lines(value) {
  return value
    ? value
        .split(/\r?\n/)
        .map((entry) => entry.trim())
        .filter(Boolean)
    : [];
}
