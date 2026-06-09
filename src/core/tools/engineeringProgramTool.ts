import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, extname, isAbsolute, join, relative, resolve } from "node:path";
import { createId, nowIso } from "../shared/ids.js";
import { resolveEngineeringToolCommand } from "./engineeringToolchain.js";
import type { ResearchTool, ResearchToolResult } from "./toolRegistry.js";
import type {
  AppSettings,
  EngineeringProgramCapability,
  EngineeringProgramPreflightResult,
  EngineeringProgramRequest,
  EngineeringProgramTarget,
  EvidenceItem,
  OpenCodeRunInput,
  ResearchArtifact,
  CfdRunSpec,
  ToolRun
} from "../shared/types.js";

export interface MeshSummary {
  fileName: string;
  format: "obj" | "stl-ascii" | "stl-binary";
  byteLength: number;
  vertexCount: number;
  faceCount: number;
  triangleCount: number;
  boundingBox?: {
    min: [number, number, number];
    max: [number, number, number];
  };
}

interface CommandProbeResult {
  command: string;
  exitCode: number | null;
  timedOut: boolean;
  stdoutExcerpt: string;
  stderrExcerpt: string;
}

interface XfoilPolarRow {
  alpha: number;
  cl: number;
  cd: number;
  cdp?: number;
  cm?: number;
  topXtr?: number;
  botXtr?: number;
}

interface XfoilPolarSummary {
  airfoil: string;
  reynolds: number;
  mach: number;
  alphaStart: number;
  alphaEnd: number;
  alphaStep: number;
  rowCount: number;
  rows: XfoilPolarRow[];
  stdoutExcerpt: string;
  stderrExcerpt: string;
}

interface XfoilWasmPolarSummary {
  airfoil: string;
  runtime: "webxfoil-wasm";
  runtimeVersion: string;
  runtimeLicense: "GPL-2.0-or-later";
  sourceKind: "artifact" | "source" | "direct-url" | "naca";
  sourceLabel: string;
  sourceUrl?: string;
  sourceArtifactPath?: string;
  coordinateFormat?: string;
  reynolds: number;
  mach: number;
  alphaStart: number;
  alphaEnd: number;
  alphaStep: number;
  rowCount: number;
  rows: XfoilPolarRow[];
  stdoutExcerpt: string;
  stderrExcerpt: string;
  convergence: {
    hasNaN: boolean;
    hasFortranError: boolean;
    hasConvergenceFail: boolean;
  };
}

interface AirfoilCoordinateInput {
  text?: string;
  label: string;
  sourceKind: XfoilWasmPolarSummary["sourceKind"];
  sourceUrl?: string;
  sourceArtifactPath?: string;
}

interface Su2Config {
  command?: string;
  caseRoot?: string;
  configFile?: string;
  workingDirectory?: string;
  probeArgs: string[];
  runArgsTemplate: string[];
  timeoutMs: number;
}

interface ScriptedCfdConfig {
  target: Extract<EngineeringProgramTarget, "openvsp" | "xflr5">;
  label: string;
  command?: string;
  scriptPath?: string;
  workingDirectory?: string;
  probeArgs: string[];
  runArgsTemplate: string[];
  timeoutMs: number;
}

interface Su2CaseRunSummary {
  target: "su2";
  command: string;
  args: string[];
  caseRoot: string;
  configPath: string;
  generatedConfigText?: string;
  cfdRunSpec?: CfdRunSpec;
  workingDirectory?: string;
  outputFileName: string;
  outputTextExcerpt?: string;
  exitCode: number | null;
  timedOut: boolean;
  stdoutExcerpt: string;
  stderrExcerpt: string;
}

interface ScriptedCfdRunSummary {
  target: Extract<EngineeringProgramTarget, "openvsp" | "xflr5">;
  label: string;
  command: string;
  launcherCommand: string;
  args: string[];
  adapterMode: "builtin" | "custom";
  scriptPath?: string;
  builtinAdapterPath?: string;
  geometryPath?: string;
  meshPath?: string;
  cfdSpecPath: string;
  cfdRunSpec: CfdRunSpec;
  workingDirectory?: string;
  outputFileName: string;
  outputTextExcerpt?: string;
  exitCode: number | null;
  timedOut: boolean;
  stdoutExcerpt: string;
  stderrExcerpt: string;
}

export class EngineeringProgramTool implements ResearchTool {
  name = "EngineeringProgramTool";

  async run(input: OpenCodeRunInput, settings: AppSettings): Promise<ResearchToolResult> {
    const startedAt = nowIso();
    if (!input.project.autonomyPolicy.allowCodeExecution || !settings.allowCodeExecution) {
      throw new Error("EngineeringProgramTool requires code execution permission from both project autonomy and app settings.");
    }
    if (!settings.engineeringTools.enabled) {
      throw new Error("EngineeringProgramTool is disabled in app settings.");
    }

    const requests = normalizeProgramRequests(input.researchPlan?.programRequests);
    const completedAt = nowIso();
    if (!requests.length) {
      return {
        toolRun: failedToolRun(
          input,
          this.name,
          startedAt,
          completedAt,
          { requestCount: 0 },
          { supportedKinds: supportedEngineeringProgramKinds() },
          "EngineeringProgramTool requires ResearchPlan.programRequests."
        ),
        evidence: [],
        artifacts: [],
        sources: []
      };
    }

    const outputs: unknown[] = [];
    const artifacts: ResearchArtifact[] = [];
    const evidence: EvidenceItem[] = [];
    try {
      for (const request of requests.slice(0, 4)) {
        if (request.kind === "toolchain-check") {
          outputs.push(await runToolchainCheck(request.target ?? "all", settings));
          continue;
        }
        if (request.kind === "mesh-inspect") {
          const summary = inspectMeshArtifact(request, settings);
          outputs.push({ kind: request.kind, target: request.target ?? "modeling", summary });
          artifacts.push(meshSummaryArtifact(input, summary, completedAt));
          continue;
        }
        if (request.kind === "xfoil-polar") {
          const summary = await runXfoilPolar(request, settings);
          outputs.push({ kind: request.kind, target: "xfoil", summary: { ...summary, rows: summary.rows.slice(0, 12) } });
          artifacts.push(xfoilPolarArtifact(input, summary, nowIso()));
          evidence.push(xfoilPolarEvidence(input, summary, nowIso()));
          continue;
        }
        if (request.kind === "xfoil-wasm-polar") {
          const summary = await runXfoilWasmPolar(request, settings, input);
          outputs.push({ kind: request.kind, target: "xfoil-wasm", summary: { ...summary, rows: summary.rows.slice(0, 12) } });
          artifacts.push(xfoilWasmPolarArtifact(input, summary, nowIso()));
          evidence.push(xfoilWasmPolarEvidence(input, summary, nowIso()));
          continue;
        }
        if (request.kind === "su2-case-run") {
          const summary = await runSu2Case(request, settings);
          outputs.push({ kind: request.kind, target: "su2", summary });
          artifacts.push(su2CaseRunArtifact(input, summary, nowIso()));
          evidence.push(su2CaseRunEvidence(input, summary, nowIso()));
          continue;
        }
        if (request.kind === "openvsp-analysis-run") {
          const summary = await runScriptedCfdAnalysis(request, settings, "openvsp");
          outputs.push({ kind: request.kind, target: "openvsp", summary });
          artifacts.push(scriptedCfdRunArtifact(input, summary, nowIso()));
          evidence.push(scriptedCfdRunEvidence(input, summary, nowIso()));
          continue;
        }
        if (request.kind === "xflr5-analysis-run") {
          const summary = await runScriptedCfdAnalysis(request, settings, "xflr5");
          outputs.push({ kind: request.kind, target: "xflr5", summary });
          artifacts.push(scriptedCfdRunArtifact(input, summary, nowIso()));
          evidence.push(scriptedCfdRunEvidence(input, summary, nowIso()));
          continue;
        }
        throw new Error(`Unsupported EngineeringProgramTool request kind: ${request.kind}`);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        toolRun: failedToolRun(input, this.name, startedAt, nowIso(), { requests }, { outputs, failureMessage: message }, message),
        evidence,
        artifacts,
        sources: []
      };
    }

    return {
      toolRun: completedToolRun(input, this.name, startedAt, nowIso(), { requests }, { outputs, artifactCount: artifacts.length }),
      evidence,
      artifacts,
      sources: []
    };
  }
}

export function hasExecutableEngineeringTool(settings: AppSettings): boolean {
  if (!settings.engineeringTools.enabled) return false;
  return (
    hasConfiguredXfoil(settings) ||
    hasConfiguredXfoilWasm(settings) ||
    hasConfiguredModelingRoot(settings) ||
    hasConfiguredSu2(settings) ||
    hasConfiguredOpenVsp(settings) ||
    hasConfiguredXflr5(settings)
  );
}

