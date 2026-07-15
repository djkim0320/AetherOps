import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, extname, join } from "node:path";
import { resolveEngineeringToolCommand } from "./engineeringToolchain.js";
import { boundedNumber, boundedPositiveNumber, requestWithCfdSpecDefaults } from "./engineeringProgramRequestValidator.js";
import { resolveConfiguredModelingRoot, resolveInsideRoot } from "./engineeringProgramMeshAdapter.js";
import { runCommandWithInput } from "./engineeringProgramCommands.js";
import type { AppSettings, EngineeringProgramRequest } from "../../../core/shared/types.js";
import { normalizeNacaSeries } from "../../../core/tools/airfoilIdentity.js";
import type { XfoilPolarRow, XfoilPolarSummary } from "../../../core/tools/engineeringProgramTypes.js";

export function hasConfiguredXfoil(settings: AppSettings): boolean {
  if (!settings.engineeringTools.xfoil.enabled) return false;
  try {
    resolveXfoilCommand(settings);
    return true;
  } catch {
    return false;
  }
}

export function resolveXfoilCommand(settings: AppSettings): string {
  return resolveEngineeringToolCommand(settings.engineeringTools, "xfoil", settings.engineeringTools.xfoil.command).command;
}

export async function runXfoilPolar(request: EngineeringProgramRequest, settings: AppSettings, signal?: AbortSignal): Promise<XfoilPolarSummary> {
  signal?.throwIfAborted();
  if (!hasConfiguredXfoil(settings)) {
    throw new Error("XFOIL polar execution requires an embedded XFOIL executable or explicit executable path.");
  }
  const executionRequest = requestWithCfdSpecDefaults(request, "xfoil", settings);
  const airfoil = xfoilAirfoilInput(executionRequest, settings);
  const reynolds = boundedPositiveNumber(executionRequest.reynolds, 1_000, 100_000_000, 1_000_000, "reynolds");
  const mach = boundedPositiveNumber(executionRequest.mach, 0, 0.8, 0, "mach");
  const alphaStart = boundedNumber(executionRequest.alphaStart, -30, 30, -4, "alphaStart");
  const alphaEnd = boundedNumber(executionRequest.alphaEnd, -30, 30, 12, "alphaEnd");
  const alphaStep = boundedPositiveNumber(executionRequest.alphaStep, 0.1, 10, 2, "alphaStep");
  if (alphaEnd < alphaStart) {
    throw new Error("XFOIL polar request requires alphaEnd >= alphaStart.");
  }

  const tempRoot = mkdtempSync(join(tmpdir(), "aetherops-xfoil-"));
  const polarPath = join(tempRoot, "polar.txt");
  const commandInput = [
    airfoil.command,
    "OPER",
    "ITER 100",
    `VISC ${reynolds}`,
    `MACH ${mach}`,
    "PACC",
    polarPath,
    "",
    `ASEQ ${alphaStart} ${alphaEnd} ${alphaStep}`,
    "PACC",
    "",
    "QUIT",
    ""
  ].join("\n");

  try {
    const probe = await runCommandWithInput(resolveXfoilCommand(settings), commandInput, settings.engineeringTools.xfoil.timeoutMs, signal);
    signal?.throwIfAborted();
    if (!existsSync(polarPath)) {
      throw new Error(`XFOIL did not produce a polar file. stdout=${probe.stdoutExcerpt} stderr=${probe.stderrExcerpt}`);
    }
    const polarText = readFileSync(polarPath, "utf8");
    const rows = parseXfoilPolarRows(polarText);
    if (!rows.length) {
      throw new Error(`XFOIL polar file contained no numeric rows. stdout=${probe.stdoutExcerpt} stderr=${probe.stderrExcerpt}`);
    }
    return {
      airfoil: airfoil.label,
      reynolds,
      mach,
      alphaStart,
      alphaEnd,
      alphaStep,
      rowCount: rows.length,
      rows,
      stdoutExcerpt: probe.stdoutExcerpt,
      stderrExcerpt: probe.stderrExcerpt
    };
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

export function parseXfoilPolarRows(text: string): XfoilPolarRow[] {
  const rows: XfoilPolarRow[] = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || !/^[+-]?(?:\d+\.?\d*|\.\d+)/.test(trimmed)) continue;
    const values = trimmed.split(/\s+/).map(Number);
    if (values.length < 3 || !values.slice(0, 3).every(Number.isFinite)) continue;
    rows.push({
      alpha: values[0] as number,
      cl: values[1] as number,
      cd: values[2] as number,
      cdp: Number.isFinite(values[3]) ? values[3] : undefined,
      cm: Number.isFinite(values[4]) ? values[4] : undefined,
      topXtr: unitIntervalNumber(values[5]),
      botXtr: unitIntervalNumber(values[6])
    });
  }
  return rows;
}

function xfoilAirfoilInput(request: EngineeringProgramRequest, settings: AppSettings): { command: string; label: string } {
  const naca = request.naca?.trim();
  if (naca) {
    const series = normalizeNacaSeries(naca);
    return { command: `NACA ${series}`, label: `NACA ${series}` };
  }
  if (!request.artifactPath?.trim()) {
    throw new Error("XFOIL polar execution requires either naca or artifactPath.");
  }
  const artifactRoot = resolveConfiguredModelingRoot(settings);
  const targetPath = resolveInsideRoot(artifactRoot, request.artifactPath);
  if (!existsSync(targetPath)) {
    throw new Error(`XFOIL airfoil coordinate file does not exist under configured root: ${request.artifactPath}`);
  }
  const stats = statSync(targetPath);
  if (!stats.isFile()) {
    throw new Error(`XFOIL airfoil coordinate path is not a file: ${request.artifactPath}`);
  }
  if (stats.size > settings.engineeringTools.modeling.maxMeshBytes) {
    throw new Error(`XFOIL airfoil coordinate file exceeds maxMeshBytes (${stats.size} > ${settings.engineeringTools.modeling.maxMeshBytes}).`);
  }
  return { command: `LOAD ${targetPath}\n${basename(targetPath, extname(targetPath))}\nPANE`, label: basename(targetPath) };
}

function unitIntervalNumber(value: number | undefined): number | undefined {
  return value !== undefined && Number.isFinite(value) && value >= 0 && value <= 1 ? value : undefined;
}
