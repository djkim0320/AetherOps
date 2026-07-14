import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { format as formatPrettier } from "prettier";
import {
  BASELINE_V2_BASE_COMMIT,
  BASELINE_V2_BASE_TREE,
  BASELINE_V2_DIRECTORY,
  BASELINE_V2_LOCK_SHA256,
  BASELINE_V2_NODE_DISTRIBUTION_SHA256,
  BASELINE_V2_NODE_VERSION,
  buildBaselineV2Manifest,
  runnerBundleSha256,
  verifyBaselineV2
} from "./harness/baseline-v2.mjs";
const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const args = parseArgs(process.argv.slice(2));
const harnessTmp = resolve(repoRoot, ".tmp", "harness");
mkdirSync(harnessTmp, { recursive: true });
const outputRoot = args.outputRoot ?? mkdtempSync(join(harnessTmp, "baseline-v2-capture-"));
assertInside(harnessTmp, outputRoot, "Capture output root");
prepareOutputRoot(outputRoot);
const toolchain = await ensurePortableNode(join(harnessTmp, "toolchains"));
const workRoot = mkdtempSync(join(harnessTmp, "baseline-v2-work-"));
try {
  const archiveRoot = join(workRoot, "base");
  mkdirSync(archiveRoot, { recursive: true });
  await extractBaseArchive(workRoot, archiveRoot);
  assert(sha256File(join(archiveRoot, "package-lock.json")) === BASELINE_V2_LOCK_SHA256, "Extracted package-lock hash mismatch.");
  assert(readFileSync(join(archiveRoot, ".node-version"), "utf8").trim() === BASELINE_V2_NODE_VERSION.slice(1), "Extracted Node pin mismatch.");
  copyRunnerBundle(archiveRoot);
  writeRunnerTsconfig(archiveRoot);
  const installEnvironment = childEnvironment(toolchain.root, join(workRoot, "install-tmp"), true);
  await checkedRun(toolchain.npm, ["ci", "--ignore-scripts", "--no-audit", "--no-fund"], {
    cwd: archiveRoot,
    env: installEnvironment,
    timeoutMs: 900_000
  });
  const npmVersion = (await checkedRun(toolchain.npm, ["--version"], { cwd: archiveRoot, env: installEnvironment, timeoutMs: 30_000 })).stdout.trim();
  await checkedRun(toolchain.node, [join(archiveRoot, "node_modules", "typescript", "bin", "tsc"), "-p", runnerTsconfig(archiveRoot)], {
    cwd: archiveRoot,
    env: installEnvironment,
    timeoutMs: 300_000
  });
  const rawRoot = join(outputRoot, "raw");
  mkdirSync(rawRoot, { recursive: true });
  const runtimeRoot = join(workRoot, "runtime");
  mkdirSync(runtimeRoot, { recursive: true });
  const offlineGuard = pathToFileURL(join(archiveRoot, "scripts", "autonomy", "offline-network-guard.mjs")).href;
  const runEnvironment = {
    ...childEnvironment(toolchain.root, join(workRoot, "runtime-tmp"), false),
    NODE_OPTIONS: `--import=${offlineGuard}`,
    AETHEROPS_OFFLINE_VERIFY: "1",
    AETHEROPS_BASELINE_OUTPUT_ROOT: rawRoot,
    AETHEROPS_BASELINE_RUNTIME_ROOT: runtimeRoot,
    AETHEROPS_BASELINE_BASE_COMMIT: BASELINE_V2_BASE_COMMIT,
    AETHEROPS_BASELINE_BASE_TREE: BASELINE_V2_BASE_TREE,
    AETHEROPS_BASELINE_LOCK_SHA256: BASELINE_V2_LOCK_SHA256,
    AETHEROPS_BASELINE_NODE_DISTRIBUTION_SHA256: BASELINE_V2_NODE_DISTRIBUTION_SHA256,
    AETHEROPS_BASELINE_NPM_VERSION: npmVersion,
    AETHEROPS_BASELINE_RUNNER_SHA256: runnerBundleSha256(repoRoot)
  };
  await checkedRun(toolchain.node, [join(archiveRoot, ".baseline-dist", "scripts", "harness", "legacy-baseline", "runner.js")], {
    cwd: archiveRoot,
    env: runEnvironment,
    timeoutMs: 300_000
  });
  const manifest = buildBaselineV2Manifest(repoRoot, rawRoot, { capturedAt: new Date().toISOString() });
  cpSync(join(rawRoot, "receipts.jsonl"), join(outputRoot, "receipts.jsonl"));
  cpSync(join(rawRoot, "capture-run.json"), join(outputRoot, "capture-run.json"));
  writeFileSync(join(outputRoot, "manifest.json"), await formatPrettier(JSON.stringify(manifest), { parser: "json", endOfLine: "lf" }), "utf8");
  if (args.promote) promoteCapture(outputRoot);
  console.log(`M0 baseline v2 capture: PASS (${relative(repoRoot, outputRoot)})`);
} finally {
  if (!args.keepWork) rmSync(workRoot, { recursive: true, force: true, maxRetries: 8, retryDelay: 125 });
}
async function ensurePortableNode(toolchainsRoot) {
  assert(process.platform === "win32" && process.arch === "x64", "Baseline capture currently requires Windows x64.");
  mkdirSync(toolchainsRoot, { recursive: true });
  const folderName = "node-v22.16.0-win-x64";
  const root = join(toolchainsRoot, folderName);
  const zip = join(toolchainsRoot, `${folderName}.zip`);
  const shasums = join(toolchainsRoot, "node-v22.16.0-SHASUMS256.txt");
  await download("https://nodejs.org/download/release/v22.16.0/SHASUMS256.txt", shasums, 64 * 1024);
  const expectedLine = `${BASELINE_V2_NODE_DISTRIBUTION_SHA256}  ${folderName}.zip`;
  assert(readFileSync(shasums, "utf8").split(/\r?\n/).includes(expectedLine), "Official SHASUMS256 does not contain the pinned Node archive hash.");
  if (!existsSync(zip) || sha256File(zip) !== BASELINE_V2_NODE_DISTRIBUTION_SHA256) {
    await download(`https://nodejs.org/download/release/v22.16.0/${folderName}.zip`, zip, 64 * 1024 * 1024);
  }
  assert(sha256File(zip) === BASELINE_V2_NODE_DISTRIBUTION_SHA256, "Portable Node archive SHA-256 mismatch.");
  if (!existsSync(join(root, "node.exe"))) {
    rmSync(root, { recursive: true, force: true });
    await checkedRun("tar", ["-xf", zip, "-C", toolchainsRoot], { cwd: repoRoot, env: process.env, timeoutMs: 120_000 });
  }
  const node = join(root, "node.exe");
  const npm = join(root, "npm.cmd");
  const version = (await checkedRun(node, ["--version"], { cwd: repoRoot, env: childEnvironment(root, tmpdir(), false), timeoutMs: 30_000 })).stdout.trim();
  assert(version === BASELINE_V2_NODE_VERSION, `Portable Node version mismatch: ${version}`);
  return { root, node, npm };
}
async function extractBaseArchive(workRoot, archiveRoot) {
  const tarFile = join(workRoot, "a0727f2.tar");
  await checkedRun("git", ["archive", "--format=tar", "-o", tarFile, BASELINE_V2_BASE_COMMIT], { cwd: repoRoot, env: process.env, timeoutMs: 60_000 });
  await checkedRun("tar", ["-xf", tarFile, "-C", archiveRoot], { cwd: repoRoot, env: process.env, timeoutMs: 60_000 });
  const tree = (
    await checkedRun("git", ["show", "-s", "--format=%T", BASELINE_V2_BASE_COMMIT], { cwd: repoRoot, env: process.env, timeoutMs: 30_000 })
  ).stdout.trim();
  assert(tree === BASELINE_V2_BASE_TREE, "Extracted baseline tree provenance mismatch.");
}
function copyRunnerBundle(archiveRoot) {
  const source = join(repoRoot, "scripts", "harness", "legacy-baseline");
  const target = join(archiveRoot, "scripts", "harness", "legacy-baseline");
  mkdirSync(target, { recursive: true });
  for (const file of ["adapters.ts", "durableProbe.ts", "receiptRuntime.ts", "runner.ts"]) cpSync(join(source, file), join(target, file));
}
function writeRunnerTsconfig(archiveRoot) {
  const config = {
    compilerOptions: {
      target: "ES2022",
      lib: ["ES2022", "DOM"],
      module: "NodeNext",
      moduleResolution: "NodeNext",
      strict: true,
      skipLibCheck: true,
      esModuleInterop: true,
      allowSyntheticDefaultImports: true,
      forceConsistentCasingInFileNames: true,
      rootDir: "../../..",
      outDir: "../../../.baseline-dist",
      types: ["node"]
    },
    files: ["runner.ts"]
  };
  writeFileSync(runnerTsconfig(archiveRoot), `${JSON.stringify(config, null, 2)}\n`, "utf8");
}
function runnerTsconfig(archiveRoot) {
  return join(archiveRoot, "scripts", "harness", "legacy-baseline", "tsconfig.capture.json");
}
function promoteCapture(outputRoot) {
  const target = resolve(repoRoot, BASELINE_V2_DIRECTORY);
  assert(!existsSync(target), "Baseline v2 fixture already exists; refusing to overwrite immutable evidence.");
  mkdirSync(dirname(target), { recursive: true });
  mkdirSync(target);
  for (const file of ["manifest.json", "receipts.jsonl", "capture-run.json"]) cpSync(join(outputRoot, file), join(target, file));
  const verified = verifyBaselineV2(repoRoot);
  assert(verified?.measurementCompleteness === true, "Promoted baseline v2 failed readback verification.");
}
function childEnvironment(portableRoot, tempRoot, allowRegistryNetwork) {
  mkdirSync(tempRoot, { recursive: true });
  const env = {
    SystemRoot: process.env.SystemRoot,
    ComSpec: process.env.ComSpec,
    PATHEXT: process.env.PATHEXT,
    PATH: `${portableRoot};${process.env.SystemRoot}\\System32;${process.env.SystemRoot}`,
    TEMP: tempRoot,
    TMP: tempRoot,
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
    PYTHONIOENCODING: "utf-8",
    NO_COLOR: "1",
    CI: "1",
    NPM_CONFIG_USERCONFIG: join(tempRoot, "empty-user-npmrc"),
    NPM_CONFIG_CACHE: join(tempRoot, "npm-cache"),
    NPM_CONFIG_AUDIT: "false",
    NPM_CONFIG_FUND: "false",
    NPM_CONFIG_UPDATE_NOTIFIER: "false"
  };
  if (allowRegistryNetwork) {
    for (const key of ["HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "no_proxy"]) if (process.env[key]) env[key] = process.env[key];
  }
  return Object.fromEntries(Object.entries(env).filter(([, value]) => typeof value === "string"));
}
async function download(url, target, maximumBytes) {
  const response = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(120_000) });
  assert(response.ok && response.body, `Official Node download failed with HTTP ${response.status}.`);
  const declared = Number(response.headers.get("content-length") ?? 0);
  assert(!declared || declared <= maximumBytes, "Official Node download exceeded its byte budget.");
  const bytes = Buffer.from(await response.arrayBuffer());
  assert(bytes.length <= maximumBytes, "Official Node download exceeded its byte budget.");
  writeFileSync(target, bytes);
}
function checkedRun(command, parameters, options) {
  return new Promise((resolveRun, reject) => {
    let settled = false;
    const child = spawn(command, parameters, {
      cwd: options.cwd,
      env: options.env,
      windowsHide: true,
      shell: process.platform === "win32" && /\.(?:cmd|bat)$/i.test(command)
    });
    const stdout = [];
    const stderr = [];
    child.stdout?.on("data", (chunk) => stdout.push(String(chunk)));
    child.stderr?.on("data", (chunk) => stderr.push(String(chunk)));
    const timer = setTimeout(() => child.kill("SIGKILL"), options.timeoutMs);
    child.once("error", (error) => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      const result = { exitCode: code ?? 1, stdout: stdout.join(""), stderr: stderr.join("") };
      if (result.exitCode === 0) resolveRun(result);
      else reject(new Error(`${basename(command)} failed with exit ${result.exitCode}: ${sanitizeDiagnostic(result.stderr || result.stdout)}`));
    });
  });
}

