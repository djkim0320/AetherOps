import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { resolveEngineeringToolCommand } from "./engineeringToolchain.js";
import { excerpt, safeOutputFileName, validateCfdRunSpecForTarget } from "./engineeringProgramRequestValidator.js";
import { normalizeWorkingDirectory, probeScriptedCfd, runCommandWithArgs } from "./engineeringProgramCommands.js";
import { hasConfiguredModelingRoot, resolveConfiguredModelingRoot, resolveInsideRoot } from "./engineeringProgramMeshAdapter.js";
import type { AppSettings, CfdRunSpec, EngineeringProgramRequest, EngineeringProgramTarget } from "../../../core/shared/types.js";
import type { ScriptedCfdConfig, ScriptedCfdRunSummary } from "../../../core/tools/engineeringProgramTypes.js";

export function hasConfiguredOpenVsp(settings: AppSettings): boolean {
  if (!settings.engineeringTools.openVsp.enabled) return false;
  try {
    validateScriptedCfdAvailability(scriptedCfdConfig(settings, "openvsp"));
    return true;
  } catch {
    return false;
  }
}

export function hasConfiguredXflr5(settings: AppSettings): boolean {
  if (!settings.engineeringTools.xflr5.enabled) return false;
  try {
    validateScriptedCfdAvailability(scriptedCfdConfig(settings, "xflr5"));
    return true;
  } catch {
    return false;
  }
}

export function scriptedCfdConfig(settings: AppSettings, target: Extract<EngineeringProgramTarget, "openvsp" | "xflr5">): ScriptedCfdConfig {
  if (target === "openvsp") {
    const config = settings.engineeringTools.openVsp;
    return {
      target,
      label: "OpenVSP",
      command: resolveEngineeringToolCommand(settings.engineeringTools, "openvsp", config.command).command,
      scriptPath: config.scriptPath,
      workingDirectory: config.workingDirectory,
      probeArgs: config.probeArgs,
      runArgsTemplate: config.runArgsTemplate,
      timeoutMs: config.timeoutMs
    };
  }
  const config = settings.engineeringTools.xflr5;
  return {
    target,
    label: "XFLR5",
    command: resolveEngineeringToolCommand(settings.engineeringTools, "xflr5", config.command).command,
    scriptPath: config.scriptPath,
    workingDirectory: config.workingDirectory,
    probeArgs: config.probeArgs,
    runArgsTemplate: config.runArgsTemplate,
    timeoutMs: config.timeoutMs
  };
}

export function validateScriptedCfdScriptPath(config: ScriptedCfdConfig): string {
  if (!config.scriptPath?.trim()) {
    throw new Error(`${config.label} script path is not configured.`);
  }
  const resolved = resolve(config.scriptPath);
  if (!existsSync(resolved) || !statSync(resolved).isFile()) {
    throw new Error(`Configured ${config.label} script path does not exist: ${resolved}`);
  }
  return resolved;
}

export function validateOptionalScriptedCfdScriptPath(config: ScriptedCfdConfig): string | undefined {
  if (!config.scriptPath?.trim()) return undefined;
  return validateScriptedCfdScriptPath(config);
}

export function validateCustomScriptedCfdTemplate(config: ScriptedCfdConfig): void {
  if (!config.runArgsTemplate.length) {
    throw new Error(`${config.label} custom script runArgsTemplate is not configured.`);
  }
  if (!config.runArgsTemplate.some((arg) => arg.includes("{script}"))) {
    throw new Error(`${config.label} custom script runArgsTemplate must include {script}.`);
  }
  if (!config.runArgsTemplate.some((arg) => arg.includes("{spec}"))) {
    throw new Error(`${config.label} custom script runArgsTemplate must include {spec}.`);
  }
}

export function validateScriptedCfdAvailability(config: ScriptedCfdConfig): void {
  if (validateOptionalScriptedCfdScriptPath(config)) {
    return;
  }
  validateBuiltinScriptedCfdAdapterPath(config.target);
}

export function validateBuiltinScriptedCfdAdapterPath(target: Extract<EngineeringProgramTarget, "openvsp" | "xflr5">): string {
  const fileName = target === "openvsp" ? "openvsp-vspaero-adapter.mjs" : "xflr5-batch-adapter.mjs";
  const adapterPath = resolve("scripts", "engineering", fileName);
  if (!existsSync(adapterPath) || !statSync(adapterPath).isFile()) {
    throw new Error(`Built-in ${target} CFD adapter is missing: ${adapterPath}`);
  }
  return adapterPath;
}

