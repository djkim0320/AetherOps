#!/usr/bin/env node
import { createWriteStream, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const toolchainRoot = resolve(process.env.AETHEROPS_ENGINEERING_TOOLCHAIN_ROOT ?? join(repoRoot, "vendor", "engineering-tools"));
const cacheRoot = resolve(process.env.AETHEROPS_ENGINEERING_TOOLCHAIN_CACHE ?? join(repoRoot, ".aetherops", "toolchain-cache"));

const packages = [
  {
    id: "openvsp",
    version: "latest",
    license: "NASA-1.3",
    page: "https://openvsp.org/download.php",
    filenamePattern: /href=["']([^"']*OpenVSP-[^"']*win64[^"']*Python3\.13\.zip[^"']*)["']/i,
    executableNames: ["vspscript.exe", "vsp.exe"]
  },
  {
    id: "xflr5",
    version: "6.62",
    license: "GPL-3.0",
    url: "https://sourceforge.net/projects/xflr5/files/6.62/xflr5_v6.62_win64.zip/download",
    executableNames: ["xflr5.exe", "XFLR5.exe"]
  },
  {
    id: "su2",
    version: "8.5.0",
    license: "LGPL-2.1",
    releaseApi: "https://api.github.com/repos/su2code/SU2/releases/latest",
    assetPattern: /win64-omp\.zip$/i,
    executableNames: ["SU2_CFD.exe"]
  }
];

mkdirSync(toolchainRoot, { recursive: true });
mkdirSync(cacheRoot, { recursive: true });

const installed = [];
for (const pkg of packages) {
  const targetRoot = join(toolchainRoot, pkg.id);
  const url = pkg.url ?? await resolvePackageUrl(pkg);
  const archivePath = join(cacheRoot, `${pkg.id}.zip`);
  process.stdout.write(`Downloading ${pkg.id} from ${url}\n`);
  await download(url, archivePath);
  rmSync(targetRoot, { recursive: true, force: true });
  mkdirSync(targetRoot, { recursive: true });
  expandArchive(archivePath, targetRoot);
  expandRootLevelNestedArchives(targetRoot);
  const executable = findExecutable(targetRoot, pkg.executableNames);
  if (!executable) {
    throw new Error(`${pkg.id} archive was extracted but no expected executable was found: ${pkg.executableNames.join(", ")}`);
  }
  installed.push({
    id: pkg.id,
    version: pkg.version,
    license: pkg.license,
    sourceUrl: url,
    installedAt: new Date().toISOString(),
    root: targetRoot,
    executable
  });
}

const manifestPath = join(toolchainRoot, "manifest.json");
writeFileSync(manifestPath, `${JSON.stringify({ generatedAt: new Date().toISOString(), packages: installed }, null, 2)}\n`, "utf8");
process.stdout.write(`Embedded engineering toolchain installed at ${toolchainRoot}\n`);

async function resolvePackageUrl(pkg) {
  if (pkg.releaseApi) return resolveReleaseAssetUrl(pkg);
  const pageText = await fetchText(pkg.page);
  const match = pageText.match(pkg.filenamePattern);
  if (match?.[1]) return new URL(match[1].replace(/&amp;/g, "&"), pkg.page).toString();
  throw new Error(`Could not discover download URL for ${pkg.id} from ${pkg.page}`);
}

async function resolveReleaseAssetUrl(pkg) {
  const release = await fetchJson(pkg.releaseApi);
  const asset = release.assets?.find((candidate) => pkg.assetPattern.test(candidate.name));
  if (!asset?.browser_download_url) {
    throw new Error(`Could not discover ${pkg.id} asset from ${pkg.releaseApi}`);
  }
  return asset.browser_download_url;
}

async function fetchText(url) {
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok) throw new Error(`GET ${url} failed with ${response.status}`);
  return response.text();
}

async function fetchJson(url) {
  const response = await fetch(url, {
    redirect: "follow",
    headers: { "User-Agent": "AetherOps-embedded-engineering-toolchain" }
  });
  if (!response.ok) throw new Error(`GET ${url} failed with ${response.status}`);
  return response.json();
}

async function download(url, outputPath) {
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok || !response.body) throw new Error(`Download failed for ${url}: ${response.status}`);
  mkdirSync(dirname(outputPath), { recursive: true });
  await pipeline(response.body, createWriteStream(outputPath));
}

function expandArchive(archivePath, outputRoot) {
  if (process.platform === "win32") {
    const result = spawnSync("powershell.exe", ["-NoProfile", "-Command", "Expand-Archive", "-LiteralPath", archivePath, "-DestinationPath", outputRoot, "-Force"], {
      stdio: "pipe",
      encoding: "utf8"
    });
    if (result.status !== 0) throw new Error(`Expand-Archive failed: ${result.stderr || result.stdout}`);
    return;
  }
  const unzip = spawnSync("unzip", ["-q", archivePath, "-d", outputRoot], { stdio: "pipe", encoding: "utf8" });
  if (unzip.status !== 0) throw new Error(`unzip failed: ${unzip.stderr || unzip.stdout}`);
}

function expandRootLevelNestedArchives(root) {
  for (const entry of safeReadDir(root)) {
    if (!entry.isFile() || !entry.name.toLowerCase().endsWith(".zip")) continue;
    const archivePath = join(root, entry.name);
    expandArchive(archivePath, root);
    rmSync(archivePath, { force: true });
  }
}

function findExecutable(root, names) {
  const queue = [root];
  while (queue.length) {
    const current = queue.shift();
    const entries = safeReadDir(current);
    const filesByName = new Map(entries.filter((entry) => entry.isFile()).map((entry) => [entry.name.toLowerCase(), entry.name]));
    for (const name of names) {
      const fileName = filesByName.get(name.toLowerCase());
      if (fileName) return join(current, fileName);
    }
    for (const entry of entries) {
      const child = join(current, entry.name);
      if (entry.isDirectory()) queue.push(child);
    }
  }
  return undefined;
}

function safeReadDir(path) {
  try {
    return readdirSync(path, { withFileTypes: true });
  } catch {
    return [];
  }
}
