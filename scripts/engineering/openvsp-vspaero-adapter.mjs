#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, join, resolve } from "node:path";

const args = parseArgs(process.argv.slice(2));
const toolCommand = requiredArg(args, "tool-command");
const specPath = requiredArg(args, "spec");
const outputPath = requiredArg(args, "output");
const geometryPath = requiredArg(args, "geometry-path");
const workdir = resolve(args.workdir ?? dirname(outputPath));
const timeoutMs = positiveInteger(args["timeout-ms"], 30 * 60 * 1000);

if (!existsSync(specPath)) fail(`CFD run spec does not exist: ${specPath}`);
if (!existsSync(geometryPath)) fail(`OpenVSP geometry file does not exist: ${geometryPath}`);
if (extname(geometryPath).toLowerCase() !== ".vsp3") {
  fail("Built-in OpenVSP/VSPAERO execution requires a prepared .vsp3 geometry artifact. Use a custom OpenVSP script for other formats.");
}

const spec = JSON.parse(readFileSync(specPath, "utf8"));
const scriptPath = join(workdir, "aetherops-openvsp-vspaero.vspscript");
writeFileSync(scriptPath, buildOpenVspScript(resolve(geometryPath), spec), "utf8");

const base = basename(unquote(toolCommand)).toLowerCase();
const toolArgs = base.includes("vspscript") ? [scriptPath] : ["-script", scriptPath];
const result = await runCommand(unquote(toolCommand), toolArgs, workdir, timeoutMs);

if (result.exitCode !== 0 || result.timedOut) {
  fail(`OpenVSP command failed: exitCode=${result.exitCode}, timedOut=${result.timedOut}, stderr=${excerpt(result.stderr)}`);
}
if (!result.stdout.includes("AETHEROPS_OPENVSP_ALPHA_APPLIED=true")) {
  fail(`OpenVSP did not confirm that alpha parameters were applied. stdout=${excerpt(result.stdout)} stderr=${excerpt(result.stderr)}`);
}
if (!result.stdout.includes("AETHEROPS_OPENVSP_SWEEP_RESULT=")) {
  fail(`OpenVSP did not report a VSPAERO sweep result id. stdout=${excerpt(result.stdout)} stderr=${excerpt(result.stderr)}`);
}

const summary = {
  program: "openvsp-vspaero",
  adapter: "aetherops-built-in-openvsp-vspaero",
  toolCommand: unquote(toolCommand),
  toolArgs,
  spec,
  geometryPath: resolve(geometryPath),
  generatedScriptPath: scriptPath,
  exitCode: result.exitCode,
  timedOut: result.timedOut,
  stdoutExcerpt: excerpt(result.stdout),
  stderrExcerpt: excerpt(result.stderr)
};
writeFileSync(outputPath, `${JSON.stringify(summary, null, 2)}\n`, "utf8");

function buildOpenVspScript(vsp3Path, spec) {
  const flight = spec.flightCondition ?? {};
  const alphaStart = numberOrDefault(flight.alphaStart, -4);
  const alphaEnd = numberOrDefault(flight.alphaEnd, 12);
  const alphaStep = numberOrDefault(flight.alphaStep, 2);
  const mach = numberOrDefault(flight.mach, 0);
  const reynolds = numberOrDefault(flight.reynolds, 1_000_000);
  const alphaCount = Math.max(1, Math.floor((alphaEnd - alphaStart) / alphaStep) + 1);
  return `bool TrySetDoubleInput(const string &in analysis, const string &in name, double value)
{
    array<string>@ names = GetAnalysisInputNames(analysis);
    for (int i = 0; i < int(names.size()); i++)
    {
        if (names[i] == name)
        {
            array<double>@ values = GetDoubleAnalysisInput(analysis, name);
            if (values.size() > 0)
            {
                values[0] = value;
                SetDoubleAnalysisInput(analysis, name, values, 0);
                return true;
            }
        }
    }
    return false;
}

bool TrySetIntInput(const string &in analysis, const string &in name, int value)
{
    array<string>@ names = GetAnalysisInputNames(analysis);
    for (int i = 0; i < int(names.size()); i++)
    {
        if (names[i] == name)
        {
            array<int>@ values = GetIntAnalysisInput(analysis, name);
            if (values.size() > 0)
            {
                values[0] = value;
                SetIntAnalysisInput(analysis, name, values, 0);
                return true;
            }
        }
    }
    return false;
}

void PrintBool(const string &in name, bool value)
{
    if (value) Print(name + "=true");
    else Print(name + "=false");
}

void main()
{
    string geometry_path = "${escapeAngelScriptString(vsp3Path)}";
    ClearVSPModel();
    ReadVSPFile(geometry_path);
    Print("AETHEROPS_OPENVSP_GEOMETRY=" + geometry_path);

    string geometry_analysis = "VSPAEROComputeGeometry";
    SetAnalysisInputDefaults(geometry_analysis);
    string geometry_result = ExecAnalysis(geometry_analysis);
    Print("AETHEROPS_OPENVSP_COMPUTE_GEOMETRY_RESULT=" + geometry_result);

    string sweep_analysis = "VSPAEROSweep";
    SetAnalysisInputDefaults(sweep_analysis);
    bool alpha_start = TrySetDoubleInput(sweep_analysis, "AlphaStart", ${formatNumber(alphaStart)});
    bool alpha_end = TrySetDoubleInput(sweep_analysis, "AlphaEnd", ${formatNumber(alphaEnd)});
    bool alpha_single = TrySetDoubleInput(sweep_analysis, "Alpha", ${formatNumber(alphaStart)});
    bool alpha_count = TrySetIntInput(sweep_analysis, "AlphaNpts", ${alphaCount});
    bool mach_start = TrySetDoubleInput(sweep_analysis, "MachStart", ${formatNumber(mach)});
    bool mach_end = TrySetDoubleInput(sweep_analysis, "MachEnd", ${formatNumber(mach)});
    bool mach_single = TrySetDoubleInput(sweep_analysis, "Mach", ${formatNumber(mach)});
    bool reynolds_ref = TrySetDoubleInput(sweep_analysis, "ReCref", ${formatNumber(reynolds)});

    PrintBool("AETHEROPS_OPENVSP_ALPHA_APPLIED", (alpha_single || (alpha_start && alpha_end)));
    PrintBool("AETHEROPS_OPENVSP_ALPHA_COUNT_APPLIED", alpha_count);
    PrintBool("AETHEROPS_OPENVSP_MACH_APPLIED", (mach_single || (mach_start && mach_end)));
    PrintBool("AETHEROPS_OPENVSP_REYNOLDS_APPLIED", reynolds_ref);

    PrintAnalysisInputs(sweep_analysis);
    string sweep_result = ExecAnalysis(sweep_analysis);
    Print("AETHEROPS_OPENVSP_SWEEP_RESULT=" + sweep_result);
}
`;
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

function positiveInteger(value, defaultValue) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : defaultValue;
}

function numberOrDefault(value, defaultValue) {
  return typeof value === "number" && Number.isFinite(value) ? value : defaultValue;
}

function formatNumber(value) {
  if (!Number.isFinite(value)) fail(`Invalid numeric OpenVSP parameter: ${value}`);
  return String(value);
}

function escapeAngelScriptString(value) {
  return value.replace(/\\/g, "/").replace(/"/g, "\\\"");
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