export async function runScriptedCfdAnalysis(
  request: EngineeringProgramRequest,
  settings: AppSettings,
  target: Extract<EngineeringProgramTarget, "openvsp" | "xflr5">,
  signal?: AbortSignal
): Promise<ScriptedCfdRunSummary> {
  signal?.throwIfAborted();
  if (request.target !== target) {
    throw new Error(`${target} analysis requires target ${target}.`);
  }
  const config = scriptedCfdConfig(settings, target);
  if (target === "openvsp" && !hasConfiguredOpenVsp(settings)) {
    throw new Error("OpenVSP analysis requires an embedded executable and either the built-in runner or a valid custom script contract.");
  }
  if (target === "xflr5" && !hasConfiguredXflr5(settings)) {
    throw new Error("XFLR5 analysis requires an embedded executable and either the built-in runner or a valid custom script contract.");
  }
  const cfdRunSpec = validateCfdRunSpecForTarget(request.cfdRunSpec, target, settings);
  const tempRoot = mkdtempSync(`${tmpdir()}\\aetherops-${target}-`);
  const outputFileName = safeOutputFileName(request.outputFileName, `${target}-analysis-output.json`);
  const outputPath = resolve(tempRoot, outputFileName);
  const cfdSpecPath = resolve(tempRoot, "aetherops-cfd-run-spec.json");
  writeFileSync(cfdSpecPath, `${JSON.stringify(cfdRunSpec, null, 2)}\n`, "utf8");
  const cwd = normalizeWorkingDirectory(config.workingDirectory);
  const runPlan = createScriptedCfdRunPlan(config, cfdRunSpec, settings, cfdSpecPath, outputPath, cwd);

  try {
    const result = await runCommandWithArgs(runPlan.launcherCommand, runPlan.args, config.timeoutMs, cwd, signal);
    signal?.throwIfAborted();
    if (result.exitCode !== 0 || result.timedOut) {
      throw new Error(
        `${config.label} adapter exited unsuccessfully: exitCode=${result.exitCode}, timedOut=${result.timedOut}, stderr=${result.stderrExcerpt}`
      );
    }
    const outputTextExcerpt = existsSync(outputPath) ? excerpt(readFileSync(outputPath, "utf8")) : undefined;
    return {
      target,
      label: config.label,
      command: config.command as string,
      launcherCommand: runPlan.launcherCommand,
      args: runPlan.args,
      adapterMode: runPlan.adapterMode,
      scriptPath: runPlan.scriptPath,
      builtinAdapterPath: runPlan.builtinAdapterPath,
      geometryPath: runPlan.geometryPath,
      meshPath: runPlan.meshPath,
      cfdSpecPath,
      cfdRunSpec,
      workingDirectory: cwd,
      outputFileName,
      outputTextExcerpt,
      exitCode: result.exitCode,
      timedOut: result.timedOut,
      stdoutExcerpt: result.stdoutExcerpt,
      stderrExcerpt: result.stderrExcerpt
    };
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

export async function probeScriptedCfdAdapter(config: ScriptedCfdConfig) {
  return probeScriptedCfd(config);
}

function renderScriptedCfdArgs(
  template: string[],
  values: { scriptPath: string; cfdSpecPath: string; outputPath: string; workingDirectory?: string }
): string[] {
  const args: string[] = [];
  for (const arg of template) {
    args.push(
      arg
        .replaceAll("{script}", values.scriptPath)
        .replaceAll("{spec}", values.cfdSpecPath)
        .replaceAll("{output}", values.outputPath)
        .replaceAll("{workdir}", values.workingDirectory ?? "")
    );
  }
  return args;
}

function createScriptedCfdRunPlan(
  config: ScriptedCfdConfig,
  cfdRunSpec: CfdRunSpec,
  settings: AppSettings,
  cfdSpecPath: string,
  outputPath: string,
  workingDirectory: string | undefined
): {
  launcherCommand: string;
  args: string[];
  adapterMode: "builtin" | "custom";
  scriptPath?: string;
  builtinAdapterPath?: string;
  geometryPath?: string;
  meshPath?: string;
} {
  const customScriptPath = validateOptionalScriptedCfdScriptPath(config);
  if (customScriptPath) {
    validateCustomScriptedCfdTemplate(config);
    return {
      launcherCommand: config.command as string,
      args: renderScriptedCfdArgs(config.runArgsTemplate, { scriptPath: customScriptPath, cfdSpecPath, outputPath, workingDirectory }),
      adapterMode: "custom",
      scriptPath: customScriptPath
    };
  }

  const builtinAdapterPath = validateBuiltinScriptedCfdAdapterPath(config.target);
  const geometryPath = resolveCfdGeometryArtifactPath(cfdRunSpec, settings);
  const meshPath = resolveCfdMeshArtifactPath(cfdRunSpec, settings);
  const args = [
    builtinAdapterPath,
    "--tool-command",
    config.command as string,
    "--spec",
    cfdSpecPath,
    "--output",
    outputPath,
    "--timeout-ms",
    String(Math.max(1_000, config.timeoutMs - 1_000))
  ];
  if (workingDirectory) args.push("--workdir", workingDirectory);
  if (geometryPath) args.push("--geometry-path", geometryPath);
  if (meshPath) args.push("--mesh-path", meshPath);
  return {
    launcherCommand: process.execPath,
    args,
    adapterMode: "builtin",
    builtinAdapterPath,
    geometryPath,
    meshPath
  };
}

function resolveCfdGeometryArtifactPath(spec: CfdRunSpec, settings: AppSettings): string | undefined {
  if (spec.geometry.source !== "artifact" || !spec.geometry.artifactPath) return undefined;
  if (!hasConfiguredModelingRoot(settings)) throw new Error("cfdRunSpec artifact geometry requires a configured modeling artifact root.");
  const artifactRoot = resolveConfiguredModelingRoot(settings);
  return resolveInsideRoot(artifactRoot, spec.geometry.artifactPath);
}

function resolveCfdMeshArtifactPath(spec: CfdRunSpec, settings: AppSettings): string | undefined {
  if (!spec.mesh?.artifactPath) return undefined;
  if (!hasConfiguredModelingRoot(settings)) throw new Error("cfdRunSpec mesh artifact requires a configured modeling artifact root.");
  const artifactRoot = resolveConfiguredModelingRoot(settings);
  return resolveInsideRoot(artifactRoot, spec.mesh.artifactPath);
}
