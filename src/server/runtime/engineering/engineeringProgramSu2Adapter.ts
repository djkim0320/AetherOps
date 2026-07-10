import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { extname, resolve } from "node:path";
import { resolveEngineeringToolCommand } from "./engineeringToolchain.js";
import { excerpt, safeOutputFileName, validateCfdRunSpecForTarget } from "./engineeringProgramRequestValidator.js";
import { normalizeWorkingDirectory, runCommandWithArgs } from "./engineeringProgramCommands.js";
import type { AppSettings, EngineeringProgramRequest } from "../../../core/shared/types.js";
import type { Su2CaseRunSummary, Su2Config } from "../../../core/tools/engineeringProgramTypes.js";

export function hasConfiguredSu2(settings: AppSettings): boolean {
  if (!settings.engineeringTools.su2.enabled) return false;
  try {
    su2Config(settings);
    validateSu2CaseConfig(settings.engineeringTools.su2.caseRoot, settings.engineeringTools.su2.configFile);
    return true;
  } catch {
    return false;
  }
}

export function su2Config(settings: AppSettings): Su2Config {
  const config = settings.engineeringTools.su2;
  return {
    ...config,
    command: resolveEngineeringToolCommand(settings.engineeringTools, "su2", config.command).command
  };
}

export async function runSu2Case(request: EngineeringProgramRequest, settings: AppSettings): Promise<Su2CaseRunSummary> {
  if (request.target !== "su2") {
    throw new Error("su2-case-run requires target su2.");
  }
  if (!hasConfiguredSu2(settings)) {
    throw new Error("SU2 case execution requires an embedded executable, configured case root, and explicit config file.");
  }
  const config = su2Config(settings);
  if (!config.runArgsTemplate.length) {
    throw new Error("SU2 runArgsTemplate is not configured; AetherOps will not invent solver command arguments.");
  }
  if (!config.runArgsTemplate.some((arg) => arg.includes("{config}"))) {
    throw new Error("SU2 runArgsTemplate must include {config}; AetherOps will not infer an implicit SU2 config file.");
  }
  const cfdRunSpec = validateCfdRunSpecForTarget(request.cfdRunSpec, "su2", settings);
  const su2Case = validateSu2CaseConfig(config.caseRoot, config.configFile);
  const tempRoot = mkdtempSync(joinTempRoot());
  const outputFileName = safeOutputFileName(request.outputFileName, "su2-run-output.txt");
  const outputPath = resolve(tempRoot, outputFileName);
  const generatedConfigPath = resolve(tempRoot, "aetherops-generated-su2.cfg");
  const generatedConfigText = renderSu2Config(readFileSync(su2Case.configPath, "utf8"), cfdRunSpec);
  writeFileSync(generatedConfigPath, generatedConfigText, "utf8");
  const args = renderSu2Args(config.runArgsTemplate, {
    caseRoot: su2Case.caseRoot,
    configPath: generatedConfigPath,
    outputPath,
    workingDirectory: config.workingDirectory
  });
  const cwd = normalizeWorkingDirectory(config.workingDirectory) ?? su2Case.caseRoot;

  try {
    const result = await runCommandWithArgs(config.command as string, args, config.timeoutMs, cwd);
    if (result.exitCode !== 0 || result.timedOut) {
      throw new Error(`SU2 command exited unsuccessfully: exitCode=${result.exitCode}, timedOut=${result.timedOut}, stderr=${result.stderrExcerpt}`);
    }
    const outputTextExcerpt = existsSync(outputPath) ? excerpt(readFileSync(outputPath, "utf8")) : undefined;
    return {
      target: "su2",
      command: config.command as string,
      args,
      caseRoot: su2Case.caseRoot,
      configPath: generatedConfigPath,
      generatedConfigText,
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

export function validateSu2CaseConfig(caseRoot: string | undefined, configFile: string | undefined): { caseRoot: string; configPath: string } {
  if (!caseRoot?.trim()) {
    throw new Error("SU2 case root is not configured.");
  }
  if (!configFile?.trim()) {
    throw new Error("SU2 case config file is not configured.");
  }
  const resolvedRoot = resolve(caseRoot);
  if (!existsSync(resolvedRoot) || !statSync(resolvedRoot).isDirectory()) {
    throw new Error(`Configured SU2 case root does not exist: ${resolvedRoot}`);
  }
  const configuredFile = configFile.trim();
  const configPath = resolve(resolvedRoot, configuredFile);
  if (!existsSync(configPath) || !statSync(configPath).isFile()) {
    throw new Error(`Configured SU2 case config does not exist under case root: ${configuredFile}`);
  }
  if (extname(configPath).toLowerCase() !== ".cfg") {
    throw new Error(`Configured SU2 case config must be a .cfg file: ${configuredFile}`);
  }
  return { caseRoot: resolvedRoot, configPath };
}

function renderSu2Args(template: string[], values: { caseRoot: string; configPath: string; outputPath: string; workingDirectory?: string }): string[] {
  const args: string[] = [];
  for (const arg of template) {
    args.push(
      arg
        .replaceAll("{case}", values.caseRoot)
        .replaceAll("{config}", values.configPath)
        .replaceAll("{output}", values.outputPath)
        .replaceAll("{workdir}", values.workingDirectory ?? "")
    );
  }
  return args;
}

function renderSu2Config(baseConfig: string, spec: ReturnType<typeof validateCfdRunSpecForTarget>): string {
  const entries = new Map<string, string>();
  for (const line of baseConfig.split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (match) entries.set(match[1].toUpperCase(), match[2]);
  }
  const solver =
    spec.solver.model === "rans"
      ? "RANS"
      : spec.solver.model === "euler" || spec.solver.model === "inviscid"
        ? "EULER"
        : String(entries.get("SOLVER") ?? "EULER");
  entries.set("SOLVER", solver);
  entries.set("MACH_NUMBER", formatConfigNumber(spec.flightCondition.mach ?? 0));
  entries.set("REYNOLDS_NUMBER", formatConfigNumber(spec.flightCondition.reynolds ?? 1_000_000));
  entries.set("AOA", formatConfigNumber(spec.flightCondition.alphaStart ?? 0));
  if (spec.solver.turbulenceModel && spec.solver.turbulenceModel !== "none") entries.set("KIND_TURB_MODEL", spec.solver.turbulenceModel.toUpperCase());
  if (spec.solver.maxIterations !== undefined) entries.set("ITER", formatConfigNumber(spec.solver.maxIterations));
  if (spec.solver.convergenceTolerance !== undefined) entries.set("CONV_RESIDUAL_MINVAL", formatConfigNumber(spec.solver.convergenceTolerance));
  for (const [key, value] of Object.entries(spec.solver.configOverrides ?? {})) {
    if (!/^[A-Za-z0-9_]{2,80}$/.test(key)) throw new Error(`Invalid SU2 config override key: ${key}`);
    entries.set(key.toUpperCase(), String(value));
  }
  return `${Array.from(entries.entries())
    .map(([key, value]) => `${key}= ${value}`)
    .join("\n")}\n`;
}

function formatConfigNumber(value: number): string {
  if (!Number.isFinite(value)) throw new Error("Cannot render non-finite CFD config number.");
  return Number(value.toPrecision(12)).toString();
}

function joinTempRoot(): string {
  return `${tmpdir()}\\aetherops-su2-`;
}