function parseArgs(values) {
  const parsed = { outputRoot: undefined, promote: false, keepWork: false };
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value === "--promote") parsed.promote = true;
    else if (value === "--keep-work") parsed.keepWork = true;
    else if (value === "--output-root") {
      const target = values[++index];
      if (!target || target.startsWith("--")) throw new Error("--output-root requires a path below .tmp/harness.");
      parsed.outputRoot = resolve(repoRoot, target);
    } else throw new Error(`Unknown baseline capture argument: ${value}`);
  }
  return parsed;
}

function assertInside(parent, target, label) {
  const child = relative(resolve(parent), resolve(target));
  assert(child && !child.startsWith("..") && !isAbsolute(child), `${label} must be below .tmp/harness.`);
}
function prepareOutputRoot(root) {
  if (!existsSync(root)) {
    mkdirSync(root, { recursive: true });
    return;
  }
  assert(statSync(root).isDirectory() && readdirSync(root).length === 0, "Capture output root must be new or an empty directory.");
}
function sha256File(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}
function sanitizeDiagnostic(value) {
  return value.replace(/(?:bearer\s+\S+|sk-[a-z0-9_-]{8,}|(?:access|refresh|id)_token\S*)/gi, "[REDACTED]").slice(-4_000);
}
function assert(condition, message) {
  if (!condition) throw new Error(message);
}