export function describeEngineeringProgramCapabilities(settings: AppSettings): EngineeringProgramCapability[] {
  const toolsEnabled = settings.engineeringTools.enabled;
  const xfoilReady = toolsEnabled && hasConfiguredXfoil(settings);
  const xfoilWasmReady = toolsEnabled && hasConfiguredXfoilWasm(settings);
  const modelingReady = toolsEnabled && hasConfiguredModelingRoot(settings);
  const su2Ready = toolsEnabled && hasConfiguredSu2(settings);
  const openVspReady = toolsEnabled && hasConfiguredOpenVsp(settings);
  const xflr5Ready = toolsEnabled && hasConfiguredXflr5(settings);
  const capabilities: EngineeringProgramCapability[] = [
    {
      kind: "toolchain-check",
      target: "all",
      ready: toolsEnabled && (xfoilReady || xfoilWasmReady || modelingReady || su2Ready || openVspReady || xflr5Ready),
      requiredFields: ["kind"],
      optionalFields: ["target", "reason"],
      description: "Probe configured XFOIL, SU2, OpenVSP, and XFLR5 targets and report unavailable targets without inventing substitutes.",
      blockedReason: toolsEnabled ? "No engineering target is configured." : "Engineering program tools are disabled."
    },
    {
      kind: "mesh-inspect",
      target: "modeling",
      ready: modelingReady,
      requiredFields: ["kind", "artifactPath"],
      optionalFields: ["reason"],
      description: "Inspect OBJ/STL mesh geometry under the configured modeling artifact root.",
      blockedReason: modelingReady ? undefined : "Modeling artifact root is not configured."
    },
    {
      kind: "xfoil-polar",
      target: "xfoil",
      ready: xfoilReady,
      requiredFields: ["kind", "naca or artifactPath"],
      optionalFields: ["reynolds", "mach", "alphaStart", "alphaEnd", "alphaStep", "reason"],
      description: "Run the embedded XFOIL executable to generate a polar table.",
      blockedReason: xfoilReady ? undefined : "Embedded XFOIL executable is not available under the AetherOps engineering toolchain."
    },
    {
      kind: "xfoil-wasm-polar",
      target: "xfoil-wasm",
      ready: xfoilWasmReady,
      requiredFields: ["kind", "naca or artifactPath or sourceUrl"],
      optionalFields: ["reynolds", "mach", "alphaStart", "alphaEnd", "alphaStep", "reason"],
      description: "Run the bundled WebXFOIL WebAssembly solver to generate a real XFOIL polar without requiring a local xfoil executable.",
      blockedReason: xfoilWasmReady ? undefined : "XFOIL WebAssembly solver is unavailable because engineering program tools are disabled."
    },
    {
      kind: "su2-case-run",
      target: "su2",
      ready: su2Ready,
      requiredFields: ["kind", "target", "cfdRunSpec"],
      optionalFields: ["outputFileName", "reason"],
      description: "Generate a validated SU2 case config from LLM-selected CFD parameters, then run the embedded SU2_CFD-compatible executable.",
      blockedReason: su2Ready ? undefined : "Embedded SU2 executable is not available, or parser-visible case config is not configured."
    },
    {
      kind: "openvsp-analysis-run",
      target: "openvsp",
      ready: openVspReady,
      requiredFields: ["kind", "target", "cfdRunSpec"],
      optionalFields: ["outputFileName", "reason"],
      description: "Run the embedded OpenVSP/VSPAERO command through the built-in runner, or through an explicitly configured custom script.",
      blockedReason: openVspReady ? undefined : "Embedded OpenVSP executable is not available, or the configured custom script contract is invalid."
    },
    {
      kind: "xflr5-analysis-run",
      target: "xflr5",
      ready: xflr5Ready,
      requiredFields: ["kind", "target", "cfdRunSpec"],
      optionalFields: ["outputFileName", "reason"],
      description: "Run the embedded XFLR5 command through the built-in runner, or through an explicitly configured custom script.",
      blockedReason: xflr5Ready ? undefined : "Embedded XFLR5 executable is not available, or the configured custom script contract is invalid."
    }
  ];
  return capabilities.map((capability) => (capability.ready ? { ...capability, blockedReason: undefined } : capability));
}

export async function runEngineeringProgramPreflight(settings: AppSettings, target: EngineeringProgramTarget = "all"): Promise<EngineeringProgramPreflightResult> {
  const startedAt = nowIso();
  const normalizedTarget = normalizeTarget(target) ?? "all";
  if (!settings.allowCodeExecution) {
    return {
      target: normalizedTarget,
      status: "failed",
      error: "Engineering program preflight requires code execution to be enabled in app settings.",
      startedAt,
      completedAt: nowIso()
    };
  }
  if (!settings.engineeringTools.enabled) {
    return {
      target: normalizedTarget,
      status: "failed",
      error: "Engineering program tools are disabled in app settings.",
      startedAt,
      completedAt: nowIso()
    };
  }

  try {
    const output = await runToolchainCheck(normalizedTarget, settings);
    return {
      target: normalizedTarget,
      status: "completed",
      output,
      startedAt,
      completedAt: nowIso()
    };
  } catch (error) {
    return {
      target: normalizedTarget,
      status: "failed",
      error: error instanceof Error ? error.message : String(error),
      startedAt,
      completedAt: nowIso()
    };
  }
}

function normalizeProgramRequests(value: unknown): EngineeringProgramRequest[] {
  if (!Array.isArray(value)) return [];
  const requests: EngineeringProgramRequest[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const request = item as Partial<EngineeringProgramRequest>;
    if (
      request.kind !== "toolchain-check" &&
      request.kind !== "mesh-inspect" &&
      request.kind !== "xfoil-polar" &&
      request.kind !== "xfoil-wasm-polar" &&
      request.kind !== "su2-case-run" &&
      request.kind !== "openvsp-analysis-run" &&
      request.kind !== "xflr5-analysis-run"
    ) continue;
    requests.push({
      kind: request.kind,
      target: normalizeTarget(request.target),
      cfdRunSpec: normalizeCfdRunSpec(request.cfdRunSpec),
      artifactPath: typeof request.artifactPath === "string" ? request.artifactPath : undefined,
      sourceUrl: typeof request.sourceUrl === "string" ? request.sourceUrl : undefined,
      outputFileName: typeof request.outputFileName === "string" ? request.outputFileName : undefined,
      naca: typeof request.naca === "string" ? request.naca : undefined,
      reynolds: finiteNumber(request.reynolds),
      mach: finiteNumber(request.mach),
      alphaStart: finiteNumber(request.alphaStart),
      alphaEnd: finiteNumber(request.alphaEnd),
      alphaStep: finiteNumber(request.alphaStep),
      reason: typeof request.reason === "string" ? request.reason : undefined
    });
  }
  return requests;
}

function supportedEngineeringProgramKinds(): EngineeringProgramRequest["kind"][] {
  return ["toolchain-check", "mesh-inspect", "xfoil-polar", "xfoil-wasm-polar", "su2-case-run", "openvsp-analysis-run", "xflr5-analysis-run"];
}

async function runToolchainCheck(target: EngineeringProgramTarget, settings: AppSettings): Promise<unknown> {
  const wantsXfoil = target === "all" || target === "xfoil";
  const wantsXfoilWasm = target === "all" || target === "xfoil-wasm";
  const wantsModeling = target === "all" || target === "modeling";
  const wantsSu2 = target === "all" || target === "su2";
  const wantsOpenVsp = target === "all" || target === "openvsp";
  const wantsXflr5 = target === "all" || target === "xflr5";
  const checked: string[] = [];
  const unavailable: Array<{ target: string; reason: string }> = [];
  const output: Record<string, unknown> = { kind: "toolchain-check", target, checked, unavailable };

  if (wantsXfoil) {
    if (hasConfiguredXfoil(settings)) {
      checked.push("xfoil");
      output.xfoil = await probeXfoil(resolveXfoilCommand(settings), settings.engineeringTools.xfoil.timeoutMs);
    } else {
      unavailable.push({ target: "xfoil", reason: "Embedded XFOIL executable is not available under the AetherOps engineering toolchain." });
      if (target === "xfoil") throw new Error("Embedded XFOIL executable is not available.");
    }
  }

  if (wantsXfoilWasm) {
    if (hasConfiguredXfoilWasm(settings)) {
      checked.push("xfoil-wasm");
      output.xfoilWasm = {
        runtime: "webxfoil-wasm",
        version: "0.1.1",
        license: "GPL-2.0-or-later",
        bundled: true
      };
    } else {
      unavailable.push({ target: "xfoil-wasm", reason: "XFOIL WebAssembly solver is unavailable because engineering tools are disabled." });
      if (target === "xfoil-wasm") throw new Error("XFOIL WebAssembly solver is unavailable.");
    }
  }

  if (wantsModeling) {
    if (hasConfiguredModelingRoot(settings)) {
      checked.push("modeling");
      const root = resolve(settings.engineeringTools.modeling.artifactRoot as string);
      output.modeling = { artifactRoot: root, exists: existsSync(root), maxMeshBytes: settings.engineeringTools.modeling.maxMeshBytes };
      if (!existsSync(root)) throw new Error(`Configured modeling artifact root does not exist: ${root}`);
    } else {
      unavailable.push({ target: "modeling", reason: "Modeling artifact root is not configured." });
      if (target === "modeling") throw new Error("Modeling artifact root is not configured.");
    }
  }

  if (wantsSu2) {
    if (hasConfiguredSu2(settings)) {
      checked.push("su2");
      const config = su2Config(settings);
      const su2Case = validateSu2CaseConfig(config.caseRoot, config.configFile);
      output.su2 = {
        caseRoot: su2Case.caseRoot,
        configPath: su2Case.configPath,
        probe: await probeSu2(config)
      };
    } else {
      unavailable.push({ target: "su2", reason: "SU2 requires an embedded executable and a case root containing the configured .cfg file." });
      if (target === "su2") throw new Error("Embedded SU2 executable or case config is not configured.");
    }
  }

  if (wantsOpenVsp) {
    if (hasConfiguredOpenVsp(settings)) {
      checked.push("openvsp");
      const config = scriptedCfdConfig(settings, "openvsp");
      const customScriptPath = validateOptionalScriptedCfdScriptPath(config);
      output.openVsp = {
        adapterMode: customScriptPath ? "custom" : "builtin",
        scriptPath: customScriptPath,
        builtinAdapterPath: customScriptPath ? undefined : validateBuiltinScriptedCfdAdapterPath("openvsp"),
        probe: await probeScriptedCfd(config)
      };
    } else {
      unavailable.push({ target: "openvsp", reason: "OpenVSP requires an embedded executable and either the built-in adapter or a valid custom script contract." });
      if (target === "openvsp") throw new Error("Embedded OpenVSP executable or adapter contract is not configured.");
    }
  }

  if (wantsXflr5) {
    if (hasConfiguredXflr5(settings)) {
      checked.push("xflr5");
      const config = scriptedCfdConfig(settings, "xflr5");
      const customScriptPath = validateOptionalScriptedCfdScriptPath(config);
      output.xflr5 = {
        adapterMode: customScriptPath ? "custom" : "builtin",
        scriptPath: customScriptPath,
        builtinAdapterPath: customScriptPath ? undefined : validateBuiltinScriptedCfdAdapterPath("xflr5"),
        probe: await probeScriptedCfd(config)
      };
    } else {
      unavailable.push({ target: "xflr5", reason: "XFLR5 requires an embedded executable and either the built-in adapter or a valid custom script contract." });
      if (target === "xflr5") throw new Error("Embedded XFLR5 executable or adapter contract is not configured.");
    }
  }

  if (!checked.length) {
    throw new Error("No configured headless engineering target is available for EngineeringProgramTool.");
  }
  return output;
}

