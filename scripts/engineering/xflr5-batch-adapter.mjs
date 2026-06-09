#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, join, resolve } from "node:path";

const args = parseArgs(process.argv.slice(2));
const toolCommand = requiredArg(args, "tool-command");
const specPath = requiredArg(args, "spec");
const outputPath = requiredArg(args, "output");
const workdir = resolve(args.workdir ?? dirname(outputPath));
const timeoutMs = positiveInteger(args["timeout-ms"], 30 * 60 * 1000);
const geometryPath = args["geometry-path"] ? resolve(args["geometry-path"]) : undefined;

if (!existsSync(specPath)) fail(`CFD run spec does not exist: ${specPath}`);
const spec = JSON.parse(readFileSync(specPath, "utf8"));
const geometry = spec.geometry ?? {};
if (geometryPath && !existsSync(geometryPath)) fail(`XFLR5 geometry file does not exist: ${geometryPath}`);

const geometryExtension = geometryPath ? extname(geometryPath).toLowerCase() : "";
const hasAirfoilArtifact = Boolean(geometryPath && (geometryExtension === ".dat" || geometryExtension === ".txt"));
const hasNaca = geometry.source === "naca" && typeof geometry.naca === "string" && /^\d{4,5}$/.test(geometry.naca);
if (!hasAirfoilArtifact && !hasNaca) {
  fail("Built-in XFLR5 execution requires an airfoil coordinate artifact (.dat/.txt) or NACA geometry. Use a custom XFLR5 script for wing/plane project files.");
}

const scriptPath = join(workdir, "aetherops-xflr5-analysis.xml");
const polarOutputPath = join(workdir, "aetherops-xflr5-polar.csv");
writeFileSync(scriptPath, buildXflr5Script(spec, geometryPath, polarOutputPath), "utf8");

const toolArgs = [scriptPath];
const result = await runCommand(unquote(toolCommand), toolArgs, workdir, timeoutMs);
if (result.exitCode !== 0 || result.timedOut) {
  fail(`XFLR5 command failed: exitCode=${result.exitCode}, timedOut=${result.timedOut}, stderr=${excerpt(result.stderr)}`);
}
if (!existsSync(polarOutputPath)) {
  fail(`XFLR5 completed without producing the requested polar output file: ${polarOutputPath}. stdout=${excerpt(result.stdout)} stderr=${excerpt(result.stderr)}`);
}

const polarText = readFileSync(polarOutputPath, "utf8");
const summary = {
  program: "xflr5",
  adapter: "aetherops-built-in-xflr5-batch",
  toolCommand: unquote(toolCommand),
  toolArgs,
  spec,
  geometryPath,
  generatedScriptPath: scriptPath,
  polarOutputPath,
  polarOutputExcerpt: excerpt(polarText),
  exitCode: result.exitCode,
  timedOut: result.timedOut,
  stdoutExcerpt: excerpt(result.stdout),
  stderrExcerpt: excerpt(result.stderr)
};
writeFileSync(outputPath, `${JSON.stringify(summary, null, 2)}\n`, "utf8");

function buildXflr5Script(spec, geometryPathValue, polarOutputPathValue) {
  const flight = spec.flightCondition ?? {};
  const geometry = spec.geometry ?? {};
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<xflr5_script version="1">',
    '  <analysis type="foil_polar">',
    geometryPathValue
      ? `    <airfoil file="${escapeXml(resolve(geometryPathValue))}" />`
      : `    <airfoil naca="${escapeXml(geometry.naca)}" />`,
    `    <reynolds value="${numberOrDefault(flight.reynolds, 1_000_000)}" />`,
    `    <mach value="${numberOrDefault(flight.mach, 0)}" />`,
    `    <alpha start="${numberOrDefault(flight.alphaStart, -4)}" end="${numberOrDefault(flight.alphaEnd, 12)}" step="${numberOrDefault(flight.alphaStep, 2)}" />`,
    `    <output polar="${escapeXml(resolve(polarOutputPathValue))}" />`,
    '  </analysis>',
    '</xflr5_script>',
    ''
  ].join("\n");
}

function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (!item.startsWith("--")) fail(`Unexpected argument: ${item}`);
    const key = item.slice(2);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) fail(`Missing value for --${key}`);
    parsed[key] = value;
    index += 1;
  }
  return parsed;
}

function requiredArg(parsed, key) {
  const value = parsed[key];
  if (!value || !String(value).trim()) fail(`Missing required --${key}`);
  return String(value);
}

function runCommand(command, commandArgs, cwd, timeoutMsValue) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, commandArgs, { cwd, shell: false, windowsHide: true });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timeout = setTimeout(() => {
      settled = true;
      child.kill();
      resolveRun({ exitCode: null, timedOut: true, stdout, stderr });
    }, timeoutMsValue);
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      rejectRun(error);
    });
    child.on("close", (exitCode) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolveRun({ exitCode, timedOut: false, stdout, stderr });
    });
  });
}

function numberOrDefault(value, defaultValue) {
  return typeof value === "number" && Number.isFinite(value) ? value : defaultValue;
}

function positiveInteger(value, defaultValue) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : defaultValue;
}

function escapeXml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function excerpt(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim().slice(0, 1200);
}

function unquote(value) {
  return String(value).replace(/^["']|["']$/g, "").trim();
}

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}