function inspectMeshArtifact(request: EngineeringProgramRequest, settings: AppSettings): MeshSummary {
  if (!hasConfiguredModelingRoot(settings)) {
    throw new Error("Mesh inspection requires a configured modeling artifact root.");
  }
  if (!request.artifactPath?.trim()) {
    throw new Error("Mesh inspection requires programRequests[].artifactPath.");
  }
  const artifactRoot = resolve(settings.engineeringTools.modeling.artifactRoot as string);
  const targetPath = resolveInsideRoot(artifactRoot, request.artifactPath);
  if (!existsSync(targetPath)) {
    throw new Error(`Mesh artifact does not exist under configured root: ${request.artifactPath}`);
  }
  const stats = statSync(targetPath);
  if (!stats.isFile()) {
    throw new Error(`Mesh artifact is not a file: ${request.artifactPath}`);
  }
  const maxBytes = settings.engineeringTools.modeling.maxMeshBytes;
  if (stats.size > maxBytes) {
    throw new Error(`Mesh artifact exceeds maxMeshBytes (${stats.size} > ${maxBytes}).`);
  }
  const buffer = readFileSync(targetPath);
  const extension = extname(targetPath).toLowerCase();
  if (extension === ".obj") return parseObjMesh(buffer, basename(targetPath));
  if (extension === ".stl") return parseStlMesh(buffer, basename(targetPath));
  throw new Error(`Unsupported mesh format for inspection: ${extension || "unknown"}`);
}

export function inspectConfiguredMeshArtifact(settings: AppSettings, artifactPath: string): MeshSummary {
  return inspectMeshArtifact({ kind: "mesh-inspect", target: "modeling", artifactPath }, settings);
}

async function runXfoilPolar(request: EngineeringProgramRequest, settings: AppSettings): Promise<XfoilPolarSummary> {
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
    const probe = await runCommandWithInput(resolveXfoilCommand(settings), commandInput, settings.engineeringTools.xfoil.timeoutMs);
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

async function runXfoilWasmPolar(request: EngineeringProgramRequest, settings: AppSettings, input: OpenCodeRunInput): Promise<XfoilWasmPolarSummary> {
  if (!hasConfiguredXfoilWasm(settings)) {
    throw new Error("XFOIL WebAssembly polar execution requires engineering program tools to be enabled.");
  }
  const executionRequest = requestWithCfdSpecDefaults(request, "xfoil-wasm", settings);
  const coordinateInput = await resolveWasmAirfoilInput(executionRequest, settings, input);
  const reynolds = boundedPositiveNumber(executionRequest.reynolds, 1_000, 100_000_000, 1_000_000, "reynolds");
  const mach = boundedPositiveNumber(executionRequest.mach, 0, 0.8, 0, "mach");
  const alphaStart = boundedNumber(executionRequest.alphaStart, -30, 30, -4, "alphaStart");
  const alphaEnd = boundedNumber(executionRequest.alphaEnd, -30, 30, 12, "alphaEnd");
  const alphaStep = boundedPositiveNumber(executionRequest.alphaStep, 0.1, 10, 2, "alphaStep");
  if (alphaEnd < alphaStart) {
    throw new Error("XFOIL WebAssembly polar request requires alphaEnd >= alphaStart.");
  }

  const { WebXFOIL } = await import("webxfoil-wasm");
  const xfoil = await WebXFOIL.load();
  try {
    const session = WebXFOIL.input();
    let airfoil = coordinateInput.label;
    let coordinateFormat: string | undefined;
    if (coordinateInput.text) {
      const loaded = session.loadAirfoilText(coordinateInput.text, {
        path: `${safeOutputFileName(coordinateInput.label, "airfoil")}.dat`,
        name: coordinateInput.label
      });
      airfoil = loaded.name || coordinateInput.label;
      coordinateFormat = loaded.format;
    } else {
      const naca = request.naca?.trim();
      if (!naca || !/^\d{4,5}$/.test(naca)) {
        throw new Error("XFOIL WebAssembly NACA request must be a 4 or 5 digit series code.");
      }
      session.naca(naca);
      airfoil = `NACA ${naca}`;
    }

    const polarPath = "xfoil-wasm-polar.txt";
    session
      .add("PANE")
      .oper()
      .add("ITER 160")
      .add(`VISC ${reynolds}`)
      .add(`MACH ${mach}`)
      .add("PACC")
      .add(polarPath)
      .blank()
      .add(`ASEQ ${alphaStart} ${alphaEnd} ${alphaStep}`)
      .add("PACC")
      .blank()
      .quit();

    const result = xfoil.run(session.toString(), { workDir: "/work", files: session.files, scalarKeys: ["CL", "CD", "Cm", "a"] });
    const polarText = String(xfoil.readFile(`/work/${polarPath}`, "utf8"));
    const rows = parseXfoilPolarRows(polarText);
    if (!rows.length) {
      throw new Error(`XFOIL WebAssembly produced no polar rows. stdout=${excerpt(result.raw.stdout)} stderr=${excerpt(result.raw.stderr)}`);
    }
    return {
      airfoil,
      runtime: "webxfoil-wasm",
      runtimeVersion: "0.1.1",
      runtimeLicense: "GPL-2.0-or-later",
      sourceKind: coordinateInput.sourceKind,
      sourceLabel: coordinateInput.label,
      sourceUrl: coordinateInput.sourceUrl,
      sourceArtifactPath: coordinateInput.sourceArtifactPath,
      coordinateFormat,
      reynolds,
      mach,
      alphaStart,
      alphaEnd,
      alphaStep,
      rowCount: rows.length,
      rows,
      stdoutExcerpt: excerpt(result.raw.stdout),
      stderrExcerpt: excerpt(result.raw.stderr),
      convergence: {
        hasNaN: Boolean(result.output.hasNaN),
        hasFortranError: Boolean(result.output.hasFortranError),
        hasConvergenceFail: Boolean(result.output.hasConvergenceFail)
      }
    };
  } finally {
    xfoil.destroy();
  }
}

async function runSu2Case(request: EngineeringProgramRequest, settings: AppSettings): Promise<Su2CaseRunSummary> {
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
  const tempRoot = mkdtempSync(join(tmpdir(), "aetherops-su2-"));
  const outputFileName = safeOutputFileName(request.outputFileName, "su2-run-output.txt");
  const outputPath = join(tempRoot, outputFileName);
  const generatedConfigPath = join(tempRoot, "aetherops-generated-su2.cfg");
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

async function runScriptedCfdAnalysis(
  request: EngineeringProgramRequest,
  settings: AppSettings,
  target: Extract<EngineeringProgramTarget, "openvsp" | "xflr5">
): Promise<ScriptedCfdRunSummary> {
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
  const tempRoot = mkdtempSync(join(tmpdir(), `aetherops-${target}-`));
  const outputFileName = safeOutputFileName(request.outputFileName, `${target}-analysis-output.json`);
  const outputPath = join(tempRoot, outputFileName);
  const cfdSpecPath = join(tempRoot, "aetherops-cfd-run-spec.json");
  writeFileSync(cfdSpecPath, `${JSON.stringify(cfdRunSpec, null, 2)}\n`, "utf8");
  const cwd = normalizeWorkingDirectory(config.workingDirectory);
  const runPlan = createScriptedCfdRunPlan(config, cfdRunSpec, settings, cfdSpecPath, outputPath, cwd);

  try {
    const result = await runCommandWithArgs(runPlan.launcherCommand, runPlan.args, config.timeoutMs, cwd);
    if (result.exitCode !== 0 || result.timedOut) {
      throw new Error(`${config.label} adapter exited unsuccessfully: exitCode=${result.exitCode}, timedOut=${result.timedOut}, stderr=${result.stderrExcerpt}`);
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

function renderSu2Args(
  template: string[],
  values: { caseRoot: string; configPath: string; outputPath: string; workingDirectory?: string }
): string[] {
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

function probeSu2(config: Su2Config): Promise<CommandProbeResult> {
  return runCommandWithArgs(config.command as string, config.probeArgs, Math.min(config.timeoutMs, 60_000), config.workingDirectory);
}

function probeScriptedCfd(config: ScriptedCfdConfig): Promise<CommandProbeResult> {
  return runCommandWithArgs(config.command as string, config.probeArgs, Math.min(config.timeoutMs, 60_000), config.workingDirectory);
}

function validateSu2CaseConfig(caseRoot: string | undefined, configFile: string | undefined): { caseRoot: string; configPath: string } {
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
  const configPath = resolveInsideRoot(resolvedRoot, configuredFile);
  if (!existsSync(configPath) || !statSync(configPath).isFile()) {
    throw new Error(`Configured SU2 case config does not exist under case root: ${configuredFile}`);
  }
  if (extname(configPath).toLowerCase() !== ".cfg") {
    throw new Error(`Configured SU2 case config must be a .cfg file: ${configuredFile}`);
  }
  return { caseRoot: resolvedRoot, configPath };
}

function validateScriptedCfdScriptPath(config: ScriptedCfdConfig): string {
  if (!config.scriptPath?.trim()) {
    throw new Error(`${config.label} script path is not configured.`);
  }
  const resolved = resolve(config.scriptPath);
  if (!existsSync(resolved) || !statSync(resolved).isFile()) {
    throw new Error(`Configured ${config.label} script path does not exist: ${resolved}`);
  }
  return resolved;
}

function validateOptionalScriptedCfdScriptPath(config: ScriptedCfdConfig): string | undefined {
  if (!config.scriptPath?.trim()) return undefined;
  return validateScriptedCfdScriptPath(config);
}

function validateCustomScriptedCfdTemplate(config: ScriptedCfdConfig): void {
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

function validateScriptedCfdAvailability(config: ScriptedCfdConfig): void {
  if (validateOptionalScriptedCfdScriptPath(config)) {
    return;
  }
  validateBuiltinScriptedCfdAdapterPath(config.target);
}

function validateBuiltinScriptedCfdAdapterPath(target: Extract<EngineeringProgramTarget, "openvsp" | "xflr5">): string {
  const fileName = target === "openvsp" ? "openvsp-vspaero-adapter.mjs" : "xflr5-batch-adapter.mjs";
  const adapterPath = resolve("scripts", "engineering", fileName);
  if (!existsSync(adapterPath) || !statSync(adapterPath).isFile()) {
    throw new Error(`Built-in ${target} CFD adapter is missing: ${adapterPath}`);
  }
  return adapterPath;
}

function resolveCfdGeometryArtifactPath(spec: CfdRunSpec, settings: AppSettings): string | undefined {
  if (spec.geometry.source !== "artifact" || !spec.geometry.artifactPath) return undefined;
  if (!hasConfiguredModelingRoot(settings)) throw new Error("cfdRunSpec artifact geometry requires a configured modeling artifact root.");
  const artifactRoot = resolve(settings.engineeringTools.modeling.artifactRoot as string);
  return resolveInsideRoot(artifactRoot, spec.geometry.artifactPath);
}

function resolveCfdMeshArtifactPath(spec: CfdRunSpec, settings: AppSettings): string | undefined {
  if (!spec.mesh?.artifactPath) return undefined;
  if (!hasConfiguredModelingRoot(settings)) throw new Error("cfdRunSpec mesh artifact requires a configured modeling artifact root.");
  const artifactRoot = resolve(settings.engineeringTools.modeling.artifactRoot as string);
  return resolveInsideRoot(artifactRoot, spec.mesh.artifactPath);
}

function normalizeCfdRunSpec(value: unknown): CfdRunSpec | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Partial<CfdRunSpec>;
  const target = normalizeCfdTarget(record.target);
  const geometryRecord = record.geometry && typeof record.geometry === "object" ? record.geometry : undefined;
  const flightRecord = record.flightCondition && typeof record.flightCondition === "object" ? record.flightCondition : {};
  const solverRecord = record.solver && typeof record.solver === "object" ? record.solver : undefined;
  if (!target || !geometryRecord || !solverRecord) return undefined;
  const geometrySource = geometryRecord.source === "artifact" || geometryRecord.source === "sourceUrl" || geometryRecord.source === "naca" || geometryRecord.source === "configuredCase"
    ? geometryRecord.source
    : undefined;
  const solverName = normalizeSolverName(solverRecord.name);
  if (!geometrySource || !solverName) return undefined;
  const spec: CfdRunSpec = {
    target,
    geometry: {
      source: geometrySource,
      artifactPath: stringValue(geometryRecord.artifactPath),
      sourceUrl: stringValue(geometryRecord.sourceUrl),
      naca: stringValue(geometryRecord.naca),
      description: stringValue(geometryRecord.description)
    },
    flightCondition: {
      reynolds: finiteNumber((flightRecord as CfdRunSpec["flightCondition"]).reynolds),
      mach: finiteNumber((flightRecord as CfdRunSpec["flightCondition"]).mach),
      alphaStart: finiteNumber((flightRecord as CfdRunSpec["flightCondition"]).alphaStart),
      alphaEnd: finiteNumber((flightRecord as CfdRunSpec["flightCondition"]).alphaEnd),
      alphaStep: finiteNumber((flightRecord as CfdRunSpec["flightCondition"]).alphaStep),
      velocity: finiteNumber((flightRecord as CfdRunSpec["flightCondition"]).velocity),
      density: finiteNumber((flightRecord as CfdRunSpec["flightCondition"]).density),
      viscosity: finiteNumber((flightRecord as CfdRunSpec["flightCondition"]).viscosity)
    },
    solver: {
      name: solverName,
      model: normalizeSolverModel(solverRecord.model),
      turbulenceModel: normalizeTurbulenceModel(solverRecord.turbulenceModel),
      maxIterations: finiteNumber(solverRecord.maxIterations),
      convergenceTolerance: finiteNumber(solverRecord.convergenceTolerance),
      configOverrides: normalizeConfigOverrides(solverRecord.configOverrides)
    },
    rationale: stringValue(record.rationale)
  };
  if (record.mesh && typeof record.mesh === "object") {
    const mesh = record.mesh;
    const strategy = mesh.strategy === "existing" || mesh.strategy === "toolGenerated" || mesh.strategy === "caseGenerated" ? mesh.strategy : "caseGenerated";
    spec.mesh = {
      strategy,
      artifactPath: stringValue(mesh.artifactPath),
      maxCells: finiteNumber(mesh.maxCells),
      boundaryLayer: typeof mesh.boundaryLayer === "boolean" ? mesh.boundaryLayer : undefined,
      yPlusTarget: finiteNumber(mesh.yPlusTarget),
      notes: stringValue(mesh.notes)
    };
  }
  if (record.output && typeof record.output === "object") {
    const output = record.output;
    spec.output = {
      forceCoefficients: typeof output.forceCoefficients === "boolean" ? output.forceCoefficients : undefined,
      polar: typeof output.polar === "boolean" ? output.polar : undefined,
      pressureField: typeof output.pressureField === "boolean" ? output.pressureField : undefined,
      mesh: typeof output.mesh === "boolean" ? output.mesh : undefined
    };
  }
  return spec;
}

function validateCfdRunSpecForTarget(
  value: CfdRunSpec | undefined,
  target: Extract<EngineeringProgramTarget, "xfoil" | "xfoil-wasm" | "su2" | "openvsp" | "xflr5">,
  settings: AppSettings
): CfdRunSpec {
  if (!value) {
    throw new Error(`${target} CFD execution requires cfdRunSpec; AetherOps will not invent case, mesh, or solver parameters.`);
  }
  const spec = normalizeCfdRunSpec(value);
  if (!spec || spec.target !== target) {
    throw new Error(`${target} CFD execution requires cfdRunSpec.target=${target}.`);
  }
  if (!solverAllowedForTarget(spec.solver.name, target)) {
    throw new Error(`${target} CFD execution received incompatible solver ${spec.solver.name}.`);
  }
  const flight = spec.flightCondition;
  const alphaStart = boundedNumber(flight.alphaStart, -30, 30, -4, "cfdRunSpec.flightCondition.alphaStart");
  const alphaEnd = boundedNumber(flight.alphaEnd, -30, 30, 12, "cfdRunSpec.flightCondition.alphaEnd");
  const alphaStep = boundedPositiveNumber(flight.alphaStep, 0.1, 10, 2, "cfdRunSpec.flightCondition.alphaStep");
  if (alphaEnd < alphaStart) throw new Error("cfdRunSpec.flightCondition requires alphaEnd >= alphaStart.");
  const normalized: CfdRunSpec = {
    ...spec,
    flightCondition: {
      ...flight,
      reynolds: boundedPositiveNumber(flight.reynolds, 1_000, 100_000_000, 1_000_000, "cfdRunSpec.flightCondition.reynolds"),
      mach: boundedNumber(flight.mach, 0, 0.8, 0, "cfdRunSpec.flightCondition.mach"),
      alphaStart,
      alphaEnd,
      alphaStep
    },
    solver: {
      ...spec.solver,
      maxIterations: spec.solver.maxIterations === undefined ? undefined : boundedPositiveNumber(spec.solver.maxIterations, 1, 1_000_000, 1_000, "cfdRunSpec.solver.maxIterations"),
      convergenceTolerance:
        spec.solver.convergenceTolerance === undefined
          ? undefined
          : boundedPositiveNumber(spec.solver.convergenceTolerance, 1e-12, 1, 1e-6, "cfdRunSpec.solver.convergenceTolerance")
    }
  };
  validateCfdGeometry(normalized, target, settings);
  validateCfdMesh(normalized, settings);
  return normalized;
}

function requestWithCfdSpecDefaults(
  request: EngineeringProgramRequest,
  target: Extract<EngineeringProgramTarget, "xfoil" | "xfoil-wasm">,
  settings: AppSettings
): EngineeringProgramRequest {
  if (!request.cfdRunSpec) return request;
  const spec = validateCfdRunSpecForTarget(request.cfdRunSpec, target, settings);
  const next: EngineeringProgramRequest = {
    ...request,
    cfdRunSpec: spec,
    reynolds: request.reynolds ?? spec.flightCondition.reynolds,
    mach: request.mach ?? spec.flightCondition.mach,
    alphaStart: request.alphaStart ?? spec.flightCondition.alphaStart,
    alphaEnd: request.alphaEnd ?? spec.flightCondition.alphaEnd,
    alphaStep: request.alphaStep ?? spec.flightCondition.alphaStep
  };
  if (spec.geometry.source === "artifact") next.artifactPath = spec.geometry.artifactPath;
  if (spec.geometry.source === "sourceUrl") next.sourceUrl = spec.geometry.sourceUrl;
  if (spec.geometry.source === "naca") next.naca = spec.geometry.naca;
  return next;
}

function renderSu2Config(baseConfig: string, spec: CfdRunSpec): string {
  const entries = new Map<string, string>();
  for (const line of baseConfig.split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (match) entries.set(match[1].toUpperCase(), match[2]);
  }
  const solver = spec.solver.model === "rans" ? "RANS" : spec.solver.model === "euler" || spec.solver.model === "inviscid" ? "EULER" : String(entries.get("SOLVER") ?? "EULER");
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
  return `${Array.from(entries.entries()).map(([key, value]) => `${key}= ${value}`).join("\n")}\n`;
}

function validateCfdGeometry(
  spec: CfdRunSpec,
  target: Extract<EngineeringProgramTarget, "xfoil" | "xfoil-wasm" | "su2" | "openvsp" | "xflr5">,
  settings: AppSettings
): void {
  const geometry = spec.geometry;
  if (geometry.source === "naca") {
    if (!geometry.naca || !/^\d{4,5}$/.test(geometry.naca)) throw new Error("cfdRunSpec.geometry.naca must be a 4 or 5 digit NACA code.");
    if (target !== "xfoil" && target !== "xfoil-wasm" && target !== "xflr5") {
      throw new Error(`${target} CFD execution cannot use NACA-only geometry without a configured case or artifact.`);
    }
    return;
  }
  if (geometry.source === "sourceUrl") {
    if (target !== "xfoil-wasm") throw new Error(`${target} CFD execution cannot fetch geometry directly from sourceUrl.`);
    if (!geometry.sourceUrl) throw new Error("cfdRunSpec.geometry.sourceUrl is required.");
    assertPublicCoordinateUrl(geometry.sourceUrl);
    return;
  }
  if (geometry.source === "artifact") {
    if (!geometry.artifactPath) throw new Error("cfdRunSpec.geometry.artifactPath is required.");
    if (!hasConfiguredModelingRoot(settings)) throw new Error("cfdRunSpec artifact geometry requires a configured modeling artifact root.");
    const artifactRoot = resolve(settings.engineeringTools.modeling.artifactRoot as string);
    const targetPath = resolveInsideRoot(artifactRoot, geometry.artifactPath);
    if (!existsSync(targetPath) || !statSync(targetPath).isFile()) throw new Error(`CFD geometry artifact does not exist under configured root: ${geometry.artifactPath}`);
    if (statSync(targetPath).size > settings.engineeringTools.modeling.maxMeshBytes) throw new Error(`CFD geometry artifact exceeds maxMeshBytes: ${geometry.artifactPath}`);
    const extension = extname(targetPath).toLowerCase();
    if ((target === "xfoil" || target === "xfoil-wasm") && extension !== ".dat" && extension !== ".txt") {
      throw new Error(`${target} geometry artifact must be an airfoil coordinate .dat or .txt file.`);
    }
    if ((target === "openvsp" || target === "xflr5") && extension !== ".vsp3" && extension !== ".obj" && extension !== ".stl" && extension !== ".dat" && extension !== ".txt") {
      throw new Error(`${target} geometry artifact must be a prepared .vsp3, OBJ/STL mesh, or airfoil coordinate file.`);
    }
    return;
  }
  if (geometry.source === "configuredCase") {
    if (target !== "su2" && target !== "openvsp" && target !== "xflr5") throw new Error(`${target} does not support configuredCase geometry.`);
    return;
  }
}

function validateCfdMesh(spec: CfdRunSpec, settings: AppSettings): void {
  if (!spec.mesh?.artifactPath) return;
  if (!hasConfiguredModelingRoot(settings)) throw new Error("cfdRunSpec.mesh.artifactPath requires a configured modeling artifact root.");
  const artifactRoot = resolve(settings.engineeringTools.modeling.artifactRoot as string);
  const targetPath = resolveInsideRoot(artifactRoot, spec.mesh.artifactPath);
  if (!existsSync(targetPath) || !statSync(targetPath).isFile()) throw new Error(`CFD mesh artifact does not exist under configured root: ${spec.mesh.artifactPath}`);
  if (statSync(targetPath).size > settings.engineeringTools.modeling.maxMeshBytes) throw new Error(`CFD mesh artifact exceeds maxMeshBytes: ${spec.mesh.artifactPath}`);
  const extension = extname(targetPath).toLowerCase();
  if (extension !== ".obj" && extension !== ".stl" && extension !== ".su2") {
    throw new Error("cfdRunSpec.mesh.artifactPath must point to OBJ, STL, or SU2 mesh data.");
  }
}

function solverAllowedForTarget(solver: CfdRunSpec["solver"]["name"], target: CfdRunSpec["target"]): boolean {
  if (target === "xfoil") return solver === "xfoil";
  if (target === "xfoil-wasm") return solver === "webxfoil-wasm";
  if (target === "su2") return solver === "su2";
  if (target === "openvsp") return solver === "openvsp-vspaero";
  if (target === "xflr5") return solver === "xflr5";
  return false;
}

function normalizeCfdTarget(value: unknown): CfdRunSpec["target"] | undefined {
  if (value === "xfoil" || value === "xfoil-wasm" || value === "su2" || value === "openvsp" || value === "xflr5") return value;
  return undefined;
}

function normalizeSolverName(value: unknown): CfdRunSpec["solver"]["name"] | undefined {
  if (value === "xfoil" || value === "webxfoil-wasm" || value === "su2" || value === "openvsp-vspaero" || value === "xflr5") return value;
  return undefined;
}

function normalizeSolverModel(value: unknown): CfdRunSpec["solver"]["model"] | undefined {
  if (value === "inviscid" || value === "euler" || value === "rans" || value === "panel" || value === "viscous-panel") return value;
  return undefined;
}

function normalizeTurbulenceModel(value: unknown): CfdRunSpec["solver"]["turbulenceModel"] | undefined {
  if (value === "sa" || value === "sst" || value === "kepsilon" || value === "none") return value;
  return undefined;
}

function normalizeConfigOverrides(value: unknown): Record<string, string | number | boolean> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const output: Record<string, string | number | boolean> = {};
  for (const [key, rawValue] of Object.entries(value).slice(0, 24)) {
    if (!/^[A-Za-z0-9_]{2,80}$/.test(key)) continue;
    if (typeof rawValue === "string" || typeof rawValue === "number" || typeof rawValue === "boolean") output[key] = rawValue;
  }
  return Object.keys(output).length ? output : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function formatConfigNumber(value: number): string {
  if (!Number.isFinite(value)) throw new Error("Cannot render non-finite CFD config number.");
  return Number(value.toPrecision(12)).toString();
}

function xfoilAirfoilInput(request: EngineeringProgramRequest, settings: AppSettings): { command: string; label: string } {
  const naca = request.naca?.trim();
  if (naca) {
    if (!/^\d{4,5}$/.test(naca)) {
      throw new Error("XFOIL NACA request must be a 4 or 5 digit series code.");
    }
    return { command: `NACA ${naca}`, label: `NACA ${naca}` };
  }
  if (!request.artifactPath?.trim()) {
    throw new Error("XFOIL polar execution requires either naca or artifactPath.");
  }
  if (!hasConfiguredModelingRoot(settings)) {
    throw new Error("XFOIL coordinate-file execution requires a configured modeling artifact root.");
  }
  const artifactRoot = resolve(settings.engineeringTools.modeling.artifactRoot as string);
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

async function resolveWasmAirfoilInput(request: EngineeringProgramRequest, settings: AppSettings, input: OpenCodeRunInput): Promise<AirfoilCoordinateInput> {
  if (request.artifactPath?.trim()) {
    if (!hasConfiguredModelingRoot(settings)) {
      throw new Error("XFOIL WebAssembly coordinate-file execution requires a configured modeling artifact root.");
    }
    const artifactRoot = resolve(settings.engineeringTools.modeling.artifactRoot as string);
    const targetPath = resolveInsideRoot(artifactRoot, request.artifactPath.trim());
    if (!existsSync(targetPath) || !statSync(targetPath).isFile()) {
      throw new Error(`XFOIL WebAssembly airfoil coordinate file does not exist under configured root: ${request.artifactPath}`);
    }
    const stats = statSync(targetPath);
    if (stats.size > settings.engineeringTools.modeling.maxMeshBytes) {
      throw new Error(`XFOIL WebAssembly airfoil coordinate file exceeds maxMeshBytes (${stats.size} > ${settings.engineeringTools.modeling.maxMeshBytes}).`);
    }
    const text = readFileSync(targetPath, "utf8");
    validateAirfoilCoordinateText(text);
    return {
      text,
      label: basename(targetPath, extname(targetPath)),
      sourceKind: "artifact",
      sourceArtifactPath: request.artifactPath.trim()
    };
  }

  const sourceUrl = request.sourceUrl?.trim();
  if (sourceUrl) {
    const fetchedSource = findFetchedAirfoilSource(input, sourceUrl);
    if (fetchedSource) return fetchedSource;
    if (!input.project.autonomyPolicy.allowExternalSearch || !settings.allowExternalSearch) {
      throw new Error("XFOIL WebAssembly sourceUrl execution requires WebFetchTool-provided rawText or external search permission for direct coordinate fetch.");
    }
    const text = await fetchAirfoilCoordinateText(sourceUrl, settings.engineeringTools.xfoil.timeoutMs);
    validateAirfoilCoordinateText(text);
    return {
      text,
      label: airfoilLabelFromUrl(sourceUrl),
      sourceKind: "direct-url",
      sourceUrl
    };
  }

  const discoveredSource = findFetchedAirfoilSource(input);
  if (discoveredSource) return discoveredSource;

  const naca = request.naca?.trim();
  if (naca) {
    if (!/^\d{4,5}$/.test(naca)) {
      throw new Error("XFOIL WebAssembly NACA request must be a 4 or 5 digit series code.");
    }
    return {
      label: `NACA ${naca}`,
      sourceKind: "naca"
    };
  }

  throw new Error("XFOIL WebAssembly polar execution requires naca, artifactPath, sourceUrl, or a fetched airfoil coordinate source.");
}

function findFetchedAirfoilSource(input: OpenCodeRunInput, sourceUrl?: string): AirfoilCoordinateInput | undefined {
  const requestedUrl = sourceUrl ? normalizeUrlForCompare(sourceUrl) : undefined;
  let invalidRequestedSource: string | undefined;
  const sources = input.sources ?? [];
  for (let index = sources.length - 1; index >= 0; index -= 1) {
    const source = sources[index];
    if (!source) continue;
    const url = typeof source.url === "string" ? source.url : "";
    if (requestedUrl && normalizeUrlForCompare(url) !== requestedUrl) continue;
    const rawText = source.metadata && typeof source.metadata.rawText === "string" ? source.metadata.rawText : "";
    if (!rawText) continue;
    try {
      validateAirfoilCoordinateText(rawText);
      return {
        text: rawText,
        label: source.title || airfoilLabelFromUrl(url),
        sourceKind: "source",
        sourceUrl: url
      };
    } catch (error) {
      if (requestedUrl) invalidRequestedSource = error instanceof Error ? error.message : String(error);
    }
  }
  if (requestedUrl && invalidRequestedSource) {
    throw new Error(`Fetched source does not contain a valid airfoil coordinate file: ${sourceUrl} (${invalidRequestedSource})`);
  }
  return undefined;
}

export function validateAirfoilCoordinateText(text: string): { pointCount: number; xMin: number; xMax: number; yMin: number; yMax: number } {
  const points: Array<{ x: number; y: number }> = [];
  for (const line of text.split(/\r?\n/)) {
    const parts = line.trim().split(/[\s,]+/);
    if (parts.length < 2) continue;
    const x = Number(parts[0]);
    const y = Number(parts[1]);
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    if (Math.abs(x) > 2 || Math.abs(y) > 2) continue;
    points.push({ x, y });
  }
  if (points.length < 10) {
    throw new Error(`Airfoil coordinate file must contain at least 10 finite coordinate pairs; found ${points.length}.`);
  }
  const xValues = points.map((point) => point.x);
  const yValues = points.map((point) => point.y);
  const xMin = Math.min(...xValues);
  const xMax = Math.max(...xValues);
  const yMin = Math.min(...yValues);
  const yMax = Math.max(...yValues);
  if (xMax - xMin < 0.01) {
    throw new Error("Airfoil coordinate file does not span a usable chord length.");
  }
  if (yMax - yMin <= 0) {
    throw new Error("Airfoil coordinate file does not contain a usable thickness/camber range.");
  }
  return { pointCount: points.length, xMin, xMax, yMin, yMax };
}

async function fetchAirfoilCoordinateText(sourceUrl: string, timeoutMs: number): Promise<string> {
  assertPublicCoordinateUrl(sourceUrl);
  const effectiveTimeoutMs = clampAirfoilFetchTimeout(timeoutMs);
  const controller = new AbortController();
  let didTimeout = false;
  const timeout = setTimeout(() => {
    didTimeout = true;
    controller.abort();
  }, effectiveTimeoutMs);
  try {
    const response = await fetch(sourceUrl, { headers: { accept: "text/plain,text/*,*/*" }, signal: controller.signal });
    assertPublicCoordinateUrl(response.url || sourceUrl);
    if (!response.ok) {
      throw new Error(`airfoil coordinate fetch failed for ${sourceUrl}: ${response.status} ${response.statusText}`);
    }
    const contentLength = Number(response.headers.get("content-length") ?? "0");
    if (Number.isFinite(contentLength) && contentLength > 2 * 1024 * 1024) {
      throw new Error(`airfoil coordinate content-length exceeds 2MB for ${sourceUrl}`);
    }
    const text = await response.text();
    if (text.length > 2 * 1024 * 1024) {
      throw new Error(`airfoil coordinate response exceeds 2MB for ${sourceUrl}`);
    }
    return text;
  } catch (error) {
    if (didTimeout || isAbortError(error)) {
      throw new Error(`airfoil coordinate fetch timed out after ${effectiveTimeoutMs}ms for ${sourceUrl}`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function clampAirfoilFetchTimeout(timeoutMs: number): number {
  if (!Number.isFinite(timeoutMs)) return 30_000;
  return Math.min(120_000, Math.max(10_000, Math.trunc(timeoutMs)));
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && (error.name === "AbortError" || /aborted/i.test(error.message));
}

function assertPublicCoordinateUrl(rawUrl: string): void {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error(`Invalid airfoil coordinate URL: ${rawUrl}`);
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error(`Unsupported airfoil coordinate URL protocol: ${parsed.protocol}`);
  }
  const hostname = parsed.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (!hostname || hostname === "localhost" || hostname.endsWith(".localhost") || hostname.endsWith(".local")) {
    throw new Error(`blocked internal airfoil coordinate hostname: ${parsed.hostname}`);
  }
  if (isPrivateIpv4(hostname) || hostname === "::1" || hostname.startsWith("fc") || hostname.startsWith("fd") || hostname.startsWith("fe80")) {
    throw new Error(`blocked internal airfoil coordinate IP address: ${parsed.hostname}`);
  }
}

function isPrivateIpv4(hostname: string): boolean {
  const parts = hostname.split(".").map((part) => Number(part));
  if (parts.length !== 4 || !parts.every((part) => Number.isInteger(part) && part >= 0 && part <= 255)) return false;
  const [a, b] = parts as [number, number, number, number];
  return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254) || a === 0;
}

function normalizeUrlForCompare(rawUrl: string): string {
  try {
    const parsed = new URL(rawUrl);
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return rawUrl.trim();
  }
}

function airfoilLabelFromUrl(rawUrl: string): string {
  try {
    const parsed = new URL(rawUrl);
    const file = basename(parsed.pathname) || parsed.hostname;
    return file.replace(/\.[A-Za-z0-9]+$/, "") || "airfoil";
  } catch {
    return "airfoil";
  }
}

function parseXfoilPolarRows(text: string): XfoilPolarRow[] {
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

function unitIntervalNumber(value: number | undefined): number | undefined {
  return value !== undefined && Number.isFinite(value) && value >= 0 && value <= 1 ? value : undefined;
}

function resolveInsideRoot(root: string, artifactPath: string): string {
  const candidate = isAbsolute(artifactPath) ? resolve(artifactPath) : resolve(root, artifactPath);
  const rel = relative(root, candidate);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error("Configured path escapes the allowed root.");
  }
  return candidate;
}

function parseObjMesh(buffer: Buffer, fileName: string): MeshSummary {
  const bounds = createBounds();
  let vertexCount = 0;
  let faceCount = 0;
  let triangleCount = 0;
  for (const line of buffer.toString("utf8").split(/\r?\n/)) {
    const parts = line.trim().split(/\s+/);
    if (parts[0] === "v" && parts.length >= 4) {
      const point = toPoint(parts[1], parts[2], parts[3]);
      if (point) {
        vertexCount += 1;
        updateBounds(bounds, point);
      }
      continue;
    }
    if (parts[0] === "f" && parts.length >= 4) {
      const vertices = parts.length - 1;
      faceCount += 1;
      triangleCount += Math.max(1, vertices - 2);
    }
  }
  if (!vertexCount) throw new Error("OBJ mesh contains no finite vertices.");
  return {
    fileName,
    format: "obj",
    byteLength: buffer.byteLength,
    vertexCount,
    faceCount,
    triangleCount,
    boundingBox: finalizeBounds(bounds)
  };
}

function parseStlMesh(buffer: Buffer, fileName: string): MeshSummary {
  const textStart = buffer.subarray(0, Math.min(buffer.byteLength, 1024)).toString("utf8");
  if (/^\s*solid\b/i.test(textStart) && /\bfacet\s+normal\b/i.test(buffer.toString("utf8", 0, Math.min(buffer.byteLength, 8192)))) {
    return parseAsciiStl(buffer, fileName);
  }
  return parseBinaryStl(buffer, fileName);
}

function parseAsciiStl(buffer: Buffer, fileName: string): MeshSummary {
  const bounds = createBounds();
  let vertexCount = 0;
  for (const line of buffer.toString("utf8").split(/\r?\n/)) {
    const match = line.trim().match(/^vertex\s+([+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)\s+([+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)\s+([+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)/i);
    if (!match) continue;
    const point = toPoint(match[1], match[2], match[3]);
    if (!point) continue;
    vertexCount += 1;
    updateBounds(bounds, point);
  }
  if (!vertexCount || vertexCount % 3 !== 0) throw new Error("ASCII STL mesh has no complete finite triangles.");
  const triangleCount = vertexCount / 3;
  return {
    fileName,
    format: "stl-ascii",
    byteLength: buffer.byteLength,
    vertexCount,
    faceCount: triangleCount,
    triangleCount,
    boundingBox: finalizeBounds(bounds)
  };
}

function parseBinaryStl(buffer: Buffer, fileName: string): MeshSummary {
  if (buffer.byteLength < 84) throw new Error("Binary STL is too small to contain a header and triangle count.");
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  const triangleCount = view.getUint32(80, true);
  const expectedBytes = 84 + triangleCount * 50;
  if (expectedBytes > buffer.byteLength) {
    throw new Error(`Binary STL triangle table is truncated (${buffer.byteLength} < ${expectedBytes}).`);
  }
  const bounds = createBounds();
  let vertexCount = 0;
  for (let triangle = 0; triangle < triangleCount; triangle += 1) {
    const base = 84 + triangle * 50 + 12;
    for (let vertex = 0; vertex < 3; vertex += 1) {
      const offset = base + vertex * 12;
      const point: [number, number, number] = [
        view.getFloat32(offset, true),
        view.getFloat32(offset + 4, true),
        view.getFloat32(offset + 8, true)
      ];
      if (!point.every(Number.isFinite)) throw new Error("Binary STL contains non-finite vertex coordinates.");
      vertexCount += 1;
      updateBounds(bounds, point);
    }
  }
  if (!vertexCount) throw new Error("Binary STL contains no triangles.");
  return {
    fileName,
    format: "stl-binary",
    byteLength: buffer.byteLength,
    vertexCount,
    faceCount: triangleCount,
    triangleCount,
    boundingBox: finalizeBounds(bounds)
  };
}

function probeXfoil(command: string, timeoutMs: number): Promise<CommandProbeResult> {
  return runCommandWithInput(command, "quit\n", timeoutMs);
}

function runCommandWithInput(command: string, inputText: string, timeoutMs: number): Promise<CommandProbeResult> {
  return new Promise((resolveProbe, rejectProbe) => {
    const child = spawn(command, [], { shell: false, windowsHide: true });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timeout = setTimeout(() => {
      settled = true;
      child.kill();
      resolveProbe({ command, exitCode: null, timedOut: true, stdoutExcerpt: excerpt(stdout), stderrExcerpt: excerpt(stderr) });
    }, timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      rejectProbe(error);
    });
    child.on("close", (exitCode) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolveProbe({ command, exitCode, timedOut: false, stdoutExcerpt: excerpt(stdout), stderrExcerpt: excerpt(stderr) });
    });
    child.stdin.end(inputText);
  });
}

function runCommandWithArgs(command: string, args: string[], timeoutMs: number, workingDirectory?: string): Promise<CommandProbeResult> {
  return new Promise((resolveProbe, rejectProbe) => {
    const cwd = normalizeWorkingDirectory(workingDirectory);
    const child = spawn(command, args, { shell: false, windowsHide: true, cwd });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timeout = setTimeout(() => {
      settled = true;
      child.kill();
      resolveProbe({ command, exitCode: null, timedOut: true, stdoutExcerpt: excerpt(stdout), stderrExcerpt: excerpt(stderr) });
    }, timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      rejectProbe(error);
    });
    child.on("close", (exitCode) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolveProbe({ command, exitCode, timedOut: false, stdoutExcerpt: excerpt(stdout), stderrExcerpt: excerpt(stderr) });
    });
  });
}

function normalizeWorkingDirectory(workingDirectory: string | undefined): string | undefined {
  if (!workingDirectory?.trim()) return undefined;
  const resolved = resolve(workingDirectory);
  if (!existsSync(resolved) || !statSync(resolved).isDirectory()) {
    throw new Error(`Configured adapter working directory does not exist: ${resolved}`);
  }
  return resolved;
}

function safeOutputFileName(value: string | undefined, defaultValue: string): string {
  const candidate = (value?.trim() || defaultValue).replace(/[^A-Za-z0-9._-]+/g, "-");
  if (!candidate || candidate === "." || candidate === "..") return defaultValue;
  return basename(candidate);
}

function meshSummaryArtifact(input: OpenCodeRunInput, summary: MeshSummary, createdAt: string): ResearchArtifact {
  const safeName = summary.fileName.replace(/[^A-Za-z0-9._-]+/g, "-");
  return {
    id: createId("artifact"),
    projectId: input.project.id,
    category: "generated_artifact",
    title: `Mesh inspection: ${summary.fileName}`,
    relativePath: `artifacts/iteration-${input.iteration}/engineering-program/mesh-inspection-${safeName}.json`,
    mimeType: "application/json",
    summary: `Mesh ${summary.fileName}: ${summary.vertexCount} vertices, ${summary.triangleCount} triangles.`,
    content: `${JSON.stringify(summary, null, 2)}\n`,
    metadata: {
      traceabilityKind: "tool_observation",
      generatedBy: "EngineeringProgramTool",
      canSupportHypothesis: false
    },
    createdAt
  };
}

function xfoilPolarArtifact(input: OpenCodeRunInput, summary: XfoilPolarSummary, createdAt: string): ResearchArtifact {
  const safeName = summary.airfoil.replace(/[^A-Za-z0-9._-]+/g, "-");
  return {
    id: createId("artifact"),
    projectId: input.project.id,
    category: "experiment_log",
    title: `XFOIL polar: ${summary.airfoil}`,
    relativePath: `artifacts/iteration-${input.iteration}/engineering-program/xfoil-polar-${safeName}.json`,
    mimeType: "application/json",
    summary: `XFOIL polar for ${summary.airfoil}: ${summary.rowCount} alpha rows at Re=${summary.reynolds}, Mach=${summary.mach}.`,
    content: `${JSON.stringify(summary, null, 2)}\n`,
    metadata: {
      traceabilityKind: "tool_observation",
      generatedBy: "EngineeringProgramTool",
      program: "xfoil",
      canSupportHypothesis: true
    },
    createdAt
  };
}

function xfoilPolarEvidence(input: OpenCodeRunInput, summary: XfoilPolarSummary, createdAt: string): EvidenceItem {
  const previewRows = summary.rows.slice(0, 6).map((row) => `alpha=${row.alpha}, CL=${row.cl}, CD=${row.cd}`);
  return {
    id: createId("evidence"),
    projectId: input.project.id,
    category: "experiment_log",
    title: `XFOIL polar observation: ${summary.airfoil}`,
    summary: `Computed ${summary.rowCount} XFOIL polar rows for ${summary.airfoil}. ${previewRows.join("; ")}`,
    quote: previewRows.join("\n"),
    keywords: ["xfoil", "polar", "cfd", "aerodynamics", "tool_observation"],
    linkedHypothesisIds: input.hypotheses.map((hypothesis) => hypothesis.id),
    reliabilityScore: 0.72,
    relevanceScore: 0.74,
    evidenceStrength: "medium",
    limitations: [
      "XFOIL is a low-order aerodynamic solver; check convergence, Reynolds/Mach assumptions, and airfoil geometry before using results for final decisions.",
      "AetherOps records the generated polar rows but does not replace engineering review."
    ],
    metadata: {
      traceabilityKind: "tool_observation",
      generatedBy: "EngineeringProgramTool",
      program: "xfoil",
      airfoil: summary.airfoil,
      reynolds: summary.reynolds,
      mach: summary.mach,
      rowCount: summary.rowCount,
      canSupportHypothesis: true,
      sourceQualityTier: "tool_observation"
    },
    createdAt
  };
}

function xfoilWasmPolarArtifact(input: OpenCodeRunInput, summary: XfoilWasmPolarSummary, createdAt: string): ResearchArtifact {
  const safeName = summary.airfoil.replace(/[^A-Za-z0-9._-]+/g, "-");
  return {
    id: createId("artifact"),
    projectId: input.project.id,
    category: "experiment_log",
    title: `XFOIL-WASM polar: ${summary.airfoil}`,
    relativePath: `artifacts/iteration-${input.iteration}/engineering-program/xfoil-wasm-polar-${safeName}.json`,
    mimeType: "application/json",
    summary: `WebXFOIL polar for ${summary.airfoil}: ${summary.rowCount} alpha rows at Re=${summary.reynolds}, Mach=${summary.mach}.`,
    content: `${JSON.stringify(summary, null, 2)}\n`,
    metadata: {
      traceabilityKind: "tool_observation",
      generatedBy: "EngineeringProgramTool",
      program: "xfoil-wasm",
      runtimeLicense: summary.runtimeLicense,
      canSupportHypothesis: true
    },
    createdAt
  };
}

function xfoilWasmPolarEvidence(input: OpenCodeRunInput, summary: XfoilWasmPolarSummary, createdAt: string): EvidenceItem {
  const previewRows = summary.rows.slice(0, 6).map((row) => `alpha=${row.alpha}, CL=${row.cl}, CD=${row.cd}`);
  return {
    id: createId("evidence"),
    projectId: input.project.id,
    category: "experiment_log",
    title: `XFOIL-WASM polar observation: ${summary.airfoil}`,
    summary: `Computed ${summary.rowCount} WebXFOIL polar rows for ${summary.airfoil}. ${previewRows.join("; ")}`,
    quote: previewRows.join("\n"),
    keywords: ["xfoil", "wasm", "polar", "cfd", "aerodynamics", "tool_observation"],
    linkedHypothesisIds: input.hypotheses.map((hypothesis) => hypothesis.id),
    reliabilityScore: 0.76,
    relevanceScore: 0.8,
    evidenceStrength: "medium",
    limitations: [
      "WebXFOIL runs the open-source XFOIL solver compiled to WebAssembly; results still depend on XFOIL convergence, Reynolds/Mach assumptions, and input airfoil geometry.",
      "This is a 2D airfoil solver, not an SU2 field CFD solve.",
      `Runtime license recorded by AetherOps: ${summary.runtimeLicense}.`
    ],
    metadata: {
      traceabilityKind: "tool_observation",
      generatedBy: "EngineeringProgramTool",
      program: "xfoil-wasm",
      runtime: summary.runtime,
      runtimeVersion: summary.runtimeVersion,
      runtimeLicense: summary.runtimeLicense,
      airfoil: summary.airfoil,
      sourceKind: summary.sourceKind,
      sourceUrl: summary.sourceUrl,
      sourceArtifactPath: summary.sourceArtifactPath,
      reynolds: summary.reynolds,
      mach: summary.mach,
      rowCount: summary.rowCount,
      canSupportHypothesis: true,
      sourceQualityTier: "tool_observation"
    },
    createdAt
  };
}

function su2CaseRunArtifact(input: OpenCodeRunInput, summary: Su2CaseRunSummary, createdAt: string): ResearchArtifact {
  const safeName = `su2-${summary.outputFileName}`.replace(/[^A-Za-z0-9._-]+/g, "-");
  return {
    id: createId("artifact"),
    projectId: input.project.id,
    category: "experiment_log",
    title: "SU2 case run",
    relativePath: `artifacts/iteration-${input.iteration}/engineering-program/${safeName}.json`,
    mimeType: "application/json",
    summary: `SU2-compatible command completed with exitCode=${summary.exitCode}.`,
    content: `${JSON.stringify(summary, null, 2)}\n`,
    metadata: {
      traceabilityKind: "tool_observation",
      generatedBy: "EngineeringProgramTool",
      program: "su2",
      canSupportHypothesis: true
    },
    createdAt
  };
}

function scriptedCfdRunArtifact(input: OpenCodeRunInput, summary: ScriptedCfdRunSummary, createdAt: string): ResearchArtifact {
  const safeName = `${summary.target}-${summary.outputFileName}`.replace(/[^A-Za-z0-9._-]+/g, "-");
  return {
    id: createId("artifact"),
    projectId: input.project.id,
    category: "experiment_log",
    title: `${summary.label} CFD analysis run`,
    relativePath: `artifacts/iteration-${input.iteration}/engineering-program/${safeName}.json`,
    mimeType: "application/json",
    summary: `${summary.label} adapter completed with validated CFD spec and exitCode=${summary.exitCode}.`,
    content: `${JSON.stringify(summary, null, 2)}\n`,
    metadata: {
      traceabilityKind: "tool_observation",
      generatedBy: "EngineeringProgramTool",
      program: summary.target,
      canSupportHypothesis: true
    },
    createdAt
  };
}

function scriptedCfdRunEvidence(input: OpenCodeRunInput, summary: ScriptedCfdRunSummary, createdAt: string): EvidenceItem {
  return {
    id: createId("evidence"),
    projectId: input.project.id,
    category: "experiment_log",
    title: `${summary.label} CFD tool observation`,
    summary: summary.outputTextExcerpt || summary.stdoutExcerpt || `${summary.label} adapter completed without captured output text.`,
    quote: summary.outputTextExcerpt || summary.stdoutExcerpt,
    keywords: [summary.target, "cfd", "aerodynamics", "validated_cfd_spec", "tool_observation"],
    linkedHypothesisIds: input.hypotheses.map((hypothesis) => hypothesis.id),
    reliabilityScore: 0.7,
    relevanceScore: 0.74,
    evidenceStrength: "medium",
    limitations: [
      `${summary.label} results depend on the locally configured command, adapter script, validated cfdRunSpec, and solver convergence behavior.`,
      "AetherOps records the run, generated spec, and captured output but does not independently certify CFD convergence."
    ],
    metadata: {
      traceabilityKind: "tool_observation",
      generatedBy: "EngineeringProgramTool",
      program: summary.target,
      command: summary.command,
      scriptPath: summary.scriptPath,
      cfdRunSpec: summary.cfdRunSpec,
      exitCode: summary.exitCode,
      canSupportHypothesis: true,
      sourceQualityTier: "tool_observation"
    },
    createdAt
  };
}

function su2CaseRunEvidence(input: OpenCodeRunInput, summary: Su2CaseRunSummary, createdAt: string): EvidenceItem {
  return {
    id: createId("evidence"),
    projectId: input.project.id,
    category: "experiment_log",
    title: "SU2 tool observation",
    summary: summary.outputTextExcerpt || summary.stdoutExcerpt || "SU2-compatible command completed without captured output text.",
    quote: summary.outputTextExcerpt || summary.stdoutExcerpt,
    keywords: ["su2", "cfd", "case_run", "tool_observation"],
    linkedHypothesisIds: input.hypotheses.map((hypothesis) => hypothesis.id),
    reliabilityScore: 0.7,
    relevanceScore: 0.72,
    evidenceStrength: "medium",
    limitations: [
      "SU2 results depend on the locally configured solver command, case config, mesh, numerical settings, and convergence behavior.",
      "AetherOps records the run and captured output but does not independently validate CFD convergence."
    ],
    metadata: {
      traceabilityKind: "tool_observation",
      generatedBy: "EngineeringProgramTool",
      program: "su2",
      command: summary.command,
      caseRoot: summary.caseRoot,
      configPath: summary.configPath,
      cfdRunSpec: summary.cfdRunSpec,
      exitCode: summary.exitCode,
      canSupportHypothesis: true,
      sourceQualityTier: "tool_observation"
    },
    createdAt
  };
}

function hasConfiguredXfoil(settings: AppSettings): boolean {
  if (!settings.engineeringTools.xfoil.enabled) return false;
  try {
    resolveXfoilCommand(settings);
    return true;
  } catch {
    return false;
  }
}

function hasConfiguredXfoilWasm(settings: AppSettings): boolean {
  return settings.engineeringTools.enabled;
}

function hasConfiguredModelingRoot(settings: AppSettings): boolean {
  if (!settings.engineeringTools.modeling.enabled || !settings.engineeringTools.modeling.artifactRoot?.trim()) return false;
  try {
    const artifactRoot = resolve(settings.engineeringTools.modeling.artifactRoot);
    return existsSync(artifactRoot) && statSync(artifactRoot).isDirectory();
  } catch {
    return false;
  }
}

function hasConfiguredSu2(settings: AppSettings): boolean {
  if (!settings.engineeringTools.su2.enabled) return false;
  try {
    su2Config(settings);
    validateSu2CaseConfig(settings.engineeringTools.su2.caseRoot, settings.engineeringTools.su2.configFile);
    return true;
  } catch {
    return false;
  }
}

function hasConfiguredOpenVsp(settings: AppSettings): boolean {
  if (!settings.engineeringTools.openVsp.enabled) return false;
  try {
    validateScriptedCfdAvailability(scriptedCfdConfig(settings, "openvsp"));
    return true;
  } catch {
    return false;
  }
}

function hasConfiguredXflr5(settings: AppSettings): boolean {
  if (!settings.engineeringTools.xflr5.enabled) return false;
  try {
    validateScriptedCfdAvailability(scriptedCfdConfig(settings, "xflr5"));
    return true;
  } catch {
    return false;
  }
}

function su2Config(settings: AppSettings): Su2Config {
  const config = settings.engineeringTools.su2;
  return {
    ...config,
    command: resolveEngineeringToolCommand(settings.engineeringTools, "su2", config.command).command
  };
}

function scriptedCfdConfig(settings: AppSettings, target: Extract<EngineeringProgramTarget, "openvsp" | "xflr5">): ScriptedCfdConfig {
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

function resolveXfoilCommand(settings: AppSettings): string {
  return resolveEngineeringToolCommand(settings.engineeringTools, "xfoil", settings.engineeringTools.xfoil.command).command;
}

function normalizeTarget(value: unknown): EngineeringProgramTarget | undefined {
  if (
    value === "all" ||
    value === "xfoil" ||
    value === "xfoil-wasm" ||
    value === "modeling" ||
    value === "su2" ||
    value === "openvsp" ||
    value === "xflr5"
  ) return value;
  return undefined;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function boundedNumber(value: number | undefined, min: number, max: number, defaultValue: number, label: string): number {
  const resolved = value ?? defaultValue;
  if (!Number.isFinite(resolved) || resolved < min || resolved > max) {
    throw new Error(`${label} must be between ${min} and ${max}.`);
  }
  return resolved;
}

function boundedPositiveNumber(value: number | undefined, min: number, max: number, defaultValue: number, label: string): number {
  const resolved = boundedNumber(value, min, max, defaultValue, label);
  if (resolved <= 0 && min > 0) {
    throw new Error(`${label} must be positive.`);
  }
  return resolved;
}

function createBounds(): { min: [number, number, number]; max: [number, number, number] } {
  return {
    min: [Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY],
    max: [Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY]
  };
}

function updateBounds(bounds: { min: [number, number, number]; max: [number, number, number] }, point: [number, number, number]): void {
  for (let index = 0; index < 3; index += 1) {
    bounds.min[index] = Math.min(bounds.min[index], point[index]);
    bounds.max[index] = Math.max(bounds.max[index], point[index]);
  }
}

function finalizeBounds(bounds: { min: [number, number, number]; max: [number, number, number] }): MeshSummary["boundingBox"] {
  if (!bounds.min.every(Number.isFinite) || !bounds.max.every(Number.isFinite)) return undefined;
  return { min: bounds.min, max: bounds.max };
}

function toPoint(x: string | undefined, y: string | undefined, z: string | undefined): [number, number, number] | undefined {
  const point: [number, number, number] = [Number(x), Number(y), Number(z)];
  return point.every(Number.isFinite) ? point : undefined;
}

function excerpt(value: string): string {
  return value.replace(/\s+/g, " ").trim().slice(0, 1200);
}

function completedToolRun(input: OpenCodeRunInput, toolName: string, startedAt: string, completedAt: string, toolInput: unknown, output: unknown): ToolRun {
  return {
    id: createId("tool"),
    projectId: input.project.id,
    iteration: input.iteration,
    toolName,
    input: toolInput,
    output,
    status: "completed",
    startedAt,
    completedAt
  };
}

function failedToolRun(input: OpenCodeRunInput, toolName: string, startedAt: string, completedAt: string, toolInput: unknown, output: unknown, error: string): ToolRun {
  return {
    id: createId("tool"),
    projectId: input.project.id,
    iteration: input.iteration,
    toolName,
    input: toolInput,
    output,
    status: "failed",
    error,
    startedAt,
    completedAt
  };
}
